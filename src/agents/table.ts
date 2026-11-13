import { existsSync } from "node:fs";
import { join } from "node:path";

export const SERVER_NAME = "wopee";
export const MCP_COMMAND = "npx";
export const MCP_ARGS = ["-y", "wopee-mcp"] as const;

export type AgentId =
  "claude-code" | "cursor" | "vscode" | "opencode" | "codex";

export interface AgentContext {
  /** The repository root (or the current folder outside git). */
  root: string;
  home: string;
  /** The env file name the credentials go to, relative to the root. */
  envFile: string;
}

interface AgentBase {
  id: AgentId;
  name: string;
  /** Codex loads project config only in trusted projects, so its entry lives in the user config. */
  scope: "project" | "user";
  file: (ctx: AgentContext) => string;
  detect: (ctx: AgentContext) => boolean;
  restartHint: string;
}

export interface JsonAgent extends AgentBase {
  format: "json";
  /** Path of the server entry in the file, e.g. `["mcpServers", "wopee"]`. */
  jsonPath: string[];
  entry: (ctx: AgentContext) => Record<string, unknown>;
}

export interface TomlAgent extends AgentBase {
  format: "toml";
}

export type AgentTarget = JsonAgent | TomlAgent;

const anyExists = (root: string, names: string[]) =>
  names.some((n) => existsSync(join(root, n)));

// The key-free entry: wopee-mcp finds the credentials in the workspace env file itself. Cursor and
// VS Code can also load an env file into the server process, which keeps older wopee-mcp working.
const npxEntry = () => ({ command: MCP_COMMAND, args: [...MCP_ARGS] });

// Claude Code on native Windows cannot start `npx` directly; it needs the `cmd /c` wrapper.
export const claudeCodeEntry = (
  platform: NodeJS.Platform = process.platform,
) =>
  platform === "win32"
    ? { command: "cmd", args: ["/c", MCP_COMMAND, ...MCP_ARGS] }
    : npxEntry();

export const AGENTS: readonly AgentTarget[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    scope: "project",
    format: "json",
    file: ({ root }) => join(root, ".mcp.json"),
    detect: ({ root }) =>
      anyExists(root, [".claude", "CLAUDE.md", ".mcp.json"]),
    jsonPath: ["mcpServers", SERVER_NAME],
    entry: () => claudeCodeEntry(),
    restartHint:
      "quit Claude Code, start `claude` again in this folder and choose “Use this MCP server”",
  },
  {
    id: "cursor",
    name: "Cursor",
    scope: "project",
    format: "json",
    file: ({ root }) => join(root, ".cursor", "mcp.json"),
    detect: ({ root }) => anyExists(root, [".cursor", ".cursorrules"]),
    jsonPath: ["mcpServers", SERVER_NAME],
    entry: ({ envFile }) => ({
      ...npxEntry(),
      envFile: `\${workspaceFolder}/${envFile}`,
    }),
    restartHint:
      "open Cursor Settings › MCP and switch on `wopee` (project servers start disabled)",
  },
  {
    id: "vscode",
    name: "VS Code",
    scope: "project",
    format: "json",
    file: ({ root }) => join(root, ".vscode", "mcp.json"),
    detect: ({ root }) => anyExists(root, [".vscode"]),
    jsonPath: ["servers", SERVER_NAME],
    entry: ({ envFile }) => ({
      type: "stdio",
      ...npxEntry(),
      envFile: `\${workspaceFolder}/${envFile}`,
    }),
    restartHint: "open .vscode/mcp.json and click Start above `wopee`",
  },
  {
    id: "opencode",
    name: "OpenCode",
    scope: "project",
    format: "json",
    file: ({ root }) =>
      join(
        root,
        existsSync(join(root, "opencode.jsonc"))
          ? "opencode.jsonc"
          : "opencode.json",
      ),
    detect: ({ root }) =>
      anyExists(root, ["opencode.json", "opencode.jsonc", ".opencode"]),
    jsonPath: ["mcp", SERVER_NAME],
    entry: () => ({
      type: "local",
      command: [MCP_COMMAND, ...MCP_ARGS],
      enabled: true,
    }),
    restartHint: "restart opencode in this folder",
  },
  {
    id: "codex",
    name: "Codex",
    scope: "user",
    format: "toml",
    file: ({ home }) => join(home, ".codex", "config.toml"),
    detect: ({ home }) => existsSync(join(home, ".codex")),
    restartHint: "restart Codex from this folder",
  },
];

export function agentById(id: string): AgentTarget | undefined {
  return AGENTS.find((a) => a.id === id);
}
