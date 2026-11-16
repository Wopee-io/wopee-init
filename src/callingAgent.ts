import type { AgentId } from "./agents/table.ts";

export interface CallingAgent {
  /** How Commander names it on the approval card and in the key name, e.g. `claude-code`. */
  slug: string;
  /** The agent whose MCP config we write, when it is one we support. */
  id?: AgentId;
}

const KNOWN: { prefix: string; agent: CallingAgent }[] = [
  { prefix: "claude", agent: { slug: "claude-code", id: "claude-code" } },
  { prefix: "cursor", agent: { slug: "cursor", id: "cursor" } },
  { prefix: "codex", agent: { slug: "codex", id: "codex" } },
  { prefix: "opencode", agent: { slug: "opencode", id: "opencode" } },
  { prefix: "github-copilot", agent: { slug: "github-copilot", id: "vscode" } },
  { prefix: "copilot", agent: { slug: "github-copilot", id: "vscode" } },
];

/**
 * The agent `@vercel/detect-agent` reported. Its name is not always one of its own constants: it
 * passes `AI_AGENT` through as is, and Claude Code sets that to e.g. `claude-code_2-1-325_agent`.
 * So match by prefix, and keep anything else as a short, plain slug rather than the raw string.
 */
export function callingAgentFromName(
  name: string | undefined,
): CallingAgent | undefined {
  const lower = name?.trim().toLowerCase();
  if (!lower) return undefined;
  const known = KNOWN.find((k) => lower.startsWith(k.prefix));
  if (known) return known.agent;
  const slug = lower
    .split(/[_\s/]/)[0]
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 40);
  return slug ? { slug } : undefined;
}
