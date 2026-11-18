import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import {
  AGENTS,
  LEGACY_MCP_ARGS,
  MCP_ARGS,
  MCP_COMMAND,
  agentById,
} from "./agents/table.ts";
import type { AgentContext, AgentId, AgentTarget } from "./agents/table.ts";
import type { ConfigPlan } from "./agents/plan.ts";
import { planJsonEntry } from "./agents/writeJson.ts";
import { planCodexEntry } from "./agents/writeToml.ts";
import { acquireCredentials } from "./credentials.ts";
import type { CredentialSource, Credentials } from "./credentials.ts";
import { chooseEnvFile, planEnvFile, readRepoEnv } from "./envFile.ts";
import type { EnvKey } from "./envFile.ts";
import { INIT_COMMAND, InitError } from "./errors.ts";
import { readTextIfExists, writeFileAtomic } from "./files.ts";
import { appendIgnore, gitRoot, isIgnored, isTracked } from "./git.ts";
import { isProjectUuid, validateProjectUuid } from "./input.ts";
import { DEFAULT_API_URL, resolveApiUrl } from "./instance.ts";
import type { Clock } from "./pairing.ts";

export interface Ui {
  info(message: string): void;
  warn(message: string): void;
  success(message: string): void;
  /** A link, on its own line so terminals make it clickable. */
  link(url: string): void;
  openUrl(url: string): void;
  askText(options: {
    message: string;
    initialValue?: string;
    validate: (value: string | undefined) => string | undefined;
  }): Promise<string>;
  askSecret(options: {
    message: string;
    validate: (value: string | undefined) => string | undefined;
  }): Promise<string>;
  confirm(message: string, initialValue: boolean): Promise<boolean>;
  selectAgents(
    options: { value: AgentId; label: string; hint?: string }[],
    initialValues: AgentId[],
  ): Promise<AgentId[]>;
  withSpinner<T>(message: string, task: () => Promise<T>): Promise<T>;
  /** One machine-readable event, printed as a JSON line in agent mode and ignored otherwise. */
  event?(event: Record<string, unknown>): void;
}

/** Who is at the other end: a person at a terminal, a coding agent, or a CI job. */
export type Interaction = "interactive" | "agent" | "ci";

export interface RunOptions {
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  version: string;
  apiUrl?: string;
  cmdUrl?: string;
  project?: string;
  agents?: string[];
  open: boolean;
  fetchImpl?: typeof fetch;
  /** How to get a key when none is at hand: browser pairing, or pasting it. Defaults to "manual". */
  mode?: "pair" | "manual";
  interaction?: Interaction;
  /** `--api-key`: use this key instead of pairing. */
  apiKey?: string;
  /** Pick up a pairing a previous run handed back. */
  resume?: boolean;
  /**
   * Agent mode: whether to wait for the approval once the link is shown. By default only `--resume`
   * waits: an agent's shell tool may hide the output until the call returns, so the first run
   * returns at once and the agent can show the link. `--no-wait` passes false.
   */
  wait?: boolean;
  /** Agent mode: how long to wait for the approval before handing back. */
  waitSeconds?: number;
  dryRun?: boolean;
  print?: boolean;
  /** Configure every supported agent. */
  all?: boolean;
  /** Write only the env file: an agent plugin already brings the MCP server. */
  envOnly?: boolean;
  /** The coding agent running this, when one was detected. */
  callingAgent?: { slug: string; id?: AgentId };
  host?: string;
  clock?: Clock;
}

export interface RunResult {
  /** Null for `--dry-run` and `--print`, which never fetch a key. */
  projectUuid: string | null;
  apiUrl: string;
  analyses: number | null;
  /** Absolute paths of the files written; empty when everything was already set up. */
  written: string[];
  /** The same, relative to the repository (or `~/` for files in the home directory). */
  files: string[];
  skipped: { file: string; reason: string }[];
  agents: { id: AgentId; restart: string }[];
  credentials: CredentialSource | null;
}

interface FileChange {
  path: string;
  label: string;
  /** The whole new text; absent only in a dry run, for the env file whose key is not fetched. */
  next?: string;
  private?: boolean;
  /** An agent's config: a write the system refuses is skipped instead of failing the run. */
  agent?: AgentTarget;
}

/** An agent's own default wait in its shell tool is 120 s; hand back well inside it. */
export const AGENT_WAIT_SECONDS = 90;
const FIRST_PROMPT = "Run a Wopee analysis of <your app URL>";
const WRITE_REFUSED = new Set(["EACCES", "EPERM", "EROFS"]);

const display = (root: string, home: string, path: string) => {
  const rel = relative(root, path);
  if (!rel.startsWith("..")) return rel.replace(/\\/g, "/");
  return `~/${relative(home, path).replace(/\\/g, "/")}`;
};

function selectedAgents(ids: string[]): AgentTarget[] {
  return ids.map((id) => {
    const agent = agentById(id);
    if (!agent) {
      throw new InitError(
        "usage",
        `Unknown agent "${id}". Use one of: ${AGENTS.map((a) => a.id).join(", ")}.`,
      );
    }
    return agent;
  });
}

function planAgent(agent: AgentTarget, ctx: AgentContext): ConfigPlan {
  const path = agent.file(ctx);
  const text = readTextIfExists(path);
  return agent.format === "json"
    ? planJsonEntry(
        path,
        text,
        agent.jsonPath,
        agent.entry(ctx),
        agent.entry(ctx, LEGACY_MCP_ARGS),
      )
    : planCodexEntry(path, text);
}

/** The key-free MCP snippet for one agent, as it would sit in the agent's config file. */
function agentSnippet(agent: AgentTarget, ctx: AgentContext): string {
  if (agent.format === "toml")
    return planCodexEntry(agent.file(ctx), null).next;
  const nested = agent.jsonPath.reduceRight<unknown>(
    (inner, key) => ({ [key]: inner }),
    agent.entry(ctx),
  );
  return `${JSON.stringify(nested, null, 2)}\n`;
}

/**
 * The command a handed-back pairing continues with. It repeats this run's api and agent choices,
 * so the resumed run targets the same instance and configures the same agents.
 */
function resumeCommand(options: RunOptions, apiUrl: string): string {
  const parts = [INIT_COMMAND];
  if (apiUrl !== DEFAULT_API_URL) parts.push(`--api-url ${apiUrl}`);
  for (const agent of options.agents ?? []) parts.push(`--agent ${agent}`);
  if (options.all) parts.push("--all");
  if (options.envOnly) parts.push("--env-only");
  parts.push("--resume");
  return parts.join(" ");
}

export async function run(options: RunOptions, ui: Ui): Promise<RunResult> {
  const interaction = options.interaction ?? "interactive";
  const interactive = interaction === "interactive";
  const gitTop = gitRoot(options.cwd);
  const root = gitTop ?? options.cwd;
  const repoEnv = readRepoEnv(root);

  const apiUrl = resolveApiUrl({
    flag: options.apiUrl,
    env: options.env.WOPEE_API_URL,
    envFile: repoEnv.WOPEE_API_URL,
  });
  if (options.project !== undefined && validateProjectUuid(options.project)) {
    throw new InitError(
      "usage",
      `--project is not a project UUID: ${options.project}`,
    );
  }
  const project = options.project?.trim();
  const known = [
    project,
    options.env.WOPEE_PROJECT_UUID,
    repoEnv.WOPEE_PROJECT_UUID,
  ]
    .map((v) => v?.trim())
    .find(isProjectUuid);

  const envFile = chooseEnvFile(root);
  const envPath = join(root, envFile);
  const ctx: AgentContext = { root, home: options.home, envFile };
  const show = (path: string) => display(root, options.home, path);

  const detected = AGENTS.filter((a) => a.detect(ctx)).map((a) => a.id);
  /** The agents to configure. Interactive runs ask unless `--agent` or `--all` decided it. */
  const chooseAgents = async (): Promise<AgentTarget[]> => {
    if (options.envOnly) return [];
    if (options.agents?.length) return selectedAgents(options.agents);
    if (options.all) return [...AGENTS];
    if (!interactive) {
      const calling = options.callingAgent?.id;
      const ids = new Set<AgentId>(detected);
      if (calling) ids.add(calling);
      return AGENTS.filter((a) => ids.has(a.id));
    }
    return selectedAgents(
      await ui.selectAgents(
        AGENTS.map((a) => ({
          value: a.id,
          label: a.name,
          hint: `${show(a.file(ctx))}${detected.includes(a.id) ? ", detected" : ""}`,
        })),
        detected,
      ),
    );
  };

  // --print: the snippets to paste by hand. No key is fetched, so none can be lost or shown.
  if (options.print) {
    const agents = await chooseAgents();
    const names: EnvKey[] = ["WOPEE_API_KEY", "WOPEE_PROJECT_UUID"];
    if (apiUrl !== DEFAULT_API_URL) names.push("WOPEE_API_URL");
    const snippets = agents.map((a) => ({
      agent: a.id,
      file: show(a.file(ctx)),
      snippet: agentSnippet(a, ctx),
    }));
    ui.info(
      `Put ${names.join(", ")} in a git-ignored ${envFile}: the project UUID and a key from your project's API Keys page in Wopee.io Commander.`,
    );
    for (const s of snippets)
      ui.info(`${s.file} (${agentById(s.agent)!.name}):\n${s.snippet}`);
    ui.event?.({ status: "print", env: names, env_file: envFile, snippets });
    return emptyResult(apiUrl);
  }

  // Preflight: nothing below may mint a key that then cannot be written.
  if (gitTop && isTracked(root, envFile)) {
    throw new InitError(
      "unsafe_env_file",
      `${envFile} is tracked by git, so a key written there would be committed. Run \`git rm --cached ${envFile}\`, commit, and run this again. Nothing was written.`,
    );
  }

  // 1. The credentials. A dry run never fetches a key.
  let creds: Credentials | null = null;
  if (!options.dryRun) {
    creds = await acquireCredentials({
      ui,
      root,
      apiUrl,
      repoEnv,
      env: options.env,
      known,
      project,
      interactive,
      ci: interaction === "ci",
      mode: options.mode ?? "manual",
      version: options.version,
      cmdUrl: options.cmdUrl,
      apiKey: options.apiKey,
      resume: !!options.resume,
      wait: options.wait ?? !!options.resume,
      waitSeconds: options.waitSeconds ?? AGENT_WAIT_SECONDS,
      open: options.open,
      agentSlug: options.callingAgent?.slug ?? "terminal",
      host: options.host,
      resumeCommand: resumeCommand(options, apiUrl),
      clock: options.clock,
      fetchImpl: options.fetchImpl,
    });
  }

  // 2. Plan every change.
  const changes: FileChange[] = [];
  const skipped: RunResult["skipped"] = [];
  const gitignorePath = join(root, ".gitignore");
  let gitignoreBefore: string | null = null;
  if (gitTop) {
    if (!isIgnored(root, envFile)) {
      gitignoreBefore = readTextIfExists(gitignorePath);
      changes.push({
        path: gitignorePath,
        label: `add ${envFile}`,
        next: appendIgnore(gitignoreBefore, envFile),
      });
    }
  } else {
    ui.warn(
      `This folder is not a git repository. Make sure ${envFile} is never committed.`,
    );
  }

  const withUrl = apiUrl !== DEFAULT_API_URL || !!repoEnv.WOPEE_API_URL;
  if (creds) {
    const desired: Partial<Record<EnvKey, string>> = {
      WOPEE_API_KEY: creds.apiKey,
      WOPEE_PROJECT_UUID: creds.projectUuid,
    };
    if (withUrl) desired.WOPEE_API_URL = apiUrl;
    const envPlan = planEnvFile(root, envFile, desired);
    if (envPlan.conflicts.length) {
      const names = envPlan.conflicts.join(", ");
      if (interactive) {
        if (
          !(await ui.confirm(
            `${envFile} already has a different ${names}. Replace it?`,
            false,
          ))
        ) {
          throw new InitError(
            "conflict",
            `Kept ${envFile} as it is. Nothing was written.`,
          );
        }
      } else {
        // The old value failed the reuse check, or --project asked for another project.
        ui.info(`Replacing ${names} in ${envFile}.`);
      }
    }
    if (envPlan.changed) {
      changes.push({
        path: envPath,
        label: "Wopee.io credentials",
        next: envPlan.next,
        private: true,
      });
    }
  } else {
    changes.push({
      path: envPath,
      label: `Wopee.io credentials: ${["WOPEE_API_KEY", "WOPEE_PROJECT_UUID", ...(withUrl ? ["WOPEE_API_URL"] : [])].join(", ")}`,
    });
  }

  const agents = await chooseAgents();
  const configured: AgentTarget[] = [];
  for (const agent of agents) {
    let plan: ConfigPlan;
    try {
      plan = planAgent(agent, ctx);
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      ui.warn(`Skipped ${agent.name}: ${error.message}`);
      skipped.push({ file: show(agent.file(ctx)), reason: error.message });
      continue;
    }
    if (plan.status === "conflict") {
      if (!interactive) {
        // Someone set this server up on purpose; an agent run does not overwrite it.
        ui.warn(`Kept the different \`wopee\` server in ${show(plan.path)}.`);
        skipped.push({
          file: show(plan.path),
          reason: "it already has a different wopee server; left as it is",
        });
        continue;
      }
      ui.info(
        `${show(plan.path)} already has a different \`wopee\` server:\n${plan.existing}`,
      );
      const replace = await ui.confirm(
        `Replace it with the key-free \`${[MCP_COMMAND, ...MCP_ARGS].join(" ")}\` entry?`,
        false,
      );
      if (!replace) {
        ui.warn(`Kept the existing ${agent.name} entry.`);
        continue;
      }
    }
    configured.push(agent);
    if (plan.status !== "same") {
      changes.push({
        path: plan.path,
        label: `${agent.name} MCP server`,
        next: plan.next,
        agent,
      });
    }
  }

  // --dry-run: say what would change and stop.
  if (options.dryRun) {
    const listed = changes.map((c) => ({
      file: show(c.path),
      change: c.label,
    }));
    ui.info(
      listed.length
        ? `Would write:\n${listed.map((c) => `  • ${c.file} (${c.change})`).join("\n")}`
        : "Nothing would change.",
    );
    ui.event?.({ status: "dry_run", changes: listed, skipped });
    return { ...emptyResult(apiUrl), skipped };
  }

  // 3. Write: .gitignore first, so the key never lands in a file git would pick up.
  if (changes.length && interactive) {
    ui.info(
      `About to write:\n${changes.map((c) => `  • ${show(c.path)} (${c.label})`).join("\n")}`,
    );
    if (!(await ui.confirm("Write these files?", true))) {
      throw new InitError("cancelled", "Nothing was written.");
    }
  }

  const written: string[] = [];
  for (const change of changes) {
    try {
      writeFileAtomic(change.path, change.next!, { private: change.private });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!change.agent || !code || !WRITE_REFUSED.has(code)) throw error;
      // A sandboxed agent may not write outside the workspace (Codex's config lives in ~).
      ui.warn(
        `Could not write ${show(change.path)} (${code}); skipped ${change.agent.name}.`,
      );
      skipped.push({
        file: show(change.path),
        reason: `not allowed to write it (${code})`,
      });
      configured.splice(configured.indexOf(change.agent), 1);
      continue;
    }
    written.push(change.path);
    if (change.path === gitignorePath && !isIgnored(root, envFile)) {
      // A later rule (e.g. `!.env`) wins over ours: undo and stop before the key is written.
      if (gitignoreBefore === null) rmSync(gitignorePath);
      else writeFileAtomic(gitignorePath, gitignoreBefore);
      throw new InitError(
        "unsafe_env_file",
        `.gitignore still does not ignore ${envFile} (a later rule re-includes it). Fix .gitignore and run this again. Nothing was written.`,
      );
    }
  }

  // 4. Report.
  const { projectUuid, analyses } = creds!;
  const where = apiUrl === DEFAULT_API_URL ? "" : ` on ${apiUrl}`;
  ui.success(
    analyses === null
      ? `Connected to project ${projectUuid}${where}.`
      : `Connected to project ${projectUuid}${where}: ${analyses} ${analyses === 1 ? "analysis" : "analyses"} found.`,
  );
  if (!written.length) ui.info("Already set up: nothing changed.");
  for (const agent of configured)
    ui.info(`${agent.name}: ${agent.restartHint}.`);
  // With --env-only the agent's plugin provides the server, so the setup is complete.
  const ready = configured.length > 0 || Boolean(options.envOnly);
  if (options.envOnly)
    ui.info(
      "The Wopee.io plugin's server reads the key on its next call: no restart needed.",
    );
  if (ready) ui.info(`Then ask your agent: "${FIRST_PROMPT}"`);
  else
    ui.info(
      `No agent configured. Run again with --agent <${AGENTS.map((a) => a.id).join("|")}>.`,
    );

  const result: RunResult = {
    projectUuid,
    apiUrl,
    analyses,
    written,
    files: written.map(show),
    skipped,
    agents: configured.map((a) => ({ id: a.id, restart: a.restartHint })),
    credentials: creds!.source,
  };
  ui.event?.({
    status: "success",
    project_uuid: projectUuid,
    api_url: apiUrl,
    analyses,
    files: result.files,
    skipped,
    agents: result.agents,
    first_prompt: ready ? FIRST_PROMPT : null,
  });
  return result;
}

function emptyResult(apiUrl: string): RunResult {
  return {
    projectUuid: null,
    apiUrl,
    analyses: null,
    written: [],
    files: [],
    skipped: [],
    agents: [],
    credentials: null,
  };
}
