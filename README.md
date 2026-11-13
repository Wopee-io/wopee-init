# @wopee-io/init

Connect a repository and its AI coding agents to [Wopee.io](https://wopee.io) in one command.

```sh
npx -y @wopee-io/init --manual
```

Run it **in your own terminal**, from the repository you want to test. You type the API key into a masked prompt, so it never passes through a coding agent's chat.

## What it does

1. It opens the **API Keys** page of your project in Wopee.io Commander. Copy `WOPEE_PROJECT_UUID`, generate a key and copy `WOPEE_API_KEY`. Only project admins see this page.
2. It checks the two values with one read-only call. If the key is wrong, it stops and writes nothing.
3. It writes `WOPEE_API_KEY` and `WOPEE_PROJECT_UUID` to `.env`, or to `.env.local` when the repo already has one. If `.gitignore` does not ignore that file yet, it adds it there. It refuses to write to an env file that git already tracks.
4. It adds a key-free `wopee` MCP server (`npx -y wopee-mcp`) for each coding agent you pick:

| Agent             | File                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Claude Code       | `.mcp.json`                                                                              |
| Cursor            | `.cursor/mcp.json`                                                                       |
| VS Code (Copilot) | `.vscode/mcp.json`                                                                       |
| OpenCode          | `opencode.json`                                                                          |
| Codex             | `~/.codex/config.toml` (user scope: Codex reads project config only in trusted projects) |

On native Windows, the Claude Code entry runs `cmd /c npx -y wopee-mcp`, because Claude Code cannot start `npx` directly there.

`wopee-mcp` (1.35.0 or newer) reads the key from the repo's env file itself, so no MCP config holds a key and every config is safe to commit. Other servers and comments in these files are kept. If a different `wopee` entry already exists, you are asked before it is replaced. Running the command again changes nothing.

## Options

| Option             |                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--api-url <url>`  | A dedicated or dev instance, e.g. `https://api.dev.wopee.io`. Default: `WOPEE_API_URL`, then the repo's env file, then `https://api.wopee.io` |
| `--cmd-url <url>`  | The Commander URL, when it is not the api host with `api.` replaced by `cmd.`                                                                 |
| `--project <uuid>` | Opens that project's API Keys page directly                                                                                                   |
| `--agent <id>`     | `claude-code`, `cursor`, `vscode`, `opencode` or `codex`; repeat it for several. Skips the picker                                             |
| `--no-open`        | Prints the link without opening a browser                                                                                                     |

Behind a company proxy, `HTTPS_PROXY` and `NO_PROXY` are honoured. If TLS fails, set `NODE_EXTRA_CA_CERTS` to your company's root certificate.

## Undo

Delete the `wopee` entry from each agent file, or the `[mcp_servers.wopee]` table for Codex. Remove the `WOPEE_*` lines from `.env`. Then delete the key in Commander under **API Keys › Existing keys**.

## License

MIT
