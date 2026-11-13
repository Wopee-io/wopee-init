import { rmSync } from "node:fs";
import { join, relative } from "node:path";

import { AGENTS, agentById } from "./agents/table.ts";
import type { AgentContext, AgentId, AgentTarget } from "./agents/table.ts";
import type { ConfigPlan } from "./agents/plan.ts";
import { planJsonEntry } from "./agents/writeJson.ts";
import { planCodexEntry } from "./agents/writeToml.ts";
import { chooseEnvFile, planEnvFile, readRepoEnv } from "./envFile.ts";
import type { EnvKey } from "./envFile.ts";
import { InitError } from "./errors.ts";
import { readTextIfExists, writeFileAtomic } from "./files.ts";
import { appendIgnore, gitRoot, isIgnored, isTracked } from "./git.ts";
import {
  isProjectUuid,
  parsePasted,
  validateApiKey,
  validateProjectUuid,
} from "./input.ts";
import {
  apiKeysPageUrl,
  DEFAULT_API_URL,
  resolveApiUrl,
  resolveCmdUrl,
} from "./instance.ts";
import { registerSecret } from "./redact.ts";
import { smokeTest } from "./smoke.ts";

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
}

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
}

export interface RunResult {
  projectUuid: string;
  apiUrl: string;
  analyses: number;
  /** Absolute paths of the files written; empty when everything was already set up. */
  written: string[];
}

interface FileChange {
  path: string;
  label: string;
  next: string;
  private?: boolean;
}

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
    ? planJsonEntry(path, text, agent.jsonPath, agent.entry(ctx))
    : planCodexEntry(path, text);
}

export async function run(options: RunOptions, ui: Ui): Promise<RunResult> {
  const gitTop = gitRoot(options.cwd);
  const root = gitTop ?? options.cwd;
  const repoEnv = readRepoEnv(root);

  // 1. Instance and the API Keys page.
  const apiUrl = resolveApiUrl({
    flag: options.apiUrl,
    env: options.env.WOPEE_API_URL,
    envFile: repoEnv.WOPEE_API_URL,
  });
  const cmdUrl = resolveCmdUrl(apiUrl, options.cmdUrl);

  if (options.project !== undefined && validateProjectUuid(options.project)) {
    throw new InitError(
      "usage",
      `--project is not a project UUID: ${options.project}`,
    );
  }
  const known = [
    options.project,
    options.env.WOPEE_PROJECT_UUID,
    repoEnv.WOPEE_PROJECT_UUID,
  ]
    .map((v) => v?.trim())
    .find(isProjectUuid);

  const page = apiKeysPageUrl(cmdUrl, known);
  ui.info(
    known
      ? "Generate an API key on your project's API Keys page in Wopee.io Commander (project admins):"
      : "Open your project in Wopee.io Commander, then More › Settings › API Keys (project admins). Copy WOPEE_PROJECT_UUID, generate a key and copy WOPEE_API_KEY:",
  );
  ui.link(page);
  if (options.open) ui.openUrl(page);

  // 2. The two values. The key is masked and registered for redaction right away.
  const projectUuid = parsePasted(
    "WOPEE_PROJECT_UUID",
    await ui.askText({
      message: "Project UUID",
      initialValue: known,
      validate: validateProjectUuid,
    }),
  );

  let apiKey: string | undefined;
  if (repoEnv.WOPEE_API_KEY && repoEnv.WOPEE_PROJECT_UUID === projectUuid) {
    registerSecret(repoEnv.WOPEE_API_KEY);
    if (
      await ui.confirm(
        "Keep the API key that is already in the env file?",
        true,
      )
    ) {
      apiKey = repoEnv.WOPEE_API_KEY;
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

  // 3. Prove the key works for the project before anything is written.
  const { analyses } = await ui.withSpinner(
    `Checking the key with ${apiUrl}`,
    () =>
      smokeTest(
        apiUrl,
        projectUuid,
        apiKey,
        `wopee-init/${options.version}`,
        options.fetchImpl,
      ),
  );

  // 4. Plan every change.
  const envFile = chooseEnvFile(root);
  const envPath = join(root, envFile);
  const ctx: AgentContext = { root, home: options.home, envFile };
  const show = (path: string) => display(root, options.home, path);

  const desired: Partial<Record<EnvKey, string>> = {
    WOPEE_API_KEY: apiKey,
    WOPEE_PROJECT_UUID: projectUuid,
  };
  if (apiUrl !== DEFAULT_API_URL || repoEnv.WOPEE_API_URL)
    desired.WOPEE_API_URL = apiUrl;
  const envPlan = planEnvFile(root, envFile, desired);
  if (envPlan.conflicts.length) {
    const names = envPlan.conflicts.join(", ");
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
  }

  const changes: FileChange[] = [];
  const gitignorePath = join(root, ".gitignore");
  let gitignoreBefore: string | null = null;
  if (gitTop) {
    if (isTracked(root, envFile)) {
      throw new InitError(
        "unsafe_env_file",
        `${envFile} is tracked by git, so a key written there would be committed. Run \`git rm --cached ${envFile}\`, commit, and run this again. Nothing was written.`,
      );
    }
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
  if (envPlan.changed) {
    changes.push({
      path: envPath,
      label: "Wopee.io credentials",
      next: envPlan.next,
      private: true,
    });
  }

  const detected = AGENTS.filter((a) => a.detect(ctx)).map((a) => a.id);
  const agents = options.agents?.length
    ? selectedAgents(options.agents)
    : selectedAgents(
        await ui.selectAgents(
          AGENTS.map((a) => ({
            value: a.id,
            label: a.name,
            hint: `${show(a.file(ctx))}${detected.includes(a.id) ? ", detected" : ""}`,
          })),
          detected,
        ),
      );

  const configured: AgentTarget[] = [];
  for (const agent of agents) {
    let plan: ConfigPlan;
    try {
      plan = planAgent(agent, ctx);
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      ui.warn(`Skipped ${agent.name}: ${error.message}`);
      continue;
    }
    if (plan.status === "conflict") {
      ui.info(
        `${show(plan.path)} already has a different \`wopee\` server:\n${plan.existing}`,
      );
      const replace = await ui.confirm(
        `Replace it with the key-free \`npx -y wopee-mcp\` entry?`,
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
      });
    }
  }

  // 5. Write: .gitignore first, so the key never lands in a file git would pick up.
  if (changes.length) {
    ui.info(
      `About to write:\n${changes.map((c) => `  • ${show(c.path)} (${c.label})`).join("\n")}`,
    );
    if (!(await ui.confirm("Write these files?", true))) {
      throw new InitError("cancelled", "Nothing was written.");
    }
  }

  const written: string[] = [];
  for (const change of changes) {
    writeFileAtomic(change.path, change.next, { private: change.private });
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

  // 6. Report.
  ui.success(
    `Connected to project ${projectUuid}${apiUrl === DEFAULT_API_URL ? "" : ` on ${apiUrl}`}: ${analyses} ${analyses === 1 ? "analysis" : "analyses"} found.`,
  );
  if (!written.length) ui.info("Already set up: nothing changed.");
  for (const agent of configured)
    ui.info(`${agent.name}: ${agent.restartHint}.`);
  if (configured.length)
    ui.info('Then ask your agent: "Run a Wopee analysis of <your app URL>"');
  else
    ui.info(
      `No agent configured. Run again with --agent <${AGENTS.map((a) => a.id).join("|")}>.`,
    );

  return { projectUuid, apiUrl, analyses, written };
}
