// Run with: node --test src/pairing.test.ts
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sodium from "libsodium-wrappers";

import { callingAgentFromName } from "./callingAgent.ts";
import { InitError } from "./errors.ts";
import {
  discoverPairing,
  pollOnce,
  startSession,
  waitForApproval,
} from "./pairing.ts";
import type { Clock, PollResult } from "./pairing.ts";
import {
  clearState,
  loadState,
  pairingStatePath,
  saveState,
} from "./pairingState.ts";
import type { PairingState } from "./pairingState.ts";
import { generateKeyPair, openSealedKey } from "./sealedBox.ts";

const API = "https://api.example.test";
const UA = "wopee-init/test";

const respond =
  (
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): typeof fetch =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers,
    });

// ---------------------------------------------------------------- discovery

test("discovery: a 2xx with pairing true and a Commander URL means pair", async () => {
  const result = await discoverPairing(
    API,
    UA,
    respond(200, {
      cmdUrl: "https://cmd.example.test/",
      apiVersion: "5.250.0",
      pairing: true,
    }),
  );
  assert.deepEqual(result, {
    available: true,
    cmdUrl: "https://cmd.example.test",
  });
});

test("discovery: an api without the routes answers 400 from its GraphQL CSRF guard, not 404", async () => {
  const csrf = {
    errors: [
      {
        message:
          "This operation has been blocked as a potential Cross-Site Request Forgery (CSRF).",
        extensions: { code: "BAD_REQUEST" },
      },
    ],
  };
  const result = await discoverPairing(API, UA, respond(400, csrf));
  assert.equal(result.available, false);
});

for (const [label, status, body] of [
  ["a 404", 404, { error: "not found" }],
  ["an HTML page from a proxy", 200, "<html>gateway</html>"],
  ["pairing false", 200, { cmdUrl: null, pairing: false }],
  ["no Commander URL", 200, { cmdUrl: "", pairing: true }],
  ["a 500", 500, { error: "boom" }],
] as const) {
  test(`discovery: ${label} means no pairing`, async () => {
    const result = await discoverPairing(API, UA, respond(status, body));
    assert.equal(result.available, false);
  });
}

test("discovery: a network failure is reported, not taken as an old instance", async () => {
  const failing: typeof fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
  };
  await assert.rejects(
    discoverPairing(API, UA, failing),
    (error: InitError) => {
      assert.equal(error.code, "network");
      assert.match(error.message, /ECONNREFUSED/);
      return true;
    },
  );
});

// ---------------------------------------------------------------- starting a session

const sessionRequest = {
  client: "@wopee-io/init test",
  agent: "claude-code",
  host: "laptop",
  repoHint: "shop",
  publicKey: "cHVibGlj",
};

test("start: sends the request as JSON and returns the session", async () => {
  let sent:
    { url: string; body: unknown; headers: Record<string, string> } | undefined;
  const api: typeof fetch = async (url, init) => {
    sent = {
      url: String(url),
      body: JSON.parse(String(init?.body)),
      headers: init?.headers as Record<string, string>,
    };
    return new Response(
      JSON.stringify({
        sessionId: "s-1",
        deviceCode: "d-1",
        userCode: "brave-otter-42",
        verifyUrl: "https://cmd.example.test/cli/authorize?session=s-1",
        expiresIn: 600,
        interval: 3,
      }),
      { status: 201 },
    );
  };
  const session = await startSession(API, sessionRequest, UA, api);

  assert.equal(sent?.url, `${API}/cli/sessions`);
  assert.deepEqual(sent?.body, sessionRequest);
  // Gateways in front of tenant instances drop unusual header names: only the plain ones go out.
  assert.deepEqual(Object.keys(sent?.headers ?? {}).sort(), [
    "content-type",
    "user-agent",
  ]);
  assert.equal(session.deviceCode, "d-1");
  assert.equal(session.userCode, "brave-otter-42");
});

test("start: a rate limit says how long to wait", async () => {
  await assert.rejects(
    startSession(
      API,
      sessionRequest,
      UA,
      respond(429, { error: "rate_limited" }, { "retry-after": "42" }),
    ),
    /Wait 42 seconds/,
  );
});

test("start: pairing switched off on the api points at --manual", async () => {
  await assert.rejects(
    startSession(
      API,
      sessionRequest,
      UA,
      respond(503, { error: "pairing_unavailable" }),
    ),
    (error: InitError) => {
      assert.equal(error.code, "pairing_unavailable");
      assert.equal(error.next, "npx -y @wopee-io/init@latest --manual");
      return true;
    },
  );
});

test("start: a refused request names the field", async () => {
  await assert.rejects(
    startSession(
      API,
      sessionRequest,
      UA,
      respond(400, { error: "invalid_request", field: "publicKey" }),
    ),
    /invalid_request in publicKey/,
  );
});

// ---------------------------------------------------------------- polling

test("poll: each status comes back as it is", async () => {
  for (const status of ["pending", "slow_down", "denied", "expired"]) {
    assert.deepEqual(await pollOnce(API, "d", UA, respond(200, { status })), {
      status,
    });
  }
});

test("poll: approved carries the sealed key and the project", async () => {
  const result = await pollOnce(
    API,
    "d",
    UA,
    respond(200, {
      status: "approved",
      apiKeyEnc: "c2VhbGVk",
      projectUuid: "p-1",
      projectName: "Shop",
      apiUrl: API,
    }),
  );
  assert.deepEqual(result, {
    status: "approved",
    apiKeyEnc: "c2VhbGVk",
    projectUuid: "p-1",
    projectName: "Shop",
  });
});

test("poll: a 5xx or something that is not a poll answer is an api error", async () => {
  await assert.rejects(
    pollOnce(API, "d", UA, respond(500, { error: "server_error" })),
    /HTTP 500/,
  );
  await assert.rejects(
    pollOnce(API, "d", UA, respond(200, { status: "weird" })),
    /HTTP 200/,
  );
  await assert.rejects(
    pollOnce(API, "d", UA, respond(200, { status: "approved" })),
    /sent no key/,
  );
});

// ---------------------------------------------------------------- waiting

function fakeClock(start = 1_000_000): Clock & { slept: number[] } {
  let now = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => now,
    sleep: async (ms) => {
      slept.push(ms);
      now += ms;
    },
  };
}

const scripted = (results: (PollResult | Error)[]) => {
  let i = 0;
  return async () => {
    const next = results[Math.min(i++, results.length - 1)];
    if (next instanceof Error) throw next;
    return next;
  };
};

test("wait: polls every interval until approved", async () => {
  const clock = fakeClock();
  const approved: PollResult = {
    status: "approved",
    apiKeyEnc: "x",
    projectUuid: "p",
    projectName: null,
  };
  const result = await waitForApproval({
    poll: scripted([{ status: "pending" }, { status: "pending" }, approved]),
    interval: 3,
    deadline: clock.now() + 60_000,
    clock,
  });
  assert.equal(result.status, "approved");
  assert.deepEqual(clock.slept, [3000, 3000, 3000]);
});

test("wait: slow_down adds 5 seconds to the interval, as RFC 8628 asks", async () => {
  const clock = fakeClock();
  await waitForApproval({
    poll: scripted([{ status: "slow_down" }, { status: "denied" }]),
    interval: 3,
    deadline: clock.now() + 60_000,
    clock,
  });
  assert.deepEqual(clock.slept, [3000, 8000]);
});

test("wait: denied and expired end the wait", async () => {
  for (const status of ["denied", "expired"] as const) {
    const clock = fakeClock();
    const result = await waitForApproval({
      poll: scripted([{ status }]),
      interval: 3,
      deadline: clock.now() + 60_000,
      clock,
    });
    assert.equal(result.status, status);
  }
});

test("wait: hands back at the deadline instead of sleeping past it", async () => {
  const clock = fakeClock();
  const start = clock.now();
  const result = await waitForApproval({
    poll: scripted([{ status: "pending" }]),
    interval: 3,
    deadline: start + 90_000,
    clock,
  });
  assert.equal(result.status, "timeout");
  assert.ok(clock.now() <= start + 90_000);
  assert.equal(clock.slept.length, 30);
});

test("wait: rides out two failed polls, gives up on the third", async () => {
  const blip = new InitError("network", "Could not reach the api");
  const clock = fakeClock();
  const result = await waitForApproval({
    poll: scripted([blip, blip, { status: "denied" }]),
    interval: 3,
    deadline: clock.now() + 60_000,
    clock,
  });
  assert.equal(result.status, "denied");

  await assert.rejects(
    waitForApproval({
      poll: scripted([blip, blip, blip]),
      interval: 3,
      deadline: fakeClock().now() + 60_000,
      clock: fakeClock(),
    }),
    /Could not reach/,
  );
});

// ---------------------------------------------------------------- sealed box

test("sealed box: only this pairing's key pair opens the key", async () => {
  await sodium.ready;
  const keys = await generateKeyPair();
  const sealed = sodium.to_base64(
    sodium.crypto_box_seal(
      sodium.from_string("wopee-key-123"),
      sodium.from_base64(keys.publicKey, sodium.base64_variants.ORIGINAL),
    ),
    sodium.base64_variants.ORIGINAL,
  );
  assert.equal(await openSealedKey(sealed, keys), "wopee-key-123");

  const other = await generateKeyPair();
  await assert.rejects(openSealedKey(sealed, other));
});

// ---------------------------------------------------------------- state file

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "wopee-init-state-"));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const state = (over: Partial<PairingState> = {}): PairingState => ({
  v: 1,
  apiUrl: API,
  sessionId: "s",
  deviceCode: "d",
  userCode: "brave-otter-42",
  verifyUrl: "https://cmd.example.test/cli/authorize?session=s",
  expiresAt: Date.now() + 600_000,
  interval: 3,
  publicKey: "pub",
  privateKey: "priv",
  ...over,
});

const gitIn = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

test("state: lives inside the git directory, never in the work tree", () => {
  const repo = join(base, "repo");
  mkdirSync(repo);
  gitIn(repo, "init", "-q");
  const path = pairingStatePath(repo);
  assert.equal(
    // .native expands Windows 8.3 short names (RUNNER~1) the way git spells the path.
    realpathSync.native(join(path, "..")),
    realpathSync.native(join(repo, ".git")),
  );
  saveState(path, state());
  assert.equal(
    gitIn(repo, "status", "--porcelain", "--untracked-files=all"),
    "",
  );
});

test("state: a worktree keeps it in its own git directory", () => {
  const repo = join(base, "main");
  mkdirSync(repo);
  gitIn(repo, "init", "-q");
  gitIn(
    repo,
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  );
  const tree = join(base, "tree");
  gitIn(repo, "worktree", "add", "-q", tree);
  const path = pairingStatePath(tree);
  // In a worktree .git is a file; the state goes to the directory it points at.
  assert.ok(!path.startsWith(join(tree, ".git") + "/"));
  assert.match(
    path.replace(/\\/g, "/"),
    /\.git\/worktrees\/tree\/wopee-init-pairing\.json$/,
  );
});

test("state: outside git it goes to the temp dir, one file per folder", () => {
  const a = join(base, "a");
  const b = join(base, "b");
  mkdirSync(a);
  mkdirSync(b);
  assert.notEqual(pairingStatePath(a), pairingStatePath(b));
  assert.ok(pairingStatePath(a).startsWith(tmpdir()));
});

test(
  "state: outside git, the same folder reached through a link finds the same pairing",
  { skip: process.platform === "win32" },
  () => {
    const real = join(base, "real");
    const link = join(base, "link");
    mkdirSync(real);
    symlinkSync(real, link);
    assert.equal(pairingStatePath(link), pairingStatePath(real));
  },
);

test("state: saved private, read back, cleared", () => {
  const path = join(base, "state.json");
  saveState(path, state());
  if (process.platform !== "win32")
    assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.deepEqual(
    loadState(path),
    state({ expiresAt: loadState(path)!.expiresAt }),
  );
  clearState(path);
  assert.equal(existsSync(path), false);
  clearState(path); // no error when it is already gone
});

test("state: a missing, corrupt or foreign file reads as no pairing", () => {
  const path = join(base, "state.json");
  assert.equal(loadState(path), null);
  for (const text of [
    "not json",
    "{}",
    JSON.stringify({ ...state(), v: 2 }),
    JSON.stringify({ ...state(), deviceCode: "" }),
  ]) {
    writeFileSync(path, text);
    assert.equal(loadState(path), null, text);
  }
});

// ---------------------------------------------------------------- calling agent

test("calling agent: Claude Code's AI_AGENT value still reads as Claude Code", () => {
  assert.deepEqual(callingAgentFromName("claude-code_2-1-325_agent"), {
    slug: "claude-code",
    id: "claude-code",
  });
  assert.deepEqual(callingAgentFromName("claude"), {
    slug: "claude-code",
    id: "claude-code",
  });
});

test("calling agent: the agents we configure map to their config", () => {
  assert.deepEqual(callingAgentFromName("cursor-cli"), {
    slug: "cursor",
    id: "cursor",
  });
  assert.deepEqual(callingAgentFromName("codex"), {
    slug: "codex",
    id: "codex",
  });
  assert.deepEqual(callingAgentFromName("opencode"), {
    slug: "opencode",
    id: "opencode",
  });
  assert.deepEqual(callingAgentFromName("github-copilot"), {
    slug: "github-copilot",
    id: "vscode",
  });
});

test("calling agent: others keep a short plain name, nothing at all stays nothing", () => {
  assert.deepEqual(callingAgentFromName("devin"), { slug: "devin" });
  assert.deepEqual(callingAgentFromName("Some Agent/1.2 <x>"), {
    slug: "some",
  });
  assert.equal(callingAgentFromName(""), undefined);
  assert.equal(callingAgentFromName(undefined), undefined);
});

test("the remote server lookup gives an https URL, or null for anything else", async () => {
  const { discoverRemoteMcp } = await import("./pairing.ts");
  const answer = (status: number, body: unknown) =>
    (async () =>
      new Response(JSON.stringify(body), {
        status,
      })) as unknown as typeof fetch;
  const api = "https://api.wopee.io";
  assert.equal(
    await discoverRemoteMcp(
      api,
      "t",
      answer(200, { mcpUrl: "https://mcp.wopee.io/mcp/" }),
    ),
    "https://mcp.wopee.io/mcp",
  );
  assert.equal(
    await discoverRemoteMcp(api, "t", answer(200, { mcpUrl: null })),
    null,
  );
  assert.equal(
    await discoverRemoteMcp(api, "t", answer(200, { pairing: true })),
    null,
  );
  assert.equal(await discoverRemoteMcp(api, "t", answer(404, {})), null);
  assert.equal(
    await discoverRemoteMcp(
      api,
      "t",
      answer(200, { mcpUrl: "http://mcp.wopee.io/mcp" }),
    ),
    null,
  );
  assert.equal(
    await discoverRemoteMcp(api, "t", answer(200, { mcpUrl: "not a url" })),
    null,
  );
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  assert.equal(await discoverRemoteMcp(api, "t", down), null);
});
