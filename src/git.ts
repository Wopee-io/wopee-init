import { spawnSync } from "node:child_process";

function git(cwd: string, args: string[]): { ok: boolean; stdout: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: (result.stdout ?? "").trim(),
  };
}

/** The repository root, or null outside a git repository (or without git). */
export function gitRoot(cwd: string): string | null {
  const { ok, stdout } = git(cwd, ["rev-parse", "--show-toplevel"]);
  return ok && stdout ? stdout : null;
}

/** Whether git tracks the file: a tracked file stays in git even when .gitignore lists it. */
export function isTracked(root: string, relPath: string): boolean {
  return git(root, ["ls-files", "--error-unmatch", "--", relPath]).ok;
}

export function isIgnored(root: string, relPath: string): boolean {
  return git(root, ["check-ignore", "-q", "--", relPath]).ok;
}

/** .gitignore text with the file appended under a comment, keeping the file's line endings. */
export function appendIgnore(
  gitignore: string | null,
  relPath: string,
): string {
  const text = gitignore ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text === "" || text.endsWith("\n") ? "" : eol;
  const blank = text.trim() === "" ? "" : eol;
  return `${text}${separator}${blank}# Wopee.io credentials${eol}${relPath}${eol}`;
}
