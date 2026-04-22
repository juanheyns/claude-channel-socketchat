# socketchat

Unix-socket channel MCP plugin for Claude Code. External processes on the same host push messages into a running Claude session; the agent replies through the same socket. Filesystem permissions are the only auth — no tokens, no network config, no chat app.

## Why

Claude Code's [channels](https://code.claude.com/docs/en/channels.md) let external events reach a running session. The official channels (Telegram, Discord, iMessage) are chat-oriented and require bot credentials. For **host-local automation** — orchestrators, sidecars, cron jobs, approval UIs, deploy gates — Unix sockets are a better fit:

- Any local process with `chmod` access can send
- No tokens to rotate, no auth handshake
- Survives in ephemeral containers with a shared tmpfs
- Trivial to test from the shell (`nc -U`, `client.ts send`)

## What you get

- A Unix socket per Claude session at `~/.claude/channels/socketchat/sessions/<id>.sock`
- Bidirectional NDJSON: senders push JSON messages, Claude replies via the `reply` tool, routed back to the originating connection
- A discovery index (`~/.claude/channels/socketchat/index.json`) listing active sessions with cwd, pid, and socket path
- A structured JSON log per session for debugging
- A companion CLI (`client.ts`) with `ls`, `ping`, `send`, `chat`, and `log` subcommands

## Install

### For end users — via the `juanheyns-claude-plugins` marketplace

```bash
# Inside Claude Code:
/plugin marketplace add juanheyns/juanheyns-claude-plugins
/plugin install socketchat@juanheyns-claude-plugins
```

That's it. Restart Claude if needed. socketchat is loaded as a channel plugin and the server binds a Unix socket under `~/.claude/channels/socketchat/`.

Then from a shell:

```bash
# Discover the session
./client.ts ls

# Send a message
./client.ts send '{"hello":"from ops"}'
```

Clone this repo only if you want the companion `client.ts` CLI. The plugin itself is installed by the marketplace.

### For development — `--plugin-dir`

```bash
git clone https://github.com/juanheyns/socketchat
cd socketchat
bun install
claude --plugin-dir "$PWD"
```

Claude Code picks up `.claude-plugin/plugin.json` and `.mcp.json` from the plugin root automatically. Use this path when iterating on the plugin itself.

See [`docs/`](./docs/) for the full picture, including deployment in ephemeral containers, the wire protocol, and a manual test plan.

## Requirements

- Claude Code ≥ 2.1.80 (channels support)
- [Bun](https://bun.sh) runtime
- macOS or Linux (Unix-socket-based)
- A claude.ai account (channels require OAuth, not API key auth)

## License

[MIT](./LICENSE)
