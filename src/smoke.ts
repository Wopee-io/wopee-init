import { InitError } from "./errors.ts";
import { redact, registerSecret } from "./redact.ts";

const QUERY = `query WopeeInitSmoke($projectUuid: ID!) {
  fetchAnalysisSuites(projectUuid: $projectUuid) { uuid }
}`;

const TIMEOUT_MS = 30_000;
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER/;

const INVALID_CREDENTIALS =
  "Wopee.io refused this API key for this project. The key and the project UUID must come from the same project: generate a new key on the API Keys page and try again.";

interface GraphQLError {
  message?: string;
  extensions?: { code?: string };
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } })
    ?.cause;
  return `${cause?.code ?? ""} ${cause?.message ?? ""}`;
}

/**
 * One read call with the pasted values. It proves the key belongs to the project before anything
 * is written, and returns the number of analyses.
 */
export async function smokeTest(
  apiUrl: string,
  projectUuid: string,
  apiKey: string,
  userAgent: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ analyses: number }> {
  registerSecret(apiKey);
  let response: Response;
  try {
    response = await fetchImpl(apiUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": userAgent,
        // Corporate gateways drop header names with an underscore; the api reads either.
        api_key: apiKey,
        "x-api-key": apiKey,
      },
      body: JSON.stringify({ query: QUERY, variables: { projectUuid } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const code = errorCode(error);
    if (TLS_CODES.test(code)) {
      throw new InitError(
        "network",
        `Could not verify the TLS certificate of ${apiUrl} (${code.trim()}). Behind a company proxy, set NODE_EXTRA_CA_CERTS to the company root certificate and run this again.`,
      );
    }
    const reason =
      (error as Error)?.name === "TimeoutError"
        ? "timed out"
        : code.trim() || String(error);
    throw new InitError(
      "network",
      redact(`Could not reach ${apiUrl}: ${reason}`),
    );
  }

  let body:
    | { data?: { fetchAnalysisSuites?: unknown }; errors?: GraphQLError[] }
    | undefined;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }

  const errors = body?.errors ?? [];
  const refused =
    response.status === 401 ||
    response.status === 403 ||
    errors.some(
      (e) =>
        e.extensions?.code === "FORBIDDEN" ||
        e.extensions?.code === "UNAUTHENTICATED" ||
        /not authori[sz]ed/i.test(e.message ?? ""),
    );
  if (refused) throw new InitError("invalid_credentials", INVALID_CREDENTIALS);

  if (!body) {
    throw new InitError(
      "instance",
      `${apiUrl} did not answer like a Wopee.io api (HTTP ${response.status}). Check --api-url.`,
    );
  }
  if (errors.length) {
    const message = errors.map((e) => e.message ?? "unknown error").join("; ");
    throw new InitError(
      "api_error",
      redact(`Wopee.io returned an error: ${message}`),
    );
  }

  const suites = body.data?.fetchAnalysisSuites;
  if (!Array.isArray(suites)) {
    throw new InitError(
      "instance",
      `${apiUrl} did not answer like a Wopee.io api. Check --api-url.`,
    );
  }
  return { analyses: suites.length };
}
