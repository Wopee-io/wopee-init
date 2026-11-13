export type ConfigStatus = "create" | "update" | "same" | "conflict";

/** What writing one agent's MCP entry would do. `next` is the whole new file text. */
export interface ConfigPlan {
  path: string;
  status: ConfigStatus;
  next: string;
  /** The existing `wopee` entry when it differs, with secret-looking values masked. */
  existing?: string;
}

const SECRET_NAME_RE = /key|token|secret|password/i;

/** Masks literal secrets in an existing entry before it is shown; `${VAR}` references stay. */
export function maskEntry(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskEntry);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        typeof v === "string" &&
        SECRET_NAME_RE.test(k) &&
        !/^\$\{[^}]+\}$/.test(v)
          ? "********"
          : maskEntry(v),
      ]),
    );
  }
  // A literal key in args, e.g. "WOPEE_API_KEY=abc".
  if (typeof value === "string")
    return value.replace(
      /^([A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*=).+$/,
      "$1********",
    );
  return value;
}
