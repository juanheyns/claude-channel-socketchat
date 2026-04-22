---
layout: default
title: Configuration
---

# Configuration

All configuration is via environment variables. All variables are prefixed `SOCKET_CHAT_`. Defaults are sensible; most deployments set zero or one variable.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `SOCKET_CHAT_INSTANCE_ID` | random UUID | Plugin instance id. Determines socket path, log file, and index entry. Must match `[A-Za-z0-9._-]{1,128}`; invalid values are rejected with a warning and fall back to a UUID. |
| `SOCKET_CHAT_DIR` | `~/.claude/channels/socketchat` | Root of the state directory tree (sessions, logs, index) |
| `SOCKET_CHAT_LOG_FILE` | `<state>/logs/<id>.log` | Override the log file path. Set to `/dev/null` to discard. |
| `SOCKET_CHAT_MAX_CONNECTIONS` | 64 | Max concurrent client connections before rejection |
| `SOCKET_CHAT_MAX_LINE_BYTES` | 1048576 (1 MiB) | Max per-line size; connections exceeding it are dropped |
| `SOCKET_CHAT_IDLE_TIMEOUT_MS` | 600000 (10 min) | Auto-disconnect clients after this idle period |
| `SOCKET_CHAT_PENDING_TTL_MS` | 300000 (5 min) | Deadline for the agent to reply; after expiry the sender gets `{type:"error","reason":"reply_timeout"}` |
| `SOCKET_CHAT_OUTBOUND_HIGH_WATER` | 1048576 (1 MiB) | Slow-reader threshold; connections exceeding this buffer size are disconnected |

## Paths and permissions

Default layout:

```
~/.claude/channels/socketchat/
├── index.json                      mode 0660
├── sessions/                       mode 0770
│   ├── <id>.sock                   mode 0660
│   └── <id>.sock.lock              mode 0660  (contains pid)
└── logs/                           mode 0770
    └── <id>.log                    mode 0660
```

All state lives under `SOCKET_CHAT_DIR`. The directory is created on first start with `0770` (owner + group only).

### Sharing between multiple users

To allow other users to send, add them to the group that owns `SOCKET_CHAT_DIR`:

```bash
sudo chgrp claude-ops ~/.claude/channels/socketchat
sudo chmod g+s ~/.claude/channels/socketchat  # setgid so new files inherit group
sudo usermod -a -G claude-ops alice
```

The socket's `0660` permission means any member of the group can read/write.

### Defense in depth

The plugin does not perform `SO_PEERCRED` peer credential checks. If you need to reject specific UIDs even within the shared group, add the check in the `onConnection` handler. For most use cases, group membership is sufficient.

## Registering with Claude Code

Passing env vars to a registered MCP server:

```bash
claude mcp add socketchat bun /path/to/server.ts
```

This registration doesn't accept env vars directly. To set them, either:

### Option A: Wrap in a shell script

```bash
cat > /usr/local/bin/socketchat-server <<'EOF'
#!/bin/bash
export SOCKET_CHAT_INSTANCE_ID="${CLAUDE_TASK_ID:-$(uuidgen)}"
exec bun /path/to/server.ts
EOF
chmod +x /usr/local/bin/socketchat-server

claude mcp remove socketchat
claude mcp add socketchat /usr/local/bin/socketchat-server
```

### Option B: Set env before launching Claude

```bash
SOCKET_CHAT_INSTANCE_ID=task-42 \
  claude --dangerously-load-development-channels server:socketchat
```

Env vars in the Claude process environment propagate to MCP subprocesses.

### Option C: Edit settings.json

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "socketchat": {
      "command": "bun",
      "args": ["/absolute/path/to/server.ts"],
      "env": {
        "SOCKET_CHAT_LOG_FILE": "/var/log/socketchat.log"
      }
    }
  }
}
```

The `env` block is per-server and overrides/augments inherited vars.

## Tuning guidance

**Long-running orchestration (hours):** raise `IDLE_TIMEOUT_MS`, or have senders ping periodically to keep connections alive.

**Many concurrent senders:** raise `MAX_CONNECTIONS` above 64 if needed. The overhead per connection is a socket + ~1 KiB state.

**Large payloads:** raise `MAX_LINE_BYTES` if you need to push blobs over the socket. Consider whether a file reference would be cleaner than inlining.

**Agent sometimes takes minutes to reply:** raise `PENDING_TTL_MS`. Default 5 min assumes interactive or near-interactive agent responses. For autonomous long-running flows, 30+ minutes may be appropriate.
