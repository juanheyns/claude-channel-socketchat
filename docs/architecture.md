---
layout: default
title: Architecture
---

# Architecture

## Where it fits

Claude Code has a plugin system called **channels** for pushing external events into a running session. A channel is an MCP server with a couple of extras:

- It emits `notifications/claude/channel` messages, which the Claude Code harness lands in the model's context as `<channel>` tags
- It declares `claude/channel` capability in its MCP `initialize` handshake
- It can expose tools like `reply` to let the agent respond back through the channel

socketchat is a channel plugin whose inbound transport is a Unix socket. External processes speak NDJSON over the socket; the plugin bridges those lines into Claude's context and back.

```
┌────────────────┐                 ┌──────────────────┐
│ sender process │                 │                  │
│ (orchestrator, │◀─────NDJSON────▶│   socketchat     │
│ cron, UI, …)   │ (Unix socket)   │   plugin         │
└────────────────┘                 │  (MCP stdio)     │
                                   │                  │
                                   └────────┬─────────┘
                                            │
                                            │ MCP stdio
                                            ▼
                                   ┌──────────────────┐
                                   │   Claude Code    │
                                   └──────────────────┘
```

## Plugin lifetime

Each `claude` invocation spawns its own plugin subprocess over stdio. The plugin:

1. Generates (or reads from env) an `INSTANCE_ID`
2. Binds a Unix socket at `~/.claude/channels/socketchat/sessions/<id>.sock`
3. Writes an entry in `~/.claude/channels/socketchat/index.json` with its pid, ppid, cwd, socket path, start time
4. Opens a log file at `~/.claude/channels/socketchat/logs/<id>.log`
5. Starts listening for socket clients and MCP requests in parallel
6. On shutdown: closes all connections, removes its index entry, unlinks the socket, releases the lockfile

The plugin **persists across in-process Claude session switches** (e.g. `/clear`). Only a fresh `claude` invocation — new process — spawns a new plugin. This is the intended Claude Code channel design.

## Session identity

`INSTANCE_ID` is the plugin's own identity. It appears in:

- Socket filename
- Index entry `id`
- Log file name
- Every log record (`instance` field)

It is **not** Claude's session id. Claude Code does not pass its session id to plugins. The two are independent by default.

For ephemeral-container use, you can align them by setting both to the same value at launch. Claude's `--session-id` requires a **UUID**, so use `uuidgen` to produce one and reuse it for the plugin's instance id:

```bash
ID=$(uuidgen)
SOCKET_CHAT_INSTANCE_ID=$ID \
  claude --session-id "$ID" \
    --channels plugin:socketchat@juanheyns-claude-plugins
```

(Assumes the plugin is installed from the marketplace and whitelisted in your org's [`allowedChannelPlugins`](deployment#enterprise-setup-no-confirmation-dialog) managed setting. Without that whitelist, substitute `--dangerously-load-development-channels` — which triggers an interactive confirmation dialog on each launch.)

Now the same `$ID` is:
- Claude's transcript filename: `~/.claude/projects/<cwd-key>/$ID.jsonl`
- Plugin's socket path: `~/.claude/channels/socketchat/sessions/$ID.sock`

This alignment is stable **only for the first session**. Any in-process session switch breaks it — Claude's session id changes, the plugin's doesn't.

## Connections and routing

Multiple senders can connect simultaneously. The plugin assigns each connection its own `chat_id` (a generated UUID, opaque to senders) used as an attribute in the `<channel>` tag.

Routing is **per-message**, not per-connection: each inbound message gets a `message_id`, and the plugin maintains a table `message_id → connection`. When the agent calls `reply(text, reply_to)`, the plugin looks up the connection and writes the reply there.

This design means:
- A single connection can send many messages, each with its own reply
- Two connections can send in parallel without interleaving
- Replies can never misroute — the `message_id` is the key

From the agent's perspective, there's one logical channel. Multi-client routing is an internal plumbing concern.

## Discovery

`index.json` is a flat list of active plugin instances:

```json
{
  "sessions": [
    {
      "id": "7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88",
      "socket": "/Users/.../sessions/7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88.sock",
      "pid": 12345,
      "ppid": 12340,
      "cwd": "/workspace/myrepo",
      "started_at": "2026-04-22T17:00:00Z"
    }
  ]
}
```

Senders pick a target by whichever attribute makes sense — id, pid of the parent claude, cwd, or none if exactly one session is active. The `socketchat` CLI demonstrates each style.

Stale entries (whose pid is no longer running) are purged on every index write.

## Robustness

The server implements production patterns borrowed from Claude Code's official channel plugins:

- **Lockfile per instance** — `<id>.sock.lock` contains the pid. On startup, any stale lockfile whose owner pid is gone is swept along with its socket.
- **Orphan watchdog** — every 5 seconds, checks `process.ppid` and `process.stdin.destroyed`. If the parent Claude process died, the plugin self-terminates.
- **Signal handlers** — SIGTERM, SIGINT, SIGHUP trigger graceful shutdown with a 250 ms drain.
- **Bounded resources** — max 64 concurrent connections, 1 MiB max line, 10 min idle timeout, 5 min pending-reply TTL, 1 MiB outbound buffer high-water.
- **Atomic writes** — `index.json` uses tmp-then-rename.
- **Structured logging** — JSON per line, both to stderr and a per-instance log file.

## What the plugin does NOT do

- **No platform-native auth** — no tokens, no allowlists. Filesystem permissions are the gate.
- **No persistent storage** — per-connection state dies with the connection; pending-reply table is in-memory.
- **No message queueing** — if Claude is slow or not listening, the pending table fills and eventually TTL-expires. Clients can detect this via `{type:"error",reason:"reply_timeout"}`.
- **No chunking** — lines are NDJSON with a 1 MiB cap. Large payloads must be split by the sender or referenced out-of-band.
