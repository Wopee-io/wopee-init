// Run with: node --test src/pairingRun.test.ts
// Whole runs in pairing mode against a fake api that seals a real key, as the api does.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sodium from "libsodium-wrappers";

import { InitError } from "./errors.ts";
import type { Clock } from "./pairing.ts";
import { pairingStatePath } from "./pairingState.ts";
import { clearSecrets } from "./redact.ts";
import { run } from "./run.ts";
import type { RunOptions, Ui } from "./run.ts";

const API = "https://api.wopee.io";
const UUID = "1f2113a9-0000-4000-8000-000000000001";
const PAIRED_KEY = "paired-key-0123456789abcdef";
const OLD_KEY = "old-key-0123456789abcdef";

let base: string;
let repo: string;
let home: string;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  await sodium.ready;
  base = mkdtempSync(join(tmpdir(), "wopee-init-pair-"));
  repo = join(base, "shop");
  home = join(base, "home");
  mkdirSync(repo);
  mkdirSync(home);
  git("init", "-q");
  clearSecrets();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
  clearSecrets();
});

interface FakeApi {
  fetch: typeof fetch;
  sessions: Record<string, string>[];
  polls: number;
  calls: string[];
}

/**
 * The api: `/cli/info`, `/cli/sessions`, `/cli/sessions/poll` and the GraphQL smoke query. Polls
 * answer `statuses` in turn, repeating the last; `approved` seals PAIRED_KEY to the public key the
 * session was started with. Only a key the api handed out (or `validKeys`) passes the smoke test.
 */
function fakeApi(
  options: {
    statuses?: string[];
    info?: "pairing" | "csrf";
    validKeys?: string[];
    smokeDown?: boolean;
  } = {},
): FakeApi {
  const statuses = options.statuses ?? ["pending", "approved"];
  const valid = new Set([PAIRED_KEY, ...(options.validKeys ?? [])]);
  const api: FakeApi = { sessions: [], polls: 0, calls: [], fetch: undefined! };
  api.fetch = async (url, init) => {
    const path = String(url).slice(API.length) || "/";
    api.calls.push(`${init?.method ?? "GET"} ${path}`);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (path === "/cli/info") {
      return options.info === "csrf"
        ? new Response(
            JSON.stringify({
              errors: [{ message: "blocked as a potential CSRF" }],
            }),
            { status: 400 },
          )
        : new Response(
            JSON.stringify({
              cmdUrl: "https://cmd.wopee.io",
              apiVersion: "5.250.0",
              pairing: true,
            }),
          );
    }
    if (path === "/cli/sessions") {
      api.sessions.push(body);
      return new Response(
        JSON.stringify({
          sessionId: `s-${api.sessions.length}`,
          deviceCode: `d-${api.sessions.length}`,
          userCode: "brave-otter-42",
          verifyUrl: `https://cmd.wopee.io/cli/authorize?session=s-${api.sessions.length}`,
          expiresIn: 600,
          interval: 3,
        }),
        { status: 201 },
      );
    }
    if (path === "/cli/sessions/poll") {
      const status = statuses[Math.min(api.polls++, statuses.length - 1)];
      if (status !== "approved")
        return new Response(JSON.stringify({ status }));
      const publicKey = api.sessions.at(-1)!.publicKey;
      const sealed = sodium.crypto_box_seal(
        sodium.from_string(PAIRED_KEY),
        sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
      );
      return new Response(
        JSON.stringify({
          status: "approved",
          apiKeyEnc: sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL),
          projectUuid: UUID,
          projectName: "Shop",
          apiUrl: API,
        }),
      );
    }
    // The GraphQL smoke query, at the api root.
    if (options.smokeDown) {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code: "ECONNRESET" },
      });
    }
    const headers = init?.headers as Record<string, string>;
    if (valid.has(headers.api_key) && body?.variables?.projectUuid === UUID) {
      return new Response(
        JSON.stringify({ data: { fetchAnalysisSuites: [] } }),
      );
    }
    return new Response(
      JSON.stringify({ errors: [{ message: "Not Authorised!" }] }),
    );
  };
  return api;
}

function fakeClock(): Clock {
  let now = 1_800_000_000_000;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  };
}

interface MachineUi extends Ui {
  events: Record<string, unknown>[];
  text: string[];
}

/** Agent mode: every prompt is a failure, events and text are kept for the assertions. */
function machineUi(): MachineUi {
  const events: Record<string, unknown>[] = [];
  const text: string[] = [];
  const prompt = async (): Promise<never> => {
    throw new Error("agent mode must never prompt");
  };
  return {
    events,
    text,
    info: (m) => text.push(m),
    warn: (m) => text.push(m),
    success: (m) => text.push(m),
    link: (m) => text.push(m),
    openUrl: () => {
      throw new Error("agent mode must not open a browser");
    },
    askText: prompt,
    askSecret: prompt,
    confirm: prompt,
    selectAgents: prompt,
    withSpinner: (_m, task) => task(),
    event: (e) => events.push(e),
  };
}

const options = (
  api: FakeApi,
  extra: Partial<RunOptions> = {},
): RunOptions => ({
  cwd: repo,
  home,
  env: {},
  version: "test",
  open: true,
  fetchImpl: api.fetch,
  mode: "pair",
  interaction: "agent",
  wait: true,
  callingAgent: { slug: "claude-code", id: "claude-code" },
  host: "laptop",
  clock: fakeClock(),
  ...extra,
});

/** What the command line passes when `--no-wait` is not given. */
const DEFAULT_WAIT = { wait: undefined };

const read = (path: string) => readFileSync(path, "utf8");

/** Everything the run printed or emitted, as one string, to look for the key in. */
const everything = (ui: MachineUi) =>
  JSON.stringify(ui.events) + ui.text.join("\n");

async function rejectsWith(
  promise: Promise<unknown>,
  code: string,
): Promise<InitError> {
  let caught: unknown;
  await promise.catch((error) => (caught = error));
  assert.ok(
    caught instanceof InitError,
    `expected InitError ${code}, got ${caught}`,
  );
  assert.equal((caught as InitError).code, code);
  return caught as InitError;
}

// ---------------------------------------------------------------- the main path

test("agent mode pairs, writes .env and the MCP entry, and never shows the key", async () => {
  const api = fakeApi();
  const ui = machineUi();
  const result = await run(options(api), ui);

  assert.equal(result.credentials, "paired");
  assert.equal(
    read(join(repo, ".env")),
    `WOPEE_API_KEY=${PAIRED_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  if (process.platform !== "win32")
    assert.equal(statSync(join(repo, ".env")).mode & 0o777, 0o600);
  assert.equal(git("check-ignore", ".env"), ".env");
  assert.doesNotMatch(read(join(repo, ".mcp.json")), /KEY|key-/);

  // What the session told Commander: who is asking, from where, for which repo.
  const [session] = api.sessions;
  assert.equal(session.client, "@wopee-io/init test");
  assert.equal(session.agent, "claude-code");
  assert.equal(session.host, "laptop");
  assert.equal(session.repoHint, "shop");
  assert.equal(Buffer.from(session.publicKey, "base64").length, 32);

  // The JSON-line contract.
  assert.deepEqual(
    ui.events.map((e) => e.status),
    ["pairing", "success"],
  );
  assert.deepEqual(ui.events[0], {
    status: "pairing",
    verification_url: "https://cmd.wopee.io/cli/authorize?session=s-1",
    user_code: "brave-otter-42",
    expires_in: 600,
  });
  assert.deepEqual(ui.events[1], {
    status: "success",
    project_uuid: UUID,
    api_url: API,
    analyses: 0,
    files: [".gitignore", ".env", ".mcp.json"],
    skipped: [],
    agents: [{ id: "claude-code", restart: result.agents[0].restart }],
    first_prompt: "Run a Wopee analysis of <your app URL>",
  });

  assert.ok(!everything(ui).includes(PAIRED_KEY), "the key was printed");
  assert.equal(
    existsSync(pairingStatePath(repo)),
    false,
    "the state file was left behind",
  );
});

test("agent mode configures the agents it finds plus the one running it", async () => {
  mkdirSync(join(repo, ".vscode"));
  const ui = machineUi();
  const result = await run(options(fakeApi()), ui);
  assert.deepEqual(result.agents.map((a) => a.id).sort(), [
    "claude-code",
    "vscode",
  ]);
  assert.ok(existsSync(join(repo, ".vscode", "mcp.json")));
});

// ---------------------------------------------------------------- handing back and resuming

test("a slow approval hands back with the link, and --resume finishes the same pairing", async () => {
  const api = fakeApi({ statuses: ["pending"] });
  const first = machineUi();
  const error = await rejectsWith(run(options(api), first), "action_required");

  assert.equal(error.exitCode, 75);
  assert.equal(error.next, "npx -y @wopee-io/init@latest --resume");
  assert.equal(error.details?.reason, "approve_in_commander");
  assert.equal(
    error.details?.verification_url,
    "https://cmd.wopee.io/cli/authorize?session=s-1",
  );
  assert.equal(error.details?.user_code, "brave-otter-42");
  // Handed back inside the agent's tool timeout: 90 s of a 600 s session.
  assert.equal(error.details?.expires_in, 510);
  assert.deepEqual(
    first.events.map((e) => e.status),
    ["pairing"],
  );
  assert.ok(existsSync(pairingStatePath(repo)));
  assert.equal(existsSync(join(repo, ".env")), false);

  // The user approves; the agent runs the "next" command.
  const resumed = fakeApi({ statuses: ["approved"] });
  resumed.sessions.push(...api.sessions);
  const second = machineUi();
  const result = await run(options(resumed, { resume: true }), second);

  assert.equal(result.credentials, "paired");
  assert.equal(resumed.sessions.length, 1, "--resume started a second session");
  assert.ok(!resumed.calls.includes("GET /cli/info"));
  assert.match(
    read(join(repo, ".env")),
    new RegExp(`WOPEE_API_KEY=${PAIRED_KEY}`),
  );
  assert.equal(existsSync(pairingStatePath(repo)), false);
  assert.ok(
    !everything(first).includes(PAIRED_KEY) &&
      !everything(second).includes(PAIRED_KEY),
  );
});

test("--no-wait hands back right after the link, without polling", async () => {
  const api = fakeApi();
  await rejectsWith(
    run(options(api, { wait: false }), machineUi()),
    "action_required",
  );
  assert.equal(api.polls, 0);
});

test("an agent's first run hands back with the link at once and writes nothing", async () => {
  const api = fakeApi();
  const ui = machineUi();
  const error = await rejectsWith(
    run(options(api, DEFAULT_WAIT), ui),
    "action_required",
  );

  assert.equal(api.polls, 0);
  assert.equal(error.exitCode, 75);
  assert.match(error.message, /^Show the user the link and brave-otter-42/);
  assert.equal(error.next, "npx -y @wopee-io/init@latest --resume");
  assert.equal(
    error.details?.verification_url,
    "https://cmd.wopee.io/cli/authorize?session=s-1",
  );
  assert.equal(error.details?.user_code, "brave-otter-42");
  assert.equal(error.details?.expires_in, 600);
  assert.deepEqual(
    ui.events.map((e) => e.status),
    ["pairing"],
  );
  assert.ok(existsSync(pairingStatePath(repo)));
  assert.equal(existsSync(join(repo, ".env")), false);
  assert.equal(existsSync(join(repo, ".mcp.json")), false);
});

test("--resume waits for the approval and finishes the first run's pairing", async () => {
  const api = fakeApi({ statuses: ["pending", "approved"] });
  const first = machineUi();
  await rejectsWith(run(options(api, DEFAULT_WAIT), first), "action_required");

  const second = machineUi();
  const result = await run(
    options(api, { ...DEFAULT_WAIT, resume: true }),
    second,
  );

  assert.equal(result.credentials, "paired");
  assert.equal(api.polls, 2);
  assert.equal(api.sessions.length, 1);
  assert.match(
    read(join(repo, ".env")),
    new RegExp(`WOPEE_API_KEY=${PAIRED_KEY}`),
  );
  assert.ok(
    !everything(first).includes(PAIRED_KEY) &&
      !everything(second).includes(PAIRED_KEY),
  );
});

test("a --resume that runs out of time says to wait for the user", async () => {
  const api = fakeApi({ statuses: ["pending"] });
  await rejectsWith(
    run(options(api, DEFAULT_WAIT), machineUi()),
    "action_required",
  );

  const error = await rejectsWith(
    run(options(api, { ...DEFAULT_WAIT, resume: true }), machineUi()),
    "action_required",
  );

  assert.ok(api.polls > 0);
  assert.match(error.message, /^Still waiting for approval/);
  assert.match(error.message, /once they say they have approved/);
  assert.equal(error.next, "npx -y @wopee-io/init@latest --resume");
  assert.equal(error.details?.expires_in, 510);
});

test("--no-wait also makes --resume hand back without polling", async () => {
  const api = fakeApi();
  await rejectsWith(
    run(options(api, DEFAULT_WAIT), machineUi()),
    "action_required",
  );
  await rejectsWith(
    run(options(api, { wait: false, resume: true }), machineUi()),
    "action_required",
  );
  assert.equal(api.polls, 0);
});

test("the command prints the hand-back, with what to do, as JSON on stdout", async () => {
  const api = fakeApi();
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const answer = await api.fetch(`${API}${request.url}`, {
      method: request.method,
      body: chunks.length ? Buffer.concat(chunks).toString() : undefined,
    });
    response.writeHead(answer.status).end(await answer.text());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const apiUrl = `http://127.0.0.1:${port}`;

  try {
    const failure = await promisify(execFile)(
      process.execPath,
      [join(import.meta.dirname, "index.ts"), "--api-url", apiUrl],
      {
        cwd: repo,
        // Nothing inherited: no CI flag, proxy or key from the machine running the tests.
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          HOME: home,
          USERPROFILE: home,
        },
      },
    ).then(
      () => assert.fail("the command should hand back"),
      (error: { code: number; stdout: string }) => error,
    );

    assert.equal(failure.code, 75);
    assert.equal(api.polls, 0);
    const lines = failure.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      lines.map((line) => line.status),
      ["pairing", "action_required"],
    );
    assert.match(lines[1].message, /^Show the user the link/);
    assert.equal(lines[1].user_code, "brave-otter-42");
    assert.equal(
      lines[1].next,
      `npx -y @wopee-io/init@latest --api-url ${apiUrl} --resume`,
    );
  } finally {
    server.close();
  }
});

test("the resume command repeats a non-default api and the chosen agents", async () => {
  const api = fakeApi({ statuses: ["pending"] });
  const devApi: typeof fetch = (url, init) =>
    api.fetch(String(url).replace("https://api.dev.wopee.io", API), init);
  const error = await rejectsWith(
    run(
      options(api, {
        apiUrl: "https://api.dev.wopee.io",
        fetchImpl: devApi,
        agents: ["cursor"],
      }),
      machineUi(),
    ),
    "action_required",
  );
  assert.equal(
    error.next,
    "npx -y @wopee-io/init@latest --api-url https://api.dev.wopee.io --agent cursor --resume",
  );
});

test("the resume command keeps --env-only", async () => {
  const api = fakeApi({ statuses: ["pending"] });
  const error = await rejectsWith(
    run(options(api, { envOnly: true }), machineUi()),
    "action_required",
  );
  assert.equal(error.next, "npx -y @wopee-io/init@latest --env-only --resume");
});

test("--resume with nothing waiting, or for another api, says so", async () => {
  await rejectsWith(
    run(options(fakeApi(), { resume: true }), machineUi()),
    "no_pairing",
  );

  await rejectsWith(
    run(options(fakeApi({ statuses: ["pending"] })), machineUi()),
    "action_required",
  );
  const devApi: typeof fetch = (url, init) =>
    fakeApi().fetch(String(url).replace("https://api.dev.wopee.io", API), init);
  const error = await rejectsWith(
    run(
      options(fakeApi(), {
        resume: true,
        apiUrl: "https://api.dev.wopee.io",
        fetchImpl: devApi,
      }),
      machineUi(),
    ),
    "no_pairing",
  );
  assert.equal(
    error.next,
    `npx -y @wopee-io/init@latest --api-url ${API} --resume`,
  );
});

// ---------------------------------------------------------------- refusals

test("a denied request writes nothing and clears the state", async () => {
  const error = await rejectsWith(
    run(options(fakeApi({ statuses: ["pending", "denied"] })), machineUi()),
    "pairing_denied",
  );
  assert.equal(error.exitCode, 6);
  assert.equal(existsSync(join(repo, ".env")), false);
  assert.equal(existsSync(pairingStatePath(repo)), false);
});

test("an expired request writes nothing and clears the state", async () => {
  await rejectsWith(
    run(options(fakeApi({ statuses: ["expired"] })), machineUi()),
    "pairing_expired",
  );
  assert.equal(existsSync(join(repo, ".env")), false);
  assert.equal(existsSync(pairingStatePath(repo)), false);
});

test("a tracked .env is refused before a session exists, so no key is minted for nothing", async () => {
  writeFileSync(join(repo, ".env"), "OTHER=1\n");
  git("add", ".env");
  const api = fakeApi();
  await rejectsWith(run(options(api), machineUi()), "unsafe_env_file");
  assert.equal(api.sessions.length, 0);
});

// ---------------------------------------------------------------- CI, provided and reused keys

test("CI without credentials fails at once and never starts a pairing", async () => {
  const api = fakeApi();
  const error = await rejectsWith(
    run(options(api, { interaction: "ci" }), machineUi()),
    "missing_credentials",
  );
  assert.equal(error.exitCode, 3);
  assert.match(error.message, /WOPEE_API_KEY and WOPEE_PROJECT_UUID/);
  assert.deepEqual(api.calls, []);
});

test("CI with the secrets set uses them and writes the files", async () => {
  const api = fakeApi({ validKeys: [OLD_KEY] });
  const ui = machineUi();
  const result = await run(
    options(api, {
      interaction: "ci",
      env: { WOPEE_API_KEY: OLD_KEY, WOPEE_PROJECT_UUID: UUID },
    }),
    ui,
  );
  assert.equal(result.credentials, "provided");
  assert.equal(api.sessions.length, 0);
  assert.ok(!everything(ui).includes(OLD_KEY));
});

test("--api-key skips pairing; without a project it says what is missing", async () => {
  // First, while the repo knows no project at all.
  await rejectsWith(
    run(options(fakeApi(), { apiKey: OLD_KEY }), machineUi()),
    "missing_credentials",
  );

  const api = fakeApi({ validKeys: [OLD_KEY] });
  const result = await run(
    options(api, { apiKey: OLD_KEY, project: UUID }),
    machineUi(),
  );
  assert.equal(result.credentials, "provided");
  assert.equal(api.sessions.length, 0);
});

test("a working key already in .env is reused instead of minting another", async () => {
  writeFileSync(
    join(repo, ".env"),
    `WOPEE_API_KEY=${OLD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  const api = fakeApi({ validKeys: [OLD_KEY] });
  const ui = machineUi();
  const result = await run(options(api), ui);
  assert.equal(result.credentials, "reused");
  assert.equal(api.sessions.length, 0);
  assert.ok(!everything(ui).includes(OLD_KEY));
});

test("a dead key in .env is replaced by pairing", async () => {
  writeFileSync(
    join(repo, ".env"),
    `WOPEE_API_KEY=${OLD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  const api = fakeApi(); // OLD_KEY no longer passes
  const result = await run(options(api), machineUi());
  assert.equal(result.credentials, "paired");
  assert.equal(
    read(join(repo, ".env")),
    `WOPEE_API_KEY=${PAIRED_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
});

test("a key the api just minted is kept even when the check after it cannot reach the api", async () => {
  const api = fakeApi({ smokeDown: true });
  const ui = machineUi();
  const result = await run(options(api), ui);
  assert.equal(result.analyses, null);
  assert.match(read(join(repo, ".env")), new RegExp(PAIRED_KEY));
});

// ---------------------------------------------------------------- old instances

test("an api without pairing: agent mode points at --manual in the user's own terminal", async () => {
  const error = await rejectsWith(
    run(options(fakeApi({ info: "csrf" })), machineUi()),
    "pairing_unavailable",
  );
  assert.equal(error.next, "npx -y @wopee-io/init@latest --manual");
});

test("an api without pairing: an interactive run falls back to pasting the key", async () => {
  const api = fakeApi({ info: "csrf", validKeys: [OLD_KEY] });
  const told: string[] = [];
  const ui: Ui = {
    info: (m) => told.push(m),
    warn: (m) => told.push(m),
    success: (m) => told.push(m),
    link: (m) => told.push(m),
    openUrl: () => {},
    askText: async () => UUID,
    askSecret: async () => OLD_KEY,
    confirm: async (_m, initial) => initial,
    selectAgents: async () => ["claude-code"],
    withSpinner: (_m, task) => task(),
  };
  const result = await run(options(api, { interaction: "interactive" }), ui);
  assert.equal(result.credentials, "pasted");
  assert.ok(told.some((m) => /Using the manual setup instead/.test(m)));
  assert.equal(api.sessions.length, 0);
});

// ---------------------------------------------------------------- interactive pairing

test("interactive pairing opens the link and waits the whole session", async () => {
  const api = fakeApi({ statuses: [...Array(50).fill("pending"), "approved"] });
  const opened: string[] = [];
  const ui: Ui = {
    info: () => {},
    warn: () => {},
    success: () => {},
    link: () => {},
    openUrl: (url) => opened.push(url),
    askText: async () => UUID,
    askSecret: async () => OLD_KEY,
    confirm: async (_m, initial) => initial,
    selectAgents: async () => ["claude-code"],
    withSpinner: (_m, task) => task(),
  };
  // 50 pending polls is 150 s: past the agent hand-back, well inside the 10 minutes.
  const result = await run(options(api, { interaction: "interactive" }), ui);
  assert.equal(result.credentials, "paired");
  assert.deepEqual(opened, ["https://cmd.wopee.io/cli/authorize?session=s-1"]);
});

// ---------------------------------------------------------------- what agent mode will not overwrite

test("agent mode leaves a different existing wopee server alone and reports it", async () => {
  const custom = `{"mcpServers":{"wopee":{"command":"node","args":["my-fork.js"]}}}\n`;
  writeFileSync(join(repo, ".mcp.json"), custom);
  const ui = machineUi();
  const result = await run(options(fakeApi()), ui);
  assert.equal(read(join(repo, ".mcp.json")), custom);
  assert.deepEqual(result.skipped, [
    {
      file: ".mcp.json",
      reason: "it already has a different wopee server; left as it is",
    },
  ]);
  assert.ok(existsSync(join(repo, ".env")));
});

test(
  "a config the sandbox will not let us write is skipped, not a crash after .env",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    mkdirSync(join(home, ".codex"));
    chmodSync(join(home, ".codex"), 0o500);
    try {
      const result = await run(
        options(fakeApi(), { agents: ["codex"] }),
        machineUi(),
      );
      assert.equal(result.skipped.length, 1);
      assert.match(result.skipped[0].reason, /EACCES/);
      assert.ok(existsSync(join(repo, ".env")));
    } finally {
      chmodSync(join(home, ".codex"), 0o700);
    }
  },
);

// ---------------------------------------------------------------- --dry-run, --print, --all

test("--dry-run lists the changes and touches nothing, not even the api", async () => {
  const api = fakeApi();
  const ui = machineUi();
  await run(options(api, { dryRun: true }), ui);
  assert.deepEqual(api.calls, []);
  assert.equal(git("status", "--porcelain", "--untracked-files=all"), "");
  assert.deepEqual(ui.events, [
    {
      status: "dry_run",
      changes: [
        { file: ".gitignore", change: "add .env" },
        {
          file: ".env",
          change: "Wopee.io credentials: WOPEE_API_KEY, WOPEE_PROJECT_UUID",
        },
        { file: ".mcp.json", change: "Claude Code MCP server" },
      ],
      skipped: [],
    },
  ]);
});

test("--print gives the snippets and the variable names, never a value, and writes nothing", async () => {
  writeFileSync(
    join(repo, ".env"),
    `WOPEE_API_KEY=${OLD_KEY}\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  const api = fakeApi();
  const ui = machineUi();
  await run(
    options(api, { print: true, agents: ["claude-code", "codex"] }),
    ui,
  );
  assert.deepEqual(api.calls, []);
  const [event] = ui.events;
  assert.equal(event.status, "print");
  assert.deepEqual(event.env, ["WOPEE_API_KEY", "WOPEE_PROJECT_UUID"]);
  const snippets = event.snippets as {
    agent: string;
    file: string;
    snippet: string;
  }[];
  assert.deepEqual(
    snippets.map((s) => s.agent),
    ["claude-code", "codex"],
  );
  assert.match(snippets[1].snippet, /^\[mcp_servers\.wopee\]/);
  assert.ok(!everything(ui).includes(OLD_KEY));
  assert.equal(existsSync(join(repo, ".mcp.json")), false);
});

test("--all configures every supported agent", async () => {
  const result = await run(options(fakeApi(), { all: true }), machineUi());
  assert.deepEqual(
    result.agents.map((a) => a.id),
    ["claude-code", "cursor", "vscode", "opencode", "codex"],
  );
  assert.ok(existsSync(join(home, ".codex", "config.toml")));
});
