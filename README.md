# @wopee-io/init

Connect a repository and its AI coding agents to [Wopee.io](https://wopee.io) in one command.

```sh
npx -y @wopee-io/init@latest
```

This is the setup command for a request like _"Set up Wopee.io testing for this repo."_ A coding
agent can run it itself from the repository root: it asks no questions and needs no key. You can
also run it in your own terminal.

It prints a link and three pairing words. You open the link, check that Wopee.io Commander shows
the same words, pick a project and approve. A new, named project API key then comes back
**encrypted to the command**: nobody copies it, and it never passes through the agent's chat.

## What it does

1. **Pairs with Commander.** It asks your Wopee.io instance for a pairing session, prints the link
   and the words, and opens your browser (when you run it yourself). It sends a one-time public
   key; the api seals the new API key to it, so only this process can read the answer.
2. **Checks the key** with one read-only call before anything is written.
3. **Writes** `WOPEE_API_KEY` and `WOPEE_PROJECT_UUID` to `.env`, or to `.env.local` when the repo
   already has one. If `.gitignore` does not ignore that file yet, it adds it there. It refuses to
   write to an env file that git already tracks — and checks that before pairing, so no key is ever
   created that could not be stored.
4. **Adds a key-free `wopee` MCP server** (`npx -y wopee-mcp@latest`) for your coding agents:

| Agent             | File                                                                                     |
| ----------------- | ---------------------------------------------------------------------------------------- |
| Claude Code       | `.mcp.json`                                                                              |
| Cursor            | `.cursor/mcp.json`                                                                       |
| VS Code (Copilot) | `.vscode/mcp.json`                                                                       |
| OpenCode          | `opencode.json`                                                                          |
| Codex             | `~/.codex/config.toml` (user scope: Codex reads project config only in trusted projects) |

On native Windows, the Claude Code entry runs `cmd /c npx -y wopee-mcp@latest`, because Claude Code cannot
start `npx` directly there.

`wopee-mcp` (1.35.0 or newer) reads the key from the repo's env file itself, so no MCP config holds
a key and every config is safe to commit. Other servers and comments in these files are kept.

`@latest` matters: a bare `npx -y wopee-mcp` keeps running whichever version npx cached first,
which can predate 1.35.0. An entry an older version of this command wrote (`npx -y wopee-mcp`) is
upgraded when you run it again; an entry you changed yourself is left alone.

If the env file already holds a key that works for the project, it is kept and no new key is
created. Running the command again changes nothing.

## From a coding agent

When a coding agent runs it (or there is no terminal), it never prompts. It prints **one JSON
object per line on stdout** and its human-readable text on stderr.

The first run returns within seconds and exits with code 75, which is not a failure. Some agents
hide a command's output until it ends, so this is what puts the link on your screen:

```jsonc
{"status":"pairing","verification_url":"https://cmd.wopee.io/cli/authorize?session=…","user_code":"brave-otter-42","expires_in":600}
{"status":"action_required","message":"Show the user the link and brave-otter-42, …","reason":"approve_in_commander","verification_url":"https://cmd.wopee.io/cli/authorize?session=…","user_code":"brave-otter-42","expires_in":600,"next":"npx -y @wopee-io/init@latest --resume"}
```

The agent shows you the link and the words, then runs the `next` command. That command waits for
your approval and finishes the setup:

```jsonc
{"status":"pairing","verification_url":"https://cmd.wopee.io/cli/authorize?session=…","user_code":"brave-otter-42","expires_in":590}
{"status":"success","project_uuid":"…","api_url":"https://api.wopee.io","analyses":3,"files":[".gitignore",".env",".mcp.json"],"skipped":[],"agents":[{"id":"claude-code","restart":"…"}],"first_prompt":"Run a Wopee analysis of <your app URL>"}
```

If you have not approved within about 90 seconds (inside the default time limit of an agent's shell
tool), `--resume` exits with code 75 again. Once you say you approved, the agent runs `next` once
more; the link stays valid for 10 minutes. Errors look like
`{"status":"error","code":"pairing_denied","message":"…","next":"…"}`. No line ever contains the
key.

In agent mode an existing, different `wopee` MCP server is never overwritten: it is listed under
`skipped`. So is a config file the agent's sandbox does not allow it to write.

The waiting pairing is kept in `.git/wopee-init-pairing.json` (in the temp directory outside a git
repository), readable only by you, and deleted as soon as the pairing is approved, denied or
expires.

## With the Wopee.io agent plugin

The [Wopee.io plugin](https://github.com/Wopee-io/agent-plugins) for Claude Code and Codex already
brings the `wopee` MCP server, so its setup skill runs `npx -y @wopee-io/init@latest --env-only`:
it pairs as usual but writes only the git-ignored env file, and no second `wopee` server.

## In CI

It never pairs in CI. Set `WOPEE_API_KEY` and `WOPEE_PROJECT_UUID` as secrets — generate a key on
your project's **API Keys** page in Commander — and it uses them. Without them it fails at once
with `missing_credentials`.

## Options

| Option             |                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--resume`         | Continue a pairing an earlier run handed back, waiting about 90 seconds for the approval                                                      |
| `--no-wait`        | With `--resume`: hand back right after printing the link, without waiting                                                                     |
| `--manual`         | Paste the project UUID and a key from the API Keys page instead of pairing. Needs a terminal: the key goes into a masked prompt               |
| `--api-url <url>`  | A dedicated or dev instance, e.g. `https://api.dev.wopee.io`. Default: `WOPEE_API_URL`, then the repo's env file, then `https://api.wopee.io` |
| `--cmd-url <url>`  | The Commander URL for `--manual`, when it is not the api host with `api.` replaced by `cmd.`                                                  |
| `--project <uuid>` | The project, when the key comes from `WOPEE_API_KEY` or `--api-key`                                                                           |
| `--api-key <key>`  | Use this key instead of pairing. Prefer the `WOPEE_API_KEY` variable: a flag ends up in your shell history                                    |
| `--agent <id>`     | `claude-code`, `cursor`, `vscode`, `opencode` or `codex`; repeat it for several. Skips the picker                                             |
| `--all`            | Configure every supported agent                                                                                                               |
| `--env-only`       | Write only the env file and its `.gitignore` entry, no MCP config: for the Wopee.io agent plugin, which brings the server                     |
| `--print`          | Print the MCP snippets and the variable names instead of writing anything. Creates no key                                                     |
| `--dry-run`        | Show what would change, without writing anything or creating a key                                                                            |
| `--no-open`        | Print the link without opening a browser                                                                                                      |

Exit codes: `0` done, `2` usage, `3` credentials, `4` network or instance, `5` unsafe or
conflicting file, `6` pairing denied or expired, `75` waiting for your approval, `130` cancelled.

A Wopee.io instance that does not offer pairing yet is detected: run yourself, it switches to the
`--manual` flow; run by an agent, it says to run `--manual` in your own terminal.

Behind a company proxy, `HTTPS_PROXY` and `NO_PROXY` are honoured. If TLS fails, set
`NODE_EXTRA_CA_CERTS` to your company's root certificate.

## Undo

Delete the `wopee` entry from each agent file, or the `[mcp_servers.wopee]` table for Codex. Remove
the `WOPEE_*` lines from `.env`. Then delete the key in Commander under **API Keys › Existing
keys**: a paired key is named `wopee-init · <agent> · <machine> · <date>`.

## License

MIT
