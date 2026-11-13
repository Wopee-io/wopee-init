import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export function readTextIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** Writes through a temporary file and a rename, so a crash never leaves half a file. */
export function writeFileAtomic(
  path: string,
  text: string,
  options: { private?: boolean } = {},
): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.wopee-init-${process.pid}.tmp`;
  const mode = options.private ? 0o600 : undefined;
  writeFileSync(tmp, text, { encoding: "utf8", mode });
  renameSync(tmp, path);
  // A file that already existed keeps its old mode through the rename on some systems.
  if (options.private && process.platform !== "win32") chmodSync(path, 0o600);
}
