import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
} from "jsonc-parser";
import type { ParseError } from "jsonc-parser";

import { InitError } from "../errors.ts";
import { maskEntry } from "./plan.ts";
import type { ConfigPlan } from "./plan.ts";

// jsonc-parser builds null-prototype objects, so compare canonical JSON (keys sorted), not objects.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, v[k]]),
        )
      : v,
  );
}

function detectIndent(text: string): {
  insertSpaces: boolean;
  tabSize: number;
} {
  const match = /^([ \t]+)\S/m.exec(text);
  if (!match) return { insertSpaces: true, tabSize: 2 };
  if (match[1].startsWith("\t")) return { insertSpaces: false, tabSize: 1 };
  return { insertSpaces: true, tabSize: match[1].length };
}

/**
 * Plans setting one server entry in a JSON or JSONC config. Only that entry changes: other
 * servers, keys, comments and formatting stay as they are.
 */
export function planJsonEntry(
  path: string,
  text: string | null,
  jsonPath: string[],
  entry: Record<string, unknown>,
): ConfigPlan {
  if (text === null || text.trim() === "") {
    const [root, ...rest] = jsonPath;
    let value: unknown = entry;
    for (const key of rest.reverse()) value = { [key]: value };
    return {
      path,
      status: "create",
      next: `${JSON.stringify({ [root]: value }, null, 2)}\n`,
    };
  }

  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, { allowTrailingComma: true });
  if (errors.length || !tree || tree.type !== "object") {
    throw new InitError(
      "invalid_config",
      `${path} is not valid JSON. Fix it, then run this again.`,
    );
  }

  const node = findNodeAtLocation(tree, jsonPath);
  const current = node ? getNodeValue(node) : undefined;
  if (current !== undefined && canonical(current) === canonical(entry)) {
    return { path, status: "same", next: text };
  }

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const edits = modify(text, jsonPath, entry, {
    formattingOptions: { ...detectIndent(text), eol },
  });
  const next = applyEdits(text, edits);
  if (current === undefined) return { path, status: "update", next };
  return {
    path,
    status: "conflict",
    next,
    existing: JSON.stringify(maskEntry(current), null, 2),
  };
}
