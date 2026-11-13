// Run with: node --test src/smoke.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { InitError } from "./errors.ts";
import { smokeTest } from "./smoke.ts";

const UUID = "1f2113a9-0000-4000-8000-000000000001";
const KEY = "smoke-secret-key";

const respond =
  (status: number, body: unknown): typeof fetch =>
  async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
    });

const rejects = (fetchImpl: typeof fetch, code: string, message?: RegExp) =>
  assert.rejects(
    smokeTest("https://api.wopee.io", UUID, KEY, "wopee-init/test", fetchImpl),
    (e) => {
      assert.ok(e instanceof InitError);
      assert.equal(e.code, code);
      if (message) assert.match(e.message, message);
      assert.doesNotMatch(e.message, new RegExp(KEY));
      return true;
    },
  );

test("sends the key in both headers and the project as a variable; counts analyses", async () => {
  let seen: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    seen = init;
    return new Response(
      JSON.stringify({
        data: { fetchAnalysisSuites: [{ uuid: "a" }, { uuid: "b" }] },
      }),
    );
  };
  assert.deepEqual(
    await smokeTest(
      "https://api.wopee.io",
      UUID,
      KEY,
      "wopee-init/test",
      fetchImpl,
    ),
    { analyses: 2 },
  );
  const headers = seen?.headers as Record<string, string>;
  assert.equal(headers.api_key, KEY);
  assert.equal(headers["x-api-key"], KEY);
  assert.equal(headers["user-agent"], "wopee-init/test");
  assert.deepEqual(JSON.parse(String(seen?.body)).variables, {
    projectUuid: UUID,
  });
});

test("a refused key fails as invalid_credentials, whatever shape the refusal has", async () => {
  await rejects(
    respond(200, { errors: [{ message: "Not Authorised!" }] }),
    "invalid_credentials",
    /same project/,
  );
  await rejects(
    respond(401, {
      errors: [{ message: "Forbidden", extensions: { code: "FORBIDDEN" } }],
    }),
    "invalid_credentials",
  );
  await rejects(respond(403, "<html>denied</html>"), "invalid_credentials");
});

test("a host that is not a Wopee.io api fails as instance", async () => {
  await rejects(
    respond(502, "<html>Bad gateway</html>"),
    "instance",
    /HTTP 502/,
  );
  await rejects(respond(200, { data: {} }), "instance");
});

test("other GraphQL errors are reported, with the key redacted", async () => {
  await rejects(
    respond(200, { errors: [{ message: `boom ${KEY}` }] }),
    "api_error",
    /boom \*+/,
  );
});

test("network and TLS failures say what to do", async () => {
  const failing =
    (code: string): typeof fetch =>
    async () => {
      throw Object.assign(new TypeError("fetch failed"), {
        cause: { code, message: code },
      });
    };
  await rejects(
    failing("UNABLE_TO_GET_ISSUER_CERT_LOCALLY"),
    "network",
    /NODE_EXTRA_CA_CERTS/,
  );
  await rejects(failing("ENOTFOUND"), "network", /Could not reach .*ENOTFOUND/);
});
