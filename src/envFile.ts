import { existsSync } from "node:fs";
import { join } from "node:path";

import { parseDotenv, upsertDotenv } from "./dotenv.ts";
import { readTextIfExists } from "./files.ts";

export const ENV_KEYS = [
  "WOPEE_API_KEY",
  "WOPEE_PROJECT_UUID",
  "WOPEE_API_URL",
] as const;
export type EnvKey = (typeof ENV_KEYS)[number];

/** `.env.local` when the repo already uses one, else `.env`. wopee-mcp reads both. */
export function chooseEnvFile(root: string): string {
  return existsSync(join(root, ".env.local")) ? ".env.local" : ".env";
}

/** The Wopee.io values already in the repo; `.env.local` beats `.env`, as in wopee-mcp. */
export function readRepoEnv(root: string): Partial<Record<EnvKey, string>> {
  const values: Partial<Record<EnvKey, string>> = {};
  for (const name of [".env", ".env.local"]) {
    const text = readTextIfExists(join(root, name));
    if (text === null) continue;
    const parsed = parseDotenv(text);
    for (const key of ENV_KEYS) {
      const value = parsed.get(key)?.trim();
      if (value) values[key] = value;
    }
  }
  return values;
}

export interface EnvPlan {
  file: string;
  path: string;
  next: string;
  changed: boolean;
  /** Keys that already hold a different, non-empty value. */
  conflicts: EnvKey[];
}

export function planEnvFile(
  root: string,
  file: string,
  desired: Partial<Record<EnvKey, string>>,
): EnvPlan {
  const path = join(root, file);
  const current = readTextIfExists(path) ?? "";
  const existing = parseDotenv(current);

  const updates: Record<string, string> = {};
  const conflicts: EnvKey[] = [];
  for (const key of ENV_KEYS) {
    const value = desired[key];
    if (value === undefined) continue;
    const old = existing.get(key)?.trim();
    if (old === value) continue;
    if (old) conflicts.push(key);
    updates[key] = value;
  }

  const next = Object.keys(updates).length
    ? upsertDotenv(current, updates)
    : current;
  return { file, path, next, changed: next !== current, conflicts };
}
