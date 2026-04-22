---
layout: default
title: Home
---

# socketchat

Unix-socket channel MCP plugin for Claude Code. External processes on the same host push messages into a running Claude session; the agent replies through the same socket. Filesystem permissions are the only auth.

## Sections

- [Getting started](getting-started) — install, register, send a first message
- [Architecture](architecture) — how it fits into Claude Code, lifecycle, session identity
- [Wire protocol](protocol) — NDJSON message types, routing, timeouts
- [CLI reference](cli) — `client.ts` subcommands
- [Configuration](configuration) — env vars, paths, permissions
- [Deployment](deployment) — ephemeral containers, unattended mode, id unification
- [Debugging](debugging) — log file format, common issues, manual tests
- [Releasing](releasing) — tag workflow that auto-syncs to the marketplace

## 60-second overview

```bash
# Install + register
bun install
claude mcp add socketchat bun "$PWD/server.ts"

# Start Claude with the channel
claude --dangerously-load-development-channels server:socketchat

# In another terminal, push a message in
./client.ts send '{"hello":"from ops"}'
```

The agent sees the message as a `<channel source="socketchat" ...>` event and replies via the `reply` tool. The reply comes back on the sender's socket.

## When to use it

Reach for socketchat when you need **host-local IPC with Claude**:

- An orchestrator signalling a long-running `claude -p` loop to wrap up
- A deploy gate asking the agent to approve an action
- A sidecar streaming events for the agent to react to
- An approval UI delivering human decisions mid-flow

It's the right fit when every sender is on the same host and you want:

- No tokens, no auth server, no network config
- Sub-millisecond ping latency
- A single-file MCP plugin you can drop into a container image
- Clean failure semantics: `{delivered: true}` / `{delivered: false, reason: ...}`

Not the right fit when senders are remote — that's what Telegram/Discord/Slack channels are for.

## How it compares

| | fakechat | telegram / discord / imessage | socketchat |
|---|---|---|---|
| Transport | WebSocket | Bot API | Unix socket |
| Auth | none (localhost) | bot tokens | filesystem perms |
| Scope | single browser | per-user chat | host-local processes |
| Multi-sender | ✗ (broadcast only) | ✓ | ✓ (per-connection routing) |
| Reply routing | n/a | chat_id | reply_to message_id |
| External deps | bun | bun + bot tokens | bun |
