import { hostname } from "node:os";
import { basename } from "node:path";

import type { EnvKey } from "./envFile.ts";
import { INIT_COMMAND, InitError } from "./errors.ts";
import {
  isProjectUuid,
  parsePasted,
  validateApiKey,
  validateProjectUuid,
} from "./input.ts";
import { apiKeysPageUrl, resolveCmdUrl } from "./instance.ts";
import {
  discoverPairing,
  pollOnce,
  realClock,
  startSession,
  waitForApproval,
} from "./pairing.ts";
import type { Clock } from "./pairing.ts";
import {
  clearState,
  loadState,
  pairingStatePath,
  saveState,
} from "./pairingState.ts";
import type { PairingState } from "./pairingState.ts";
import { registerSecret } from "./redact.ts";
import type { Ui } from "./run.ts";
import { generateKeyPair, openSealedKey } from "./sealedBox.ts";
import { smokeTest } from "./smoke.ts";

export type CredentialSource = "pasted" | "provided" | "reused" | "paired";

export interface Credentials {
  projectUuid: string;
  apiKey: string;
  /** Analyses in the project; null when the check after pairing could not reach the api. */
  analyses: number | null;
  source: CredentialSource;
}

export interface CredentialContext {
  ui: Ui;
  root: string;
  apiUrl: string;
  repoEnv: Partial<Record<EnvKey, string>>;
  env: Record<string, string | undefined>;
  /** A project UUID the user already gave or the repo already has. */
  known: string | undefined;
  /** `--project`, when given. */
  project: string | undefined;
  interactive: boolean;
  ci: boolean;
  mode: "pair" | "manual";
  version: string;
  cmdUrl?: string;
  apiKey?: string;
  resume: boolean;
  wait: boolean;
  waitSeconds: number;
  open: boolean;
  agentSlug: string;
  host?: string;
  /** The command that picks a handed-back pairing up again, with this run's flags. */
  resumeCommand: string;
  clock?: Clock;
  fetchImpl?: typeof fetch;
}

const userAgent = (ctx: CredentialContext) => `wopee-init/${ctx.version}`;

export async function acquireCredentials(
  ctx: CredentialContext,
): Promise<Credentials> {
  if (ctx.mode === "manual") return pasted(ctx);
  if (ctx.resume) return paired(ctx);

  const provided = await providedKey(ctx);
  if (provided) return provided;

  const reused = await reusedKey(ctx);
  if (reused) return reused;

  // A CI job has nobody to approve anything: say what to configure instead of waiting.
  if (ctx.ci) {
    throw new InitError(
      "missing_credentials",
      "No Wopee.io credentials in this CI job. Add WOPEE_API_KEY and WOPEE_PROJECT_UUID as secrets (generate a key on your project's API Keys page in Wopee.io Commander). Browser pairing never runs in CI.",
    );
  }
  return paired(ctx);
}

/** `--api-key`, or `WOPEE_API_KEY` from the environment together with a known project. */
async function providedKey(
  ctx: CredentialContext,
): Promise<Credentials | null> {
  const flag = ctx.apiKey?.trim();
  const fromEnv = ctx.env.WOPEE_API_KEY?.trim();
  const apiKey = flag || fromEnv;
  if (!apiKey) return null;
  registerSecret(apiKey);
  if (!ctx.known) {
    // An exported key with no project is not enough to go on; pair instead, unless it was asked for.
    if (!flag && !ctx.ci) return null;
    throw new InitError(
      "missing_credentials",
      `${flag ? "--api-key" : "WOPEE_API_KEY"} needs a project too: pass --project <uuid> or set WOPEE_PROJECT_UUID.`,
    );
  }
  const { analyses } = await ctx.ui.withSpinner(
    `Checking the key with ${ctx.apiUrl}`,
    () =>
      smokeTest(ctx.apiUrl, ctx.known!, apiKey, userAgent(ctx), ctx.fetchImpl),
  );
  return { projectUuid: ctx.known, apiKey, analyses, source: "provided" };
}

/**
 * The key already in the repo's env file, when it still works for the project. Pairing again
 * would only mint a second key for the same thing.
 */
async function reusedKey(ctx: CredentialContext): Promise<Credentials | null> {
  const apiKey = ctx.repoEnv.WOPEE_API_KEY;
  const projectUuid = ctx.repoEnv.WOPEE_PROJECT_UUID;
  if (!apiKey || !isProjectUuid(projectUuid)) return null;
  if (ctx.project && ctx.project !== projectUuid) return null;
  registerSecret(apiKey);
  try {
    const { analyses } = await ctx.ui.withSpinner(
      `Checking the key already in the env file with ${ctx.apiUrl}`,
      () =>
        smokeTest(
          ctx.apiUrl,
          projectUuid,
          apiKey,
          userAgent(ctx),
          ctx.fetchImpl,
        ),
    );
    ctx.ui.info(
      "The env file already has a working key for this project; keeping it.",
    );
    return { projectUuid, apiKey, analyses, source: "reused" };
  } catch (error) {
    if (error instanceof InitError && error.code === "invalid_credentials") {
      ctx.ui.info(
        "The key in the env file no longer works; getting a new one.",
      );
      return null;
    }
    throw error;
  }
}

/** The paste flow: open the API Keys page, ask for both values, check them. */
async function pasted(ctx: CredentialContext): Promise<Credentials> {
  const { ui } = ctx;
  const cmdUrl = resolveCmdUrl(ctx.apiUrl, ctx.cmdUrl);
  const page = apiKeysPageUrl(cmdUrl, ctx.known);
  ui.info(
    ctx.known
      ? "Generate an API key on your project's API Keys page in Wopee.io Commander (project admins):"
      : "Open your project in Wopee.io Commander, then More › Settings › API Keys (project admins). Copy WOPEE_PROJECT_UUID, generate a key and copy WOPEE_API_KEY:",
  );
  ui.link(page);
  if (ctx.open) ui.openUrl(page);

  const projectUuid = parsePasted(
    "WOPEE_PROJECT_UUID",
    await ui.askText({
      message: "Project UUID",
      initialValue: ctx.known,
      validate: validateProjectUuid,
    }),
  );

  let apiKey: string | undefined;
  if (
    ctx.repoEnv.WOPEE_API_KEY &&
    ctx.repoEnv.WOPEE_PROJECT_UUID === projectUuid
  ) {
    registerSecret(ctx.repoEnv.WOPEE_API_KEY);
    if (
      await ui.confirm(
        "Keep the API key that is already in the env file?",
        true,
      )
    ) {
      apiKey = ctx.repoEnv.WOPEE_API_KEY;
    }
  }
  if (!apiKey) {
    apiKey = parsePasted(
      "WOPEE_API_KEY",
      await ui.askSecret({
        message: "API key (input hidden)",
        validate: validateApiKey,
      }),
    );
  }
  registerSecret(apiKey);

  const { analyses } = await ui.withSpinner(
    `Checking the key with ${ctx.apiUrl}`,
    () =>
      smokeTest(ctx.apiUrl, projectUuid, apiKey, userAgent(ctx), ctx.fetchImpl),
  );
  return { projectUuid, apiKey, analyses, source: "pasted" };
}

/** Browser pairing: start (or resume) a session, show the link and words, wait for the answer. */
async function paired(ctx: CredentialContext): Promise<Credentials> {
  const { ui } = ctx;
  const clock = ctx.clock ?? realClock;
  const statePath = pairingStatePath(ctx.root);

  let state: PairingState;
  if (ctx.resume) {
    const saved = loadState(statePath);
    if (!saved) {
      throw new InitError(
        "no_pairing",
        "There is no pairing waiting in this folder. Run the command without --resume to start one.",
        INIT_COMMAND,
      );
    }
    if (saved.apiUrl !== ctx.apiUrl) {
      throw new InitError(
        "no_pairing",
        `The pairing waiting here is for ${saved.apiUrl}, not ${ctx.apiUrl}.`,
        `${INIT_COMMAND} --api-url ${saved.apiUrl} --resume`,
      );
    }
    if (clock.now() >= saved.expiresAt) {
      clearState(statePath);
      throw expired();
    }
    state = saved;
  } else {
    const discovery = await discoverPairing(
      ctx.apiUrl,
      userAgent(ctx),
      ctx.fetchImpl,
    );
    if (!discovery.available) {
      if (ctx.interactive) {
        ui.warn(`${discovery.reason} Using the manual setup instead.`);
        return pasted(ctx);
      }
      throw new InitError(
        "pairing_unavailable",
        `${discovery.reason} Run the manual setup in your own terminal: it asks for the key in a hidden prompt, so the key never passes through an agent.`,
        `${INIT_COMMAND} --manual`,
      );
    }
    const keys = await generateKeyPair();
    const session = await startSession(
      ctx.apiUrl,
      {
        client: `@wopee-io/init ${ctx.version}`,
        agent: ctx.agentSlug,
        host: ctx.host ?? hostname(),
        repoHint: basename(ctx.root) || null,
        publicKey: keys.publicKey,
      },
      userAgent(ctx),
      ctx.fetchImpl,
    );
    state = {
      v: 1,
      apiUrl: ctx.apiUrl,
      sessionId: session.sessionId,
      deviceCode: session.deviceCode,
      userCode: session.userCode,
      verifyUrl: session.verifyUrl,
      expiresAt: clock.now() + session.expiresIn * 1000,
      interval: session.interval,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    };
    // Saved before the link is shown: an agent whose tool is cut off after it still resumes.
    saveState(statePath, state);
  }

  const secondsLeft = () =>
    Math.max(0, Math.round((state.expiresAt - clock.now()) / 1000));
  ui.event?.({
    status: "pairing",
    verification_url: state.verifyUrl,
    user_code: state.userCode,
    expires_in: secondsLeft(),
  });
  ui.info(
    `Approve this setup in Wopee.io Commander. Check that it shows the same words: ${state.userCode}`,
  );
  ui.link(state.verifyUrl);
  if (ctx.interactive && ctx.open) ui.openUrl(state.verifyUrl);

  const handBack = () =>
    new InitError(
      "action_required",
      `Waiting for approval in Wopee.io Commander. Open the link, check that it shows ${state.userCode}, approve, then run the next command.`,
      ctx.resumeCommand,
      {
        reason: "approve_in_commander",
        verification_url: state.verifyUrl,
        user_code: state.userCode,
        expires_in: secondsLeft(),
      },
    );

  if (!ctx.interactive && !ctx.wait) throw handBack();
  if (ctx.interactive) {
    ui.info(
      `Keep this open. If you close it, \`${ctx.resumeCommand}\` carries on.`,
    );
  }

  const deadline = ctx.interactive
    ? state.expiresAt
    : Math.min(state.expiresAt, clock.now() + ctx.waitSeconds * 1000);
  const result = await ui.withSpinner(
    "Waiting for approval in Wopee.io Commander",
    () =>
      waitForApproval({
        poll: () =>
          pollOnce(ctx.apiUrl, state.deviceCode, userAgent(ctx), ctx.fetchImpl),
        interval: state.interval,
        deadline,
        clock,
      }),
  );

  if (result.status === "timeout") {
    if (!ctx.interactive && clock.now() < state.expiresAt) throw handBack();
    clearState(statePath);
    throw expired();
  }
  if (result.status === "denied") {
    clearState(statePath);
    throw new InitError(
      "pairing_denied",
      "The request was denied in Wopee.io Commander. No key was created.",
      INIT_COMMAND,
    );
  }
  if (result.status === "expired") {
    clearState(statePath);
    throw expired();
  }

  let apiKey: string;
  try {
    apiKey = await openSealedKey(result.apiKeyEnc, state);
  } catch {
    clearState(statePath);
    throw new InitError(
      "api_error",
      "The key Wopee.io sent could not be opened with this pairing's key. Run the command again.",
      INIT_COMMAND,
    );
  }
  registerSecret(apiKey);
  clearState(statePath);
  ui.success(
    `Approved for ${result.projectName ? `project ${result.projectName}` : "your project"}.`,
  );

  // The api minted this key a moment ago. If the check cannot reach it now, keep the key rather
  // than lose it: it is handed over once and would otherwise sit unused in Commander.
  let analyses: number | null = null;
  try {
    ({ analyses } = await ui.withSpinner(
      `Checking the key with ${ctx.apiUrl}`,
      () =>
        smokeTest(
          ctx.apiUrl,
          result.projectUuid,
          apiKey,
          userAgent(ctx),
          ctx.fetchImpl,
        ),
    ));
  } catch (error) {
    if (!(error instanceof InitError) || error.code === "invalid_credentials")
      throw error;
    ui.warn(
      `Could not check the new key (${error.message}). Writing it anyway.`,
    );
  }
  return {
    projectUuid: result.projectUuid,
    apiKey,
    analyses,
    source: "paired",
  };
}

function expired(): InitError {
  return new InitError(
    "pairing_expired",
    "The pairing request expired before it was approved (it lasts 10 minutes). Run the command again to start a new one.",
    INIT_COMMAND,
  );
}
