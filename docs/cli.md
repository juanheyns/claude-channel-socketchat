---
layout: default
title: CLI reference
---

# CLI reference

`socketchat` is a companion tool for interacting with running socketchat plugins. It reads the index, resolves the target, opens a Unix socket, and speaks the [wire protocol](protocol).

All commands support `--help` implicitly — run `socketchat` with no args to see usage.

## Target resolution

All commands that accept a `target` use the same resolution rules:

| Target | Behaviour |
|---|---|
| _(omitted)_ | If exactly one session is active, use it; otherwise list candidates and exit |
| Exact instance id | Direct match |
| Unique id prefix | Match if prefix resolves to exactly one session |
| Unique cwd substring | Match if substring resolves to exactly one session |
| Ambiguous or missing | Lists candidates on stderr and exits non-zero |

Stale entries (dead pids) are filtered out before resolution.

## `ls` — list active sessions

```
socketchat ls [pattern] [--json]
```

Lists all active plugin instances, optionally filtered by a substring that matches id or cwd.

**Human-readable output:**

```
$ socketchat ls
7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88    12s  pid=4711  cwd=/workspace/repo
another    3m   pid=5823  cwd=/home/user/proj
```

**Machine-readable:**

```
$ socketchat ls --json | jq '.[].id'
"7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88"
"another"
```

## `ping` — health check

```
socketchat ping [target] [--timeout SECS]
```

Sends `{"type":"ping"}`, waits for `{"type":"pong"}`, prints round-trip time. Does not reach Claude — useful for script readiness checks.

```
$ socketchat ping 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88
pong from 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88 (2ms)
```

Default timeout: 5 seconds. Exit code 0 on pong, 1 on timeout or connection failure.

## `send` — one-shot message

```
socketchat send [target] <json|-> [--no-wait] [--timeout SECS]
```

Sends a channel message and waits for the agent's reply.

**Arguments:**

- `<target>` — optional; follows [target resolution](#target-resolution)
- `<json>` — the message body (literal JSON string) or `-` to read from stdin

**Flags:**

- `--no-wait` — return after ack, don't wait for the agent's reply. Prints `ack <message_id>` on success.
- `--timeout SECS` — abort if no reply arrives in SECS (default 60)

**Examples:**

```bash
# Basic send, wait up to 60s for Claude to reply
socketchat send '{"hello":"world"}'

# Pipe body from stdin
cat payload.json | socketchat send -

# Target a specific session, short timeout
socketchat send 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88 '{"action":"shutdown"}' --timeout 10

# Fire and forget (exits after ack)
socketchat send '{"event":"ping"}' --no-wait
```

**Exit codes:**

- `0` — reply received (or ack received with `--no-wait`)
- `1` — error: no target found, invalid JSON, timeout, connection failure

**Output:**

- Reply text on stdout (pretty-printed if it's JSON)
- Errors on stderr

## `chat` — interactive REPL

```
socketchat chat [target]
```

Opens a persistent connection and reads JSON lines from stdin, printing every received server message prefixed with `<`. Exits on Ctrl+D or the server closing the connection.

```
$ socketchat chat
connected to 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88
socket:   /Users/.../sessions/7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88.sock
cwd:      /workspace/repo
type JSON lines; Ctrl+D to exit.

{"type":"ping"}
< {"type":"pong","ts":"..."}
{"hello":"world"}
< {"type":"ack","message_id":"m..."}
< {"type":"reply","reply_to":"m...","text":"..."}
```

Invalid JSON input is rejected client-side with a message on stderr; the line is not sent to the server.

## `log` — view the session log

```
socketchat log [target] [-f | --follow]
```

Prints (or tails with `-f`) the plugin's structured log file.

```bash
# Print the whole log
socketchat log 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88

# Follow new events
socketchat log 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88 -f

# Filter with jq
socketchat log 7c9f2a43-8e1d-4f66-bd42-9a3e7c1b2f88 -f | jq 'select(.msg=="message_in" or .msg=="reply")'
```

Log path: `~/.claude/channels/socketchat/logs/<instance-id>.log`. See [Debugging](debugging) for the event schema.

## Environment

Client respects the same state-dir env var as the server:

| Variable | Purpose |
|---|---|
| `SOCKET_CHAT_DIR` | Override the state directory (default: `~/.claude/channels/socketchat`) |

This lets you point the client at a non-standard location (e.g. for testing or a custom container path). All server env vars are detailed in [Configuration](configuration).
