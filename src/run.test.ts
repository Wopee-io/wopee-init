// Run with: node --test src/run.test.ts
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeCodeEntry } from "./agents/table.ts";
import type { AgentId } from "./agents/table.ts";
import { InitError } from "./errors.ts";
import { clearSecrets, redact } from "./redact.ts";
import { run } from "./run.ts";
import type { RunOptions, Ui } from "./run.ts";

const UUID = "1f2113a9-0000-4000-8000-000000000001";
const GOOD_KEY = "good-key-0123456789abcdef";
const WRONG_KEY = "wrong-key-0123456789abcdef";

let base: string;
let repo: string;
let home: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wopee-init-"));
  repo = join(base, "repo");
  home = join(base, "home");
  mkdirSync(repo);
  mkdirSync(join(home, ".codex"), { recursive: true });
  git("init", "-q");
  mkdirSync(join(repo, ".claude"));
  mkdirSync(join(repo, ".vscode"));
  clearSecrets();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearSecrets();
});

// The api: only GOOD_KEY for UUID passes.
const fakeApi: typeof fetch = async (_url, init) => {
  const headers = init?.headers as Record<string, string>;
  const { variables } = JSON.parse(String(init?.body));
  if (headers.api_key === GOOD_KEY && variables.projectUuid === UUID) {
    return new Response(
      JSON.stringify({ data: { fetchAnalysisSuites: [{ uuid: "s1" }] } }),
    );
  }
  return new Response(
    JSON.stringify({ errors: [{ message: "Not Authorised!" }] }),
  );
};

interface FakeUi extends Ui {
  output: string[];
  opened: string[];
}

function fakeUi(answers: {
  uuid?: string;
  key?: string;
  agents?: AgentId[];
  confirm?: (message: string) => boolean;
}): FakeUi {
  const output: string[] = [];
  const opened: string[] = [];
  // Everything the real UI prints goes through redact(); the test checks the raw text too.
  const say = (message: string) => output.push(message);
  return {
    output,
    opened,
    info: say,
    warn: say,
    success: say,
    link: say,
    openUrl: (url) => opened.push(url),
    askText: async ({ initialValue, validate }) => {
      const value = answers.uuid ?? initialValue ?? "";
      assert.equal(validate(value), undefined);
      return value;
    },
    askSecret: async ({ validate }) => {
      const value = answers.key ?? GOOD_KEY;
      assert.equal(validate(value), undefined);
      return value;
    },
    confirm: async (message, initial) => answers.confirm?.(message) ?? initial,
    selectAgents: async (_options, initial) => answers.agents ?? initial,
    withSpinner: async (message, task) => {
      say(message);
      return task();
    },
  };
}

const options = (extra: Partial<RunOptions> = {}): RunOptions => ({
  cwd: repo,
  home,
  env: {},
  version: "test",
  open: true,
  fetchImpl: fakeApi,
  ...extra,
});

const read = (path: string) => readFileSync(path, "utf8");

/** Every file under the temp dir, except the env file and .git, as text. */
function otherFiles(dir = base): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.name === ".git" || entry.name === ".env") return [];
    return entry.isDirectory() ? otherFiles(path) : [read(path)];
  });
}

test("fresh repo: opens the start page, writes a git-ignored .env and key-free MCP entries", async () => {
  const ui = fakeUi({ uuid: UUID });
  const result = await run(options(), ui);

  assert.deepEqual(ui.opened, ["https://cmd.wopee.io/"]);
  assert.equal(result.analyses, 1);
  assert.equal(
    read(join(repo, ".env")),
    `WOPEE_API_KEY=${GOOD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  assert.equal(git("check-ignore", ".env"), ".env");
  if (process.platform !== "win32")
    assert.equal(statSync(join(repo, ".env")).mode & 0o777, 0o600);

  assert.deepEqual(JSON.parse(read(join(repo, ".mcp.json"))), {
    mcpServers: { wopee: claudeCodeEntry() },
  });
  assert.deepEqual(
    JSON.parse(read(join(repo, ".vscode", "mcp.json"))).servers.wopee,
    {
      type: "stdio",
      command: "npx",
      args: ["-y", "wopee-mcp"],
      envFile: "${workspaceFolder}/.env",
    },
  );
  assert.match(
    read(join(home, ".codex", "config.toml")),
    /^\[mcp_servers\.wopee\]\ncommand = "npx"/,
  );
  assert.equal(
    existsSync(join(repo, ".cursor")),
    false,
    "Cursor was not detected",
  );

  // The key is only in .env: not in any MCP config, .gitignore or output.
  for (const text of [...otherFiles(), ...ui.output])
    assert.doesNotMatch(text, new RegExp(GOOD_KEY));
  assert.doesNotMatch(git("status", "--porcelain"), /\.env\b(?!\.)/);
});

test("re-running with the same values changes nothing", async () => {
  await run(options(), fakeUi({ uuid: UUID }));
  const before = otherFiles().concat(read(join(repo, ".env")));

  const ui = fakeUi({});
  const result = await run(options(), ui);
  assert.deepEqual(result.written, []);
  assert.deepEqual(ui.opened, [
    `https://cmd.wopee.io/tests?projectId=${UUID}&settings=api_keys`,
  ]);
  assert.ok(ui.output.includes("Already set up: nothing changed."));
  assert.deepEqual(otherFiles().concat(read(join(repo, ".env"))), before);
});

test("a wrong key fails the smoke test and writes nothing", async () => {
  const ui = fakeUi({ uuid: UUID, key: WRONG_KEY });
  await assert.rejects(
    run(options(), ui),
    (e) => e instanceof InitError && e.code === "invalid_credentials",
  );
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(existsSync(join(home, ".codex", "config.toml")), false);
  for (const text of ui.output)
    assert.doesNotMatch(text, new RegExp(WRONG_KEY));
});

test("other MCP servers and .env lines are kept", async () => {
  writeFileSync(
    join(repo, ".mcp.json"),
    '{\n  "mcpServers": {\n    "github": { "command": "gh" }\n  }\n}\n',
  );
  writeFileSync(join(repo, ".env"), "DATABASE_URL=postgres://x\n");
  writeFileSync(join(repo, ".gitignore"), "node_modules\n.env\n");

  const result = await run(
    options(),
    fakeUi({ uuid: UUID, agents: ["claude-code"] }),
  );
  assert.deepEqual(JSON.parse(read(join(repo, ".mcp.json"))).mcpServers, {
    github: { command: "gh" },
    wopee: claudeCodeEntry(),
  });
  assert.equal(
    read(join(repo, ".env")),
    `DATABASE_URL=postgres://x\nWOPEE_API_KEY=${GOOD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  assert.equal(
    read(join(repo, ".gitignore")),
    "node_modules\n.env\n",
    "already ignored",
  );
  assert.equal(result.written.length, 2);
});

test("a tracked .env is refused before anything is written", async () => {
  writeFileSync(join(repo, ".env"), "PORT=3000\n");
  git("add", ".env");
  await assert.rejects(
    run(options(), fakeUi({ uuid: UUID })),
    (e) => e instanceof InitError && e.code === "unsafe_env_file",
  );
  assert.equal(read(join(repo, ".env")), "PORT=3000\n");
  assert.equal(existsSync(join(repo, ".mcp.json")), false);
});

test("a .gitignore that re-includes .env gets the rule appended after it", async () => {
  writeFileSync(join(repo, ".gitignore"), "node_modules\n!.env\n");
  await run(options(), fakeUi({ uuid: UUID, agents: [] }));
  assert.equal(git("check-ignore", ".env"), ".env");
  assert.equal(
    read(join(repo, ".gitignore")),
    "node_modules\n!.env\n\n# Wopee.io credentials\n.env\n",
  );
});

test("a different existing value is replaced only after a yes", async () => {
  const other = "2f2113a9-0000-4000-8000-000000000002";
  writeFileSync(join(repo, ".env"), `WOPEE_PROJECT_UUID=${other}\n`);
  writeFileSync(join(repo, ".gitignore"), ".env\n");

  await assert.rejects(
    run(
      options(),
      fakeUi({
        uuid: UUID,
        confirm: (m) => !/already has a different/.test(m),
      }),
    ),
    (e) => e instanceof InitError && e.code === "conflict",
  );
  assert.equal(read(join(repo, ".env")), `WOPEE_PROJECT_UUID=${other}\n`);

  await run(options(), fakeUi({ uuid: UUID, agents: [], confirm: () => true }));
  assert.match(
    read(join(repo, ".env")),
    new RegExp(`WOPEE_PROJECT_UUID=${UUID}`),
  );
});

test("dev instance: deep link on cmd.dev and WOPEE_API_URL in .env; .env.local preferred", async () => {
  writeFileSync(join(repo, ".env.local"), "");
  writeFileSync(join(repo, ".gitignore"), ".env*\n");
  const ui = fakeUi({ agents: ["vscode"] });
  await run(
    options({ apiUrl: "https://api.dev.wopee.io/", project: UUID }),
    ui,
  );

  assert.deepEqual(ui.opened, [
    `https://cmd.dev.wopee.io/tests?projectId=${UUID}&settings=api_keys`,
  ]);
  assert.equal(
    read(join(repo, ".env.local")),
    `WOPEE_API_KEY=${GOOD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\nWOPEE_API_URL=https://api.dev.wopee.io\n`,
  );
  assert.equal(existsSync(join(repo, ".env")), false);
  assert.equal(
    JSON.parse(read(join(repo, ".vscode", "mcp.json"))).servers.wopee.envFile,
    "${workspaceFolder}/.env.local",
  );
});

test("an existing wopee entry with env references is kept unless the user says yes", async () => {
  const old = {
    command: "npx",
    args: ["-y", "wopee-mcp"],
    env: { WOPEE_API_KEY: "${WOPEE_API_KEY}" },
  };
  writeFileSync(
    join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { wopee: old } }),
  );
  const ui = fakeUi({
    uuid: UUID,
    agents: ["claude-code"],
    confirm: (m) => !/Replace it with/.test(m),
  });
  await run(options(), ui);
  assert.deepEqual(
    JSON.parse(read(join(repo, ".mcp.json"))).mcpServers.wopee,
    old,
  );
});

test("redaction covers the key the user typed", async () => {
  const ui = fakeUi({ uuid: UUID });
  await run(options(), ui);
  assert.equal(redact(`x ${GOOD_KEY} y`), "x ******** y");
});
