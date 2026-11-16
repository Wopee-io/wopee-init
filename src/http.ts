import { InitError } from "./errors.ts";
import { redact } from "./redact.ts";

export const TIMEOUT_MS = 30_000;
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/;

function causeOf(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return `${cause?.code ?? ""} ${cause?.message ?? ""}`.trim();
}

/**
 * A failed request as the user should read it: a company proxy's certificate gets the
 * NODE_EXTRA_CA_CERTS hint, a timeout says so, anything else names the underlying cause.
 */
export function networkError(apiUrl: string, error: unknown): InitError {
  const code = causeOf(error);
  if (TLS_CODES.test(code)) {
    return new InitError(
      "network",
      `Could not verify the TLS certificate of ${apiUrl} (${code}). Behind a company proxy, set NODE_EXTRA_CA_CERTS to the company root certificate and run this again.`,
    );
  }
  const reason =
    (error as Error)?.name === "TimeoutError"
      ? "timed out"
      : code || String(error);
  return new InitError(
    "network",
    redact(`Could not reach ${apiUrl}: ${reason}`),
  );
}

export interface JsonResponse {
  status: number;
  /** The parsed body, or undefined when it was not JSON (an HTML error page, a proxy). */
  body: unknown;
  headers: Headers;
}

/**
 * One request with a JSON body and a JSON answer. Plain `content-type` only: corporate gateways
 * in front of tenant instances drop unusual header names.
 */
export async function requestJson(
  apiUrl: string,
  path: string,
  options: {
    method: "GET" | "POST";
    body?: unknown;
    userAgent: string;
    fetchImpl?: typeof fetch;
  },
): Promise<JsonResponse> {
  const fetchImpl = options.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(`${apiUrl}${path}`, {
      method: options.method,
      headers: {
        "user-agent": options.userAgent,
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      body:
        options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    throw networkError(apiUrl, error);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  return { status: response.status, body, headers: response.headers };
}
