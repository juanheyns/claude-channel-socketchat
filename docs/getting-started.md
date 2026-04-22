---
layout: default
title: Getting started
---

# Getting started

## Prerequisites

- **Claude Code ≥ 2.1.80** with channels support
- **Bun** — `curl -fsSL https://bun.sh/install | bash`
- **macOS or Linux** — Unix sockets are required
- **claude.ai account** — channels require OAuth, not API-key auth

## Install

Clone and install dependencies:

```bash
git clone <your-repo-url> socketchat
cd socketchat
bun install
```

## Register with Claude Code

Register the plugin as an MCP server. Use an absolute path so it resolves regardless of cwd:

```bash
claude mcp add socketchat bun "$PWD/server.ts"
```

This writes an entry into your Claude Code config. Verify:

```bash
claude mcp list
# socketchat: bun /absolute/path/to/server.ts
```

## Launch Claude with the channel

```bash
claude --dangerously-load-development-channels server:socketchat
```

The flag is called "dangerously" because it loads an un-packaged MCP server as a channel. It's the normal path during development and for self-hosted plugins.

## First round-trip

In another terminal, list active sessions:

```bash
./client.ts ls
```

You should see one entry with the session's instance id, pid, and cwd.

Ping the server (server-only, doesn't reach Claude):

```bash
./client.ts ping
# pong from <id> (3ms)
```

Send a message (this one does reach Claude):

```bash
./client.ts send '{"hello":"world"}'
```

The agent sees a `<channel source="socketchat" ...>` event in its context. Tell it in chat:

> "When you see a channel message, call the `reply` tool with the message_id as `reply_to` and echo the body."

Send again. This time the client prints the reply text back.

## Interactive mode

For back-and-forth exploration:

```bash
./client.ts chat
```

Each line you type must be valid JSON. Responses (acks, replies) print with a `<` prefix.

## Pin the instance id

Pass `SOCKET_CHAT_INSTANCE_ID` to get a predictable socket path:

```bash
SOCKET_CHAT_INSTANCE_ID=task-42 \
  claude --dangerously-load-development-channels server:socketchat
```

Now the socket is at `~/.claude/channels/socketchat/sessions/task-42.sock`. Combine with `claude --session-id task-42` for full id unification — see [deployment](deployment) for why.

## Next

- [Architecture](architecture) — what's happening under the hood
- [Wire protocol](protocol) — message schemas and routing
- [CLI reference](cli) — all the `client.ts` subcommands
