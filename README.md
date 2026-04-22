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

## Quick start

```bash
# 1. Install deps
bun install

# 2. Register as an MCP server
claude mcp add socketchat bun "$PWD/server.ts"

# 3. Start Claude with the channel loaded
claude --dangerously-load-development-channels server:socketchat

# 4. From another terminal, send a message
./client.ts send '{"hello":"from ops"}'
```

See [`docs/`](./docs/) for the full picture, including deployment in ephemeral containers, the wire protocol, and a manual test plan.

## Requirements

- Claude Code ≥ 2.1.80 (channels support)
- [Bun](https://bun.sh) runtime
- macOS or Linux (Unix-socket-based)
- A claude.ai account (channels require OAuth, not API key auth)

## License

[MIT](./LICENSE)
