#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { parseArgs } from "node:util";
import * as clack from "@clack/prompts";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

import { InitError } from "./errors.ts";
import { redact } from "./redact.ts";
import { run } from "./run.ts";
import type { Ui } from "./run.ts";

const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version: string };

const HELP = `Connect this repository and its AI coding agents to Wopee.io.

Usage: npx -y @wopee-io/init --manual [options]

Opens the API Keys page of your project in Wopee.io Commander, asks for the project UUID and a
new API key, checks them, then writes a git-ignored .env and a key-free \`wopee\` MCP server for
each coding agent you pick.

Options:
  --manual             Paste the values from the API Keys page (the only mode for now)
  --api-url <url>      Wopee.io api (default: WOPEE_API_URL, the repo's .env, https://api.wopee.io)
  --cmd-url <url>      Commander URL, when it is not the api host with api. -> cmd.
  --project <uuid>     Project UUID, to open its API Keys page directly
  --agent <id>         claude-code, cursor, vscode, opencode or codex; repeat for several
  --no-open            Print the link without opening a browser
  -h, --help           Show this help
  -v, --version        Show the version
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

const ui: Ui = {
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

function installProxy(env: NodeJS.ProcessEnv): void {
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
  clack.log.info(`Using proxy ${host}`);
}

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        manual: { type: "boolean", default: false },
        "api-url": { type: "string" },
        "cmd-url": { type: "string" },
        project: { type: "string" },
        agent: { type: "string", multiple: true },
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

  // The key is typed into a masked prompt, never passed through an agent's tool output.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(
      "wopee-init asks for your API key, so run it in your own terminal, not through a coding agent:\n\n  npx -y @wopee-io/init --manual\n",
    );
    return 2;
  }

  clack.intro(`Wopee.io setup · @wopee-io/init ${version}`);
  if (!args.manual) {
    clack.log.info(
      "Browser pairing is not available yet, so this uses --manual.",
    );
  }
  installProxy(process.env);

  try {
    await run(
      {
        cwd: process.cwd(),
        home: homedir(),
        env: process.env,
        version,
        apiUrl: args["api-url"],
        cmdUrl: args["cmd-url"],
        project: args.project,
        agents: args.agent,
        open: !args["no-open"],
      },
      ui,
    );
    clack.outro("Done.");
    return 0;
  } catch (error) {
    if (error instanceof InitError) {
      if (error.code === "cancelled") clack.cancel(redact(error.message));
      else {
        clack.log.error(redact(error.message));
        clack.outro("Setup did not finish.");
      }
      return error.exitCode;
    }
    clack.log.error(
      redact(`Unexpected error: ${(error as Error)?.message ?? String(error)}`),
    );
    clack.outro(
      "Setup did not finish. Nothing secret was printed; report this at https://github.com/Wopee-io/wopee-init/issues",
    );
    return 1;
  }
}

process.exitCode = await main();
