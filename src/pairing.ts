import { INIT_COMMAND, InitError } from "./errors.ts";
import { requestJson } from "./http.ts";

/**
 * Browser pairing against a Wopee.io api: discover, start a session, poll until the user answers
 * in Commander. The api mints the key only when it is collected, seals it to this process's public
 * key, and hands it over exactly once.
 */

export type Discovery =
  { available: true; cmdUrl: string } | { available: false; reason: string };

/**
 * Whether this api can pair. Only a 2xx whose JSON says `pairing: true` with a Commander URL
 * counts: an api without the routes answers 400 from its GraphQL endpoint's CSRF guard (not 404),
 * and a proxy may answer with an HTML page. Network failures throw, so a TLS or proxy problem is
 * reported instead of silently falling back to the manual flow, which would fail the same way.
 */
export async function discoverPairing(
  apiUrl: string,
  userAgent: string,
  fetchImpl?: typeof fetch,
): Promise<Discovery> {
  const { status, body } = await requestJson(apiUrl, "/cli/info", {
    method: "GET",
    userAgent,
    fetchImpl,
  });
  const info = body as { pairing?: unknown; cmdUrl?: unknown } | undefined;
  if (status < 200 || status >= 300 || !info || typeof info !== "object") {
    return {
      available: false,
      reason: `${apiUrl} does not offer browser pairing yet (an older Wopee.io version).`,
    };
  }
  if (
    info.pairing !== true ||
    typeof info.cmdUrl !== "string" ||
    !info.cmdUrl
  ) {
    return {
      available: false,
      reason: `${apiUrl} has browser pairing turned off (it does not know its Commander address).`,
    };
  }
  return { available: true, cmdUrl: info.cmdUrl.replace(/\/+$/, "") };
}

/**
 * The remote MCP server this api runs, from `/cli/info`: an https URL, or null when the instance
 * runs none (tenants, self-hosted), is too old to say, or cannot be reached. Never throws: without
 * an answer the setup writes today's local (stdio) server.
 */
export async function discoverRemoteMcp(
  apiUrl: string,
  userAgent: string,
  fetchImpl?: typeof fetch,
): Promise<string | null> {
  try {
    const { status, body } = await requestJson(apiUrl, "/cli/info", {
      method: "GET",
      userAgent,
      fetchImpl,
    });
    const url = (body as { mcpUrl?: unknown } | undefined)?.mcpUrl;
    if (status < 200 || status >= 300 || typeof url !== "string") return null;
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      ? parsed.href.replace(/\/+$/, "")
      : null;
  } catch {
    return null;
  }
}

export interface SessionRequest {
  client: string;
  agent: string;
  host: string;
  repoHint: string | null;
  publicKey: string;
}

export interface PairingSession {
  sessionId: string;
  /** The polling secret. Never shown, never put in a URL. */
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresIn: number;
  interval: number;
}

export async function startSession(
  apiUrl: string,
  request: SessionRequest,
  userAgent: string,
  fetchImpl?: typeof fetch,
): Promise<PairingSession> {
  const { status, body, headers } = await requestJson(apiUrl, "/cli/sessions", {
    method: "POST",
    body: request,
    userAgent,
    fetchImpl,
  });
  const answer = (body ?? {}) as Partial<PairingSession> & {
    error?: string;
    field?: string;
  };
  if (status === 201 && answer.deviceCode && answer.verifyUrl) {
    return {
      sessionId: String(answer.sessionId),
      deviceCode: answer.deviceCode,
      userCode: String(answer.userCode),
      verifyUrl: answer.verifyUrl,
      expiresIn: Number(answer.expiresIn) || 600,
      interval: Number(answer.interval) || 3,
    };
  }
  if (status === 429) {
    const wait = Number(headers.get("retry-after")) || 60;
    throw new InitError(
      "api_error",
      `Too many pairing requests from this network. Wait ${wait} seconds and run this again.`,
    );
  }
  if (status === 503) {
    throw new InitError(
      "pairing_unavailable",
      `${apiUrl} has browser pairing turned off.`,
      `${INIT_COMMAND} --manual`,
    );
  }
  throw new InitError(
    "api_error",
    `Wopee.io did not start a pairing (HTTP ${status}${answer.error ? `, ${answer.error}` : ""}${answer.field ? ` in ${answer.field}` : ""}).`,
  );
}

export type PollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied" }
  | { status: "expired" }
  | {
      status: "approved";
      apiKeyEnc: string;
      projectUuid: string;
      projectName: string | null;
    };

const POLL_STATUSES = new Set([
  "pending",
  "slow_down",
  "denied",
  "expired",
  "approved",
]);

/** One poll. A 5xx or an answer that is not a poll result throws `api_error`, which the wait retries. */
export async function pollOnce(
  apiUrl: string,
  deviceCode: string,
  userAgent: string,
  fetchImpl?: typeof fetch,
): Promise<PollResult> {
  const { status, body } = await requestJson(apiUrl, "/cli/sessions/poll", {
    method: "POST",
    body: { deviceCode },
    userAgent,
    fetchImpl,
  });
  const answer = (body ?? {}) as Record<string, unknown>;
  if (status !== 200 || !POLL_STATUSES.has(String(answer.status))) {
    throw new InitError(
      "api_error",
      `Wopee.io did not answer the pairing poll (HTTP ${status}).`,
    );
  }
  if (answer.status === "approved") {
    if (
      typeof answer.apiKeyEnc !== "string" ||
      typeof answer.projectUuid !== "string"
    ) {
      throw new InitError(
        "api_error",
        "Wopee.io approved the pairing but sent no key.",
      );
    }
    return {
      status: "approved",
      apiKeyEnc: answer.apiKeyEnc,
      projectUuid: answer.projectUuid,
      projectName:
        typeof answer.projectName === "string" ? answer.projectName : null,
    };
  }
  return { status: answer.status } as PollResult;
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** How many failed polls in a row (network or 5xx) the wait rides out before giving up. */
const MAX_TRANSIENT_FAILURES = 3;
/** RFC 8628: a client told to slow down adds 5 seconds to its interval. */
const SLOW_DOWN_STEP_S = 5;

export type WaitResult =
  | Exclude<PollResult, { status: "pending" | "slow_down" }>
  | {
      status: "timeout";
    };

/**
 * Polls every `interval` seconds until the user answers, the session expires, or `deadline`
 * passes. A deadline before the session's expiry is how agent mode hands back in time for the
 * agent's own tool timeout; the session stays alive for `--resume`.
 */
export async function waitForApproval(options: {
  poll: () => Promise<PollResult>;
  interval: number;
  deadline: number;
  clock?: Clock;
}): Promise<WaitResult> {
  const clock = options.clock ?? realClock;
  let interval = Math.max(1, options.interval);
  let failures = 0;
  for (;;) {
    if (clock.now() + interval * 1000 > options.deadline) {
      return { status: "timeout" };
    }
    await clock.sleep(interval * 1000);
    let result: PollResult;
    try {
      result = await options.poll();
      failures = 0;
    } catch (error) {
      if (!(error instanceof InitError)) throw error;
      if (error.code !== "network" && error.code !== "api_error") throw error;
      failures += 1;
      if (failures >= MAX_TRANSIENT_FAILURES) throw error;
      continue;
    }
    if (result.status === "pending") continue;
    if (result.status === "slow_down") {
      interval += SLOW_DOWN_STEP_S;
      continue;
    }
    return result;
  }
}
