import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTextIfExists, writeFileAtomic } from "./files.ts";
import { gitDir } from "./git.ts";

/**
 * What `--resume` needs from the run that started a pairing: the polling secret and the private
 * key the api seals the new key to. Kept for minutes at most and deleted as soon as the pairing
 * ends, approved or not.
 */
export interface PairingState {
  v: 1;
  apiUrl: string;
  sessionId: string;
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  /** Epoch milliseconds. */
  expiresAt: number;
  interval: number;
  publicKey: string;
  privateKey: string;
}

const FILE = "wopee-init-pairing.json";

/**
 * Inside the git directory: in the workspace, so a sandboxed agent may write it, and never
 * committed or picked up by `git add`, with no .gitignore change. Outside git, the temp dir, keyed
 * by the folder so two folders never resume each other's pairing.
 */
export function pairingStatePath(root: string): string {
  const dir = gitDir(root);
  if (dir) return join(dir, FILE);
  const id = createHash("sha256")
    .update(canonicalPath(root))
    .digest("hex")
    .slice(0, 16);
  return join(tmpdir(), `wopee-init-${id}.json`);
}

/**
 * One spelling per folder, so the run that hands back and the one that resumes find the same
 * file: symlinks resolved, and on Windows 8.3 short names (`RUNNER~1`) expanded.
 */
function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

export function saveState(path: string, state: PairingState): void {
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`, {
    private: true,
  });
}

/** The saved pairing, or null when there is none or the file is not one of ours. */
export function loadState(path: string): PairingState | null {
  const text = readTextIfExists(path);
  if (text === null) return null;
  let parsed: Partial<PairingState>;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const strings = [
    "apiUrl",
    "sessionId",
    "deviceCode",
    "userCode",
    "verifyUrl",
    "publicKey",
    "privateKey",
  ] as const;
  if (
    parsed?.v !== 1 ||
    strings.some((key) => typeof parsed[key] !== "string" || !parsed[key]) ||
    typeof parsed.expiresAt !== "number" ||
    typeof parsed.interval !== "number"
  ) {
    return null;
  }
  return parsed as PairingState;
}

export function clearState(path: string): void {
  rmSync(path, { force: true });
}
