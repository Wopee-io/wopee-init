// Run with: node --test src/units.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { maskEntry } from "./agents/plan.ts";
import { claudeCodeEntry } from "./agents/table.ts";
import { planJsonEntry } from "./agents/writeJson.ts";
import { planCodexEntry } from "./agents/writeToml.ts";
import { parseDotenv, upsertDotenv } from "./dotenv.ts";
import { appendIgnore } from "./git.ts";
import { parsePasted, validateApiKey, validateProjectUuid } from "./input.ts";
import { apiKeysPageUrl, resolveApiUrl, resolveCmdUrl } from "./instance.ts";
import { clearSecrets, redact, registerSecret } from "./redact.ts";

const UUID = "1f2113a9-0000-4000-8000-000000000001";

test("api url: flag beats env beats env file beats the default, normalised", () => {
  assert.equal(resolveApiUrl({}), "https://api.wopee.io");
  assert.equal(
    resolveApiUrl({ envFile: "https://api.dev.wopee.io/" }),
    "https://api.dev.wopee.io",
  );
  assert.equal(
    resolveApiUrl({
      env: " https://api.acme.example ",
      envFile: "https://api.dev.wopee.io",
    }),
    "https://api.acme.example",
  );
  assert.equal(
    resolveApiUrl({
      flag: "https://api.dev.wopee.io",
      env: "https://api.acme.example",
    }),
    "https://api.dev.wopee.io",
  );
  // Client configs pass unset variables through as "".
  assert.equal(resolveApiUrl({ flag: "", env: "  " }), "https://api.wopee.io");
  assert.throws(
    () => resolveApiUrl({ flag: "api.wopee.io" }),
    /not a valid URL/,
  );
  assert.throws(() => resolveApiUrl({ flag: "ftp://api.wopee.io" }), /https/);
});

test("cmd url: api. becomes cmd. on prod, dev and customer hosts; others need --cmd-url", () => {
  assert.equal(resolveCmdUrl("https://api.wopee.io"), "https://cmd.wopee.io");
  assert.equal(
    resolveCmdUrl("https://api.dev.wopee.io"),
    "https://cmd.dev.wopee.io",
  );
  assert.equal(
    resolveCmdUrl("https://api.wopee.acme.example/graphql"),
    "https://cmd.wopee.acme.example",
  );
  assert.equal(
    resolveCmdUrl("http://api.localdev.localhost:8080"),
    "http://cmd.localdev.localhost:8080",
  );
  assert.throws(
    () => resolveCmdUrl("https://wopee-api.acme.example"),
    /--cmd-url/,
  );
  assert.equal(
    resolveCmdUrl(
      "https://wopee-api.acme.example",
      "https://wopee.acme.example/",
    ),
    "https://wopee.acme.example",
  );
});

test("api keys page: deep link with the project, start page without", () => {
  assert.equal(
    apiKeysPageUrl("https://cmd.wopee.io", UUID),
    `https://cmd.wopee.io/tests?projectId=${UUID}&settings=api_keys`,
  );
  assert.equal(apiKeysPageUrl("https://cmd.wopee.io"), "https://cmd.wopee.io/");
});

test("pasted values: bare, NAME=value lines and quotes", () => {
  assert.equal(
    parsePasted("WOPEE_PROJECT_UUID", ` WOPEE_PROJECT_UUID=${UUID} `),
    UUID,
  );
  assert.equal(
    parsePasted("WOPEE_API_KEY", 'export WOPEE_API_KEY="abc123"'),
    "abc123",
  );
  assert.equal(parsePasted("WOPEE_API_KEY", "abc123"), "abc123");
  assert.equal(validateProjectUuid(UUID), undefined);
  assert.match(validateProjectUuid("not-a-uuid") ?? "", /not a project UUID/);
  assert.match(validateApiKey("") ?? "", /Paste/);
  assert.match(validateApiKey("ab c") ?? "", /no spaces/);
});

test("dotenv: parses comments, export, quotes and inline comments", () => {
  const parsed = parseDotenv(
    "# c\nexport A=1\nB=\"two words\" \nC='x#y'\nD=plain # note\r\nE=\nA=override\n",
  );
  assert.deepEqual(Object.fromEntries(parsed), {
    A: "override",
    B: "two words",
    C: "x#y",
    D: "plain",
    E: "",
  });
});

test("dotenv upsert: keeps other lines, rewrites in place, appends new keys, keeps CRLF", () => {
  assert.equal(upsertDotenv("", { K: "v" }), "K=v\n");
  assert.equal(
    upsertDotenv("# db\nDB=x\nWOPEE_API_KEY=\nOTHER=1", {
      WOPEE_API_KEY: "k1",
      WOPEE_PROJECT_UUID: UUID,
    }),
    `# db\nDB=x\nWOPEE_API_KEY=k1\nOTHER=1\nWOPEE_PROJECT_UUID=${UUID}\n`,
  );
  assert.equal(upsertDotenv("A=1\r\n", { B: "2" }), "A=1\r\nB=2\r\n");
  assert.equal(upsertDotenv("", { K: 'a b"c' }), 'K="a b\\"c"\n');
  // A commented-out definition is left alone.
  assert.equal(upsertDotenv("# K=old\n", { K: "new" }), "# K=old\nK=new\n");
});

test("gitignore append: separates from existing rules, keeps line endings", () => {
  assert.equal(appendIgnore(null, ".env"), "# Wopee.io credentials\n.env\n");
  assert.equal(
    appendIgnore("node_modules", ".env"),
    "node_modules\n\n# Wopee.io credentials\n.env\n",
  );
  assert.equal(
    appendIgnore("node_modules\r\n", ".env.local"),
    "node_modules\r\n\r\n# Wopee.io credentials\r\n.env.local\r\n",
  );
});

const ENTRY = { command: "npx", args: ["-y", "wopee-mcp"] };

test("claude code entry: npx, wrapped in cmd /c on native Windows", () => {
  assert.deepEqual(claudeCodeEntry("darwin"), ENTRY);
  assert.deepEqual(claudeCodeEntry("linux"), ENTRY);
  assert.deepEqual(claudeCodeEntry("win32"), {
    command: "cmd",
    args: ["/c", "npx", "-y", "wopee-mcp"],
  });
});

test("json: creates the file, nested under the server key", () => {
  const plan = planJsonEntry("f", null, ["mcpServers", "wopee"], ENTRY);
  assert.equal(plan.status, "create");
  assert.deepEqual(JSON.parse(plan.next), { mcpServers: { wopee: ENTRY } });
});

test("json: adds the entry and keeps other servers, comments and indentation", () => {
  const text = `{
    // team servers
    "servers": {
        "github": { "type": "http", "url": "https://api.githubcopilot.com/mcp/" },
    },
}
`;
  const plan = planJsonEntry("f", text, ["servers", "wopee"], {
    type: "stdio",
    ...ENTRY,
  });
  assert.equal(plan.status, "update");
  assert.match(plan.next, /\/\/ team servers/);
  assert.match(plan.next, /"github"/);
  assert.match(plan.next, /\n {8}"wopee": \{/);
  const again = planJsonEntry("f", plan.next, ["servers", "wopee"], {
    type: "stdio",
    ...ENTRY,
  });
  assert.equal(again.status, "same");
  assert.equal(again.next, plan.next);
});

test("json: an equal entry with other key order is a no-op", () => {
  const text =
    '{"mcpServers":{"wopee":{"args":["-y","wopee-mcp"],"command":"npx"}}}';
  assert.equal(
    planJsonEntry("f", text, ["mcpServers", "wopee"], ENTRY).status,
    "same",
  );
});

test("json: a different wopee entry is a conflict, shown with literal keys masked", () => {
  const text = JSON.stringify({
    mcpServers: {
      wopee: {
        command: "npx",
        args: ["-y", "wopee-mcp"],
        env: {
          WOPEE_API_KEY: "literal-secret",
          WOPEE_PROJECT_UUID: "${WOPEE_PROJECT_UUID}",
        },
      },
    },
  });
  const plan = planJsonEntry("f", text, ["mcpServers", "wopee"], ENTRY);
  assert.equal(plan.status, "conflict");
  assert.doesNotMatch(plan.existing ?? "", /literal-secret/);
  assert.match(plan.existing ?? "", /\$\{WOPEE_PROJECT_UUID\}/);
  assert.deepEqual(JSON.parse(plan.next).mcpServers.wopee, ENTRY);
});

test("json: invalid files are refused, not overwritten", () => {
  assert.throws(
    () => planJsonEntry("f", "{ nope", ["mcpServers", "wopee"], ENTRY),
    /not valid JSON/,
  );
  assert.throws(
    () => planJsonEntry("f", "[]", ["mcpServers", "wopee"], ENTRY),
    /not valid JSON/,
  );
});

test("mask: literal keys in args are masked too", () => {
  assert.deepEqual(maskEntry({ args: ["-e", "WOPEE_API_KEY=abc"] }), {
    args: ["-e", "WOPEE_API_KEY=********"],
  });
});

const CODEX_BLOCK =
  '[mcp_servers.wopee]\ncommand = "npx"\nargs = ["-y", "wopee-mcp"]\n';

test("toml: creates and appends the table, keeping the rest of the file", () => {
  assert.deepEqual(planCodexEntry("f", null), {
    path: "f",
    status: "create",
    next: CODEX_BLOCK,
  });
  const text =
    '# my codex\nmodel = "gpt-5"\n\n[mcp_servers.github]\ncommand = "gh-mcp"\n';
  const plan = planCodexEntry("f", text);
  assert.equal(plan.status, "update");
  assert.equal(plan.next, `${text}\n${CODEX_BLOCK}`);
  assert.equal(planCodexEntry("f", plan.next).status, "same");
});

test("toml: the same table with other spacing and comments is a no-op", () => {
  const text =
    '[mcp_servers."wopee"]  # wopee\ncommand="npx"\nargs = [ "-y", "wopee-mcp" ]\n\n[other]\nx = 1\n';
  assert.equal(planCodexEntry("f", text).status, "same");
});

test("toml: a different table (with sub-table) is replaced only on its own lines", () => {
  const text =
    'a = 1\n\n[mcp_servers.wopee]\ncommand = "npx"\nargs = ["-y", "wopee-mcp"]\nenv_vars = ["WOPEE_API_KEY"]\n\n[mcp_servers.wopee.env]\nWOPEE_API_KEY = "literal-secret"\n\n# keep me\n[mcp_servers.github]\ncommand = "gh"\n';
  const plan = planCodexEntry("f", text);
  assert.equal(plan.status, "conflict");
  assert.doesNotMatch(plan.existing ?? "", /literal-secret/);
  assert.equal(
    plan.next,
    `a = 1\n\n${CODEX_BLOCK}\n# keep me\n[mcp_servers.github]\ncommand = "gh"\n`,
  );
});

test("toml: an inline wopee table is refused", () => {
  assert.throws(
    () => planCodexEntry("f", '[mcp_servers]\nwopee = { command = "npx" }\n'),
    /inline table/,
  );
});

test("redact: masks every registered secret", () => {
  clearSecrets();
  registerSecret("s3cr3t-key");
  assert.equal(redact("a s3cr3t-key b s3cr3t-key"), "a ******** b ********");
  clearSecrets();
});
