#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import { determineAgent } from "@vercel/detect-agent";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import { callingAgentFromName } from "./callingAgent.ts";
import { InitError } from "./errors.ts";
import { redact } from "./redact.ts";
import { run } from "./run.ts";
import type { Interaction, RunOptions, Ui } from "./run.ts";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const HELP = `Connect this repository and its AI coding agents to Wopee.io.

Usage: npx -y @wopee-io/init [options]

Prints a link and pairing words. You approve in Wopee.io Commander, and a new, named project API
key comes back encrypted to this process: nobody copies it, and it never passes through a coding
agent's chat. Then it writes a git-ignored .env and a key-free \`wopee\` MCP server for your agents.

A coding agent can run this itself: it never prompts and prints one JSON line per step on stdout
(text goes to stderr). The first run prints the link and {"status":"action_required",…}, then exits
75 so the agent can show the link. The "next" command it gives (with --resume) waits ~90 s for the
approval and finishes the setup.

Options:
  --resume             Continue a pairing an earlier run handed back, waiting for the approval
  --no-wait            With --resume: hand back right after printing the link, without waiting
  --manual             Paste the project UUID and a key from the API Keys page instead of pairing
  --api-url <url>      Wopee.io api (default: WOPEE_API_URL, the repo's .env, https://api.wopee.io)
  --cmd-url <url>      Commander URL for --manual, when it is not the api host with api. -> cmd.
  --project <uuid>     The project, when the key comes from WOPEE_API_KEY or --api-key
  --api-key <key>      Use this key instead of pairing (prefer the WOPEE_API_KEY variable: a flag
                       ends up in your shell history)
  --agent <id>         claude-code, cursor, vscode, opencode or codex; repeat for several
  --all                Configure every supported agent
  --env-only           Write only the env file, no MCP config (the Wopee.io agent plugin brings
                       the server)
  --print              Print the MCP snippets instead of writing anything
  --dry-run            Show what would change without writing anything or fetching a key
  --no-open            Print the link without opening a browser
  -h, --help           Show this help
  -v, --version        Show the version

In CI it never pairs: set WOPEE_API_KEY and WOPEE_PROJECT_UUID as secrets.

Exit codes: 0 done, 2 usage, 3 credentials, 4 network or instance, 5 unsafe or conflicting file,
6 pairing denied or expired, 75 waiting for your approval, 130 cancelled.
`;

function openUrl(url: string): void {
  const [command, args] =
    process.platform === "win32"
      ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // The link is printed as well.
  }
}

async function answer<T>(value: Promise<T>): Promise<Exclude<T, symbol>> {
  const result = await value;
  if (clack.isCancel(result))
    throw new InitError("cancelled", "Cancelled. Nothing was written.");
  return result as Exclude<T, symbol>;
}

const interactiveUi: Ui = {
  info: (message) => clack.log.info(redact(message)),
  warn: (message) => clack.log.warn(redact(message)),
  success: (message) => clack.log.success(redact(message)),
  link: (url) => clack.log.message(url),
  openUrl,
  askText: ({ message, initialValue, validate }) =>
    answer(clack.text({ message, initialValue, validate })),
  askSecret: ({ message, validate }) =>
    answer(clack.password({ message, validate })),
  confirm: (message, initialValue) =>
    answer(clack.confirm({ message, initialValue })),
  selectAgents: (options, initialValues) =>
    answer(
      clack.multiselect({
        message:
          "Add the Wopee.io MCP server to (space to toggle, enter to confirm)",
        options,
        initialValues,
        required: false,
      }),
    ),
  withSpinner: async (message, task) => {
    const spin = clack.spinner();
    spin.start(message);
    try {
      const result = await task();
      spin.stop(message);
      return result;
    } catch (error) {
      spin.error(message);
      throw error;
    }
  },
};

/** Writes one JSON object per line to stdout. Every line is redacted, like every printed word. */
function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${redact(JSON.stringify(event))}\n`);
}

const say = (message: string) => process.stderr.write(`${redact(message)}\n`);

function noPrompt(): never {
  throw new InitError(
    "no_tty",
    "This step needs an answer, and there is no terminal to ask in. Run it in your own terminal.",
  );
}

/** Agent and CI mode: events on stdout for the agent to parse, text on stderr, never a prompt. */
const machineUi: Ui = {
  info: say,
  warn: (message) => say(`Warning: ${message}`),
  success: say,
  link: say,
  // A browser window an agent opened unasked is surprising; the link is in the output.
  openUrl: () => {},
  askText: async () => noPrompt(),
  askSecret: async () => noPrompt(),
  confirm: async () => noPrompt(),
  selectAgents: async () => noPrompt(),
  withSpinner: (_message, task) => task(),
  event: emit,
};

function installProxy(
  env: NodeJS.ProcessEnv,
  log: (message: string) => void,
): void {
  const proxy =
    env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return;
  // Honours NO_PROXY as well. Only the host is shown: the URL may carry proxy credentials.
  setGlobalDispatcher(new EnvHttpProxyAgent());
  let host = "the configured proxy";
  try {
    host = new URL(proxy).host;
  } catch {
    // Keep the generic name.
  }
  log(`Using proxy ${host}`);
}

const isCi = (env: NodeJS.ProcessEnv) =>
  !!env.CI && !["false", "0"].includes(env.CI.toLowerCase());

function report(error: unknown, interaction: Interaction): number {
  const machine = interaction !== "interactive";
  if (error instanceof InitError) {
    if (machine) {
      if (error.code === "action_required") {
        say(error.message);
        emit({
          status: "action_required",
          message: error.message,
          ...error.details,
          next: error.next,
        });
      } else {
        say(error.message);
        emit({
          status: "error",
          code: error.code,
          message: error.message,
          ...(error.next ? { next: error.next } : {}),
        });
      }
    } else if (error.code === "cancelled") {
      clack.cancel(redact(error.message));
    } else {
      clack.log.error(redact(error.message));
      if (error.next) clack.log.info(`Next: ${error.next}`);
      clack.outro("Setup did not finish.");
    }
    return error.exitCode;
  }
  const message = `Unexpected error: ${(error as Error)?.message ?? String(error)}`;
  if (machine) {
    say(message);
    emit({ status: "error", code: "unexpected", message });
  } else {
    clack.log.error(redact(message));
    clack.outro(
      "Setup did not finish. Nothing secret was printed; report this at https://github.com/Wopee-io/wopee-init/issues",
    );
  }
  return 1;
}

async function main(): Promise<number> {
  const tty = !!(process.stdin.isTTY && process.stdout.isTTY);
  const detected = await determineAgent().catch(() => ({
    isAgent: false as const,
    agent: undefined,
  }));
  const interaction: Interaction = detected.isAgent
    ? "agent"
    : isCi(process.env)
      ? "ci"
      : tty
        ? "interactive"
        : "agent";

  let args;
  try {
    args = parseArgs({
      options: {
        manual: { type: "boolean", default: false },
        resume: { type: "boolean", default: false },
        "no-wait": { type: "boolean", default: false },
        "api-url": { type: "string" },
        "cmd-url": { type: "string" },
        project: { type: "string" },
        "api-key": { type: "string" },
        agent: { type: "string", multiple: true },
        all: { type: "boolean", default: false },
        "env-only": { type: "boolean", default: false },
        print: { type: "boolean", default: false },
        "dry-run": { type: "boolean", default: false },
        "no-open": { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
      strict: true,
    }).values;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    process.stdout.write(`${version}\n`);
    return 0;
  }

  try {
    const clash = (a: string, b: string) => {
      throw new InitError("usage", `${a} and ${b} cannot be used together.`);
    };
    if (args.manual && args.resume) clash("--manual", "--resume");
    if (args.manual && args["api-key"]) clash("--manual", "--api-key");
    if (args["env-only"]) {
      if (args.agent?.length) clash("--env-only", "--agent");
      if (args.all) clash("--env-only", "--all");
      if (args.print) clash("--env-only", "--print");
    }
    if ((args.print || args["dry-run"]) && args.resume)
      clash(args.print ? "--print" : "--dry-run", "--resume");

    // --manual types the key into a masked prompt, which needs a terminal.
    if (args.manual && !tty) {
      throw new InitError(
        "no_tty",
        "--manual asks for your API key in a hidden prompt, so run it in your own terminal, not through a coding agent. From an agent, run it without --manual to pair through the browser.",
      );
    }

    const interactive = interaction === "interactive";
    if (interactive) clack.intro(`Wopee.io setup · @wopee-io/init ${version}`);
    installProxy(process.env, interactive ? (m) => clack.log.info(m) : say);

    const options: RunOptions = {
      cwd: process.cwd(),
      home: homedir(),
      env: process.env,
      version,
      apiUrl: args["api-url"],
      cmdUrl: args["cmd-url"],
      project: args.project,
      agents: args.agent,
      open: !args["no-open"],
      mode: args.manual ? "manual" : "pair",
      interaction,
      apiKey: args["api-key"],
      resume: args.resume,
      wait: args["no-wait"] ? false : undefined,
      dryRun: args["dry-run"],
      print: args.print,
      all: args.all,
      envOnly: args["env-only"],
      callingAgent: callingAgentFromName(
        detected.isAgent ? detected.agent.name : undefined,
      ),
    };
    await run(options, interactive ? interactiveUi : machineUi);
    if (interactive) clack.outro("Done.");
    return 0;
  } catch (error) {
    return report(error, interaction);
  }
}

// exitCode, not exit(): stdout is a pipe under an agent, and exit() could drop the last JSON line.
process.exitCode = await main();
