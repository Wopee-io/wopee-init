import { InitError } from "../errors.ts";
import type { ConfigPlan } from "./plan.ts";
import { MCP_ARGS, MCP_COMMAND, SERVER_NAME } from "./table.ts";

const TABLE = `mcp_servers.${SERVER_NAME}`;
const HEADER_RE = /^\s*\[\s*([^\]\s][^\]]*?)\s*\]\s*(#.*)?$/;

const blockLines = (eol: string) =>
  [
    `[${TABLE}]`,
    `command = ${JSON.stringify(MCP_COMMAND)}`,
    `args = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(", ")}]`,
  ].join(eol);

// `mcp_servers."wopee"` and `mcp_servers . wopee` name the same table.
const normalizeTableName = (name: string) =>
  name
    .split(".")
    .map((part) => part.trim().replace(/^"(.*)"$/, "$1"))
    .join(".");

/** The key = value lines of a table, comments and blank lines dropped, whitespace removed. */
const significant = (lines: string[]) =>
  lines
    .map((l) =>
      l
        .replace(/\s+#.*$/, "")
        .replace(/^\s*#.*$/, "")
        .replace(/\s+/g, ""),
    )
    .filter(Boolean);

/**
 * Plans the `[mcp_servers.wopee]` table in Codex's config.toml as a text edit, so the user's
 * comments and layout survive (no TOML library round-trips them).
 */
export function planCodexEntry(path: string, text: string | null): ConfigPlan {
  const current = text ?? "";
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = current === "" ? [] : current.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  let start = -1;
  let end = lines.length;
  let parent: string | null = null;
  lines.forEach((line, i) => {
    const header = HEADER_RE.exec(line);
    if (header) {
      const name = normalizeTableName(header[1].replace(/^\[|\]$/g, ""));
      parent = name;
      if (start < 0 && name === TABLE) start = i;
      // Sub-tables such as [mcp_servers.wopee.env] belong to the entry.
      else if (
        start >= 0 &&
        end === lines.length &&
        !name.startsWith(`${TABLE}.`)
      )
        end = i;
    } else if (parent === "mcp_servers" && /^\s*"?wopee"?\s*=/.test(line)) {
      throw new InitError(
        "invalid_config",
        `${path} defines wopee as an inline table. Remove that line, then run this again.`,
      );
    }
  });

  const desired = blockLines(eol);
  if (start < 0) {
    const prefix = lines.length ? `${lines.join(eol)}${eol}${eol}` : "";
    return {
      path,
      status: text === null ? "create" : "update",
      next: `${prefix}${desired}${eol}`,
    };
  }

  // Trailing blank lines and comments stay outside the block we replace.
  while (end - 1 > start && /^\s*(#.*)?$/.test(lines[end - 1])) end--;
  const block = lines.slice(start, end);
  // The header was matched by name already; compare the key = value lines below it.
  if (
    significant(block.slice(1)).join("\n") ===
    significant(desired.split(eol).slice(1)).join("\n")
  ) {
    return { path, status: "same", next: current };
  }

  const next =
    [...lines.slice(0, start), ...desired.split(eol), ...lines.slice(end)].join(
      eol,
    ) + eol;
  const existing = block
    .join("\n")
    .replace(/((?:KEY|TOKEN|SECRET)[A-Z_]*\s*=\s*)"[^"]*"/gi, '$1"********"');
  return { path, status: "conflict", next, existing };
}
