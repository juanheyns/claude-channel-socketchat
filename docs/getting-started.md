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

### Recommended: via the marketplace

The fastest way to install socketchat is through the [`juanheyns-claude-plugins`](https://github.com/juanheyns/juanheyns-claude-plugins) marketplace. Inside Claude Code:

```
/plugin marketplace add juanheyns/juanheyns-claude-plugins
/plugin install socketchat@juanheyns-claude-plugins
```

Claude Code fetches the plugin, registers its MCP server, and activates it as a channel. The socket binds at `~/.claude/channels/socketchat/sessions/<instance-id>.sock` on first session.

To use the companion CLI (`client.ts`) for `ls`, `ping`, `send`, `chat`, and `log`, clone this repo separately:

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install     # for the client's deps
```

The CLI reads `~/.claude/channels/socketchat/index.json` to find running plugins — it works against whatever socketchat instances are active, regardless of whether you installed the plugin via marketplace or locally.

### For plugin development: `--plugin-dir`

If you're iterating on the plugin code itself, bypass the marketplace and load the local checkout directly:

```bash
git clone https://github.com/juanheyns/claude-channel-socketchat socketchat
cd socketchat
bun install
claude --plugin-dir "$PWD"
```

Claude Code reads `.claude-plugin/plugin.json` and `.mcp.json` from the plugin root and spawns the server from your local copy. Any changes to `server.ts` are picked up on next Claude start (or run `/reload-plugins`).

### Manual MCP registration (escape hatch)

Skip the plugin manifest entirely and register the server by hand:

```bash
claude mcp add socketchat bun "$PWD/server.ts"
claude --dangerously-load-development-channels server:socketchat
```

Works, but you lose the plugin niceties (versioning, keyword discovery, marketplace update flow). Use only for quick one-off testing.

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

Pass `SOCKET_CHAT_INSTANCE_ID` in the shell env to get a predictable socket path:

```bash
SOCKET_CHAT_INSTANCE_ID=task-42 claude
```

Now the socket is at `~/.claude/channels/socketchat/sessions/task-42.sock`. Combine with `claude --session-id task-42` for full id unification — see [deployment](deployment) for why.

## Next

- [Architecture](architecture) — what's happening under the hood
- [Wire protocol](protocol) — message schemas and routing
- [CLI reference](cli) — all the `client.ts` subcommands
