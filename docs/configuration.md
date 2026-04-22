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

## Passing env vars to the plugin

The plugin is installed from the marketplace; its MCP subprocess inherits the env of the Claude process that spawned it. So setting vars is just a matter of where you set them in the shell that launches `claude`.

### Option A: Set in the shell before launch (default)

```bash
SOCKET_CHAT_INSTANCE_ID=7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88 \
SOCKET_CHAT_LOG_FILE=/var/log/socketchat.log \
  claude
```

Works for per-invocation overrides. Ideal for orchestrators and scripts.

### Option B: Persistent per-user config in settings.json

In `~/.claude/settings.json`, override the plugin's MCP server entry with an `env` block:

```json
{
  "mcpServers": {
    "socketchat": {
      "env": {
        "SOCKET_CHAT_LOG_FILE": "/var/log/socketchat.log"
      }
    }
  }
}
```

Claude Code merges this on top of the plugin's `.mcp.json` definition. Only the `env` key is overridden; `command` and `args` are inherited from the plugin.

### Option C: Wrap Claude in a shell script

For complex defaults (e.g. derive instance id from a CI variable):

```bash
cat > /usr/local/bin/claude-with-socketchat <<'EOF'
#!/bin/bash
export SOCKET_CHAT_INSTANCE_ID="${CLAUDE_TASK_ID:-$(uuidgen)}"
exec claude "$@"
EOF
chmod +x /usr/local/bin/claude-with-socketchat
```

## Tuning guidance

**Long-running orchestration (hours):** raise `IDLE_TIMEOUT_MS`, or have senders ping periodically to keep connections alive.

**Many concurrent senders:** raise `MAX_CONNECTIONS` above 64 if needed. The overhead per connection is a socket + ~1 KiB state.

**Large payloads:** raise `MAX_LINE_BYTES` if you need to push blobs over the socket. Consider whether a file reference would be cleaner than inlining.

**Agent sometimes takes minutes to reply:** raise `PENDING_TTL_MS`. Default 5 min assumes interactive or near-interactive agent responses. For autonomous long-running flows, 30+ minutes may be appropriate.
