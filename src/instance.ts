import { InitError } from "./errors.ts";

export const DEFAULT_API_URL = "https://api.wopee.io";

/** Trims a URL and drops the trailing slash: `https://api.wopee.io/` -> `https://api.wopee.io`. */
export function normalizeUrl(raw: string, flag = "--api-url"): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new InitError("usage", `${flag} is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new InitError(
      "usage",
      `${flag} must start with https:// (got ${url.protocol}//)`,
    );
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/+$/, "");
}

/** The first non-empty source wins: --api-url, then WOPEE_API_URL, then the repo's env file. */
export function resolveApiUrl(sources: {
  flag?: string;
  env?: string;
  envFile?: string;
}): string {
  const raw = [sources.flag, sources.env, sources.envFile].find((v) =>
    v?.trim(),
  );
  return raw ? normalizeUrl(raw) : DEFAULT_API_URL;
}

/**
 * Commander runs next to the api: `api.<rest>` -> `cmd.<rest>`, which is how every Wopee.io
 * instance is laid out (prod, dev and customer instances alike). Other hosts need --cmd-url.
 */
export function resolveCmdUrl(apiUrl: string, override?: string): string {
  if (override?.trim()) return normalizeUrl(override, "--cmd-url");
  const url = new URL(apiUrl);
  if (!url.hostname.startsWith("api.")) {
    throw new InitError(
      "usage",
      `Cannot work out the Commander URL for ${url.host}. Pass it with --cmd-url <url>.`,
    );
  }
  url.hostname = `cmd.${url.hostname.slice("api.".length)}`;
  return url.origin;
}

/** The API Keys tab of a project, or Commander's start page when the project is not known yet. */
export function apiKeysPageUrl(cmdUrl: string, projectUuid?: string): string {
  if (!projectUuid) return `${cmdUrl}/`;
  const params = new URLSearchParams({
    projectId: projectUuid,
    settings: "api_keys",
  });
  return `${cmdUrl}/tests?${params}`;
}
