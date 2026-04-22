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

## Launch Claude with the plugin loaded

socketchat is a packaged Claude Code plugin. The easiest way to run it is with `--plugin-dir`:

```bash
claude --plugin-dir /path/to/socketchat
```

Claude Code reads `.claude-plugin/plugin.json` and `.mcp.json` from the plugin root and registers the MCP server automatically. The server appears in Claude's tool list as the `socketchat` channel.

### Alternative: install via a marketplace

If you're distributing socketchat through a plugin marketplace (either your own or the official one), users install with:

```bash
claude plugin install socketchat@<marketplace-name>
```

Then launch normally — Claude Code auto-loads installed plugins. See [Deployment](deployment) for packaging into a marketplace.

### Alternative: manual MCP server registration

Skip the plugin manifest entirely and register the server by hand:

```bash
claude mcp add socketchat bun "$PWD/server.ts"
claude --dangerously-load-development-channels server:socketchat
```

Works, but you'll lose the plugin niceties (versioning, keyword discovery, marketplace install).

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
