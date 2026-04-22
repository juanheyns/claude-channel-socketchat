---
layout: default
title: Debugging
---

# Debugging

socketchat emits a structured JSON log per session for every meaningful event. If anything looks off, the log is the first place to look.

## Log location

Default: `~/.claude/channels/socketchat/logs/<instance-id>.log`

Override: `SOCKET_CHAT_LOG_FILE=/path/to/log`

Tail with the client:

```bash
./client.ts log -f
./client.ts log task-42 -f
```

Or directly:

```bash
tail -F ~/.claude/channels/socketchat/logs/task-42.log
```

Logs are also mirrored to stderr, so if you're running the plugin with `claude --debug`, they appear in Claude's debug output too.

## Event schema

Every log line is one JSON object with this shape:

```json
{
  "t": "2026-04-22T17:10:00.000Z",
  "level": "info",
  "msg": "<event-name>",
  "instance": "<instance-id>",
  "...": "event-specific fields"
}
```

### Lifecycle events

| `msg` | When | Fields |
|---|---|---|
| `boot` | Process start | `pid`, `ppid`, `cwd`, `log_file`, `socket`, `env` (SOCKET_CHAT_* only), `config` |
| `listening` | After socket bind | `socket`, `pid`, `ppid` |
| `mcp_connected` | After Claude attaches via stdio | — |
| `shutting down` | Shutdown initiated | `reason` |
| `stopped` | After cleanup, pre-exit | `reason`, `uptime_s` |
| `swept stale instance` | Startup sweep found a dead peer's lock/socket | `pid`, `lock` |

### Runtime events

| `msg` | When | Fields |
|---|---|---|
| `connection_open` | New socket client | `chat_id`, `total` |
| `connection_close` | Client disconnect | `chat_id`, `total` |
| `message_in` | Inbound channel message (after ack) | `chat_id`, `message_id`, `bytes` |
| `reply` | `reply` tool called | `reply_to`, `chat_id`, `delivered`, `bytes`, `reason` |

### Warning / error events

| `msg` | When |
|---|---|
| `line too long, closing` | Client exceeded `MAX_LINE_BYTES` |
| `slow reader, disconnecting` | Outbound buffer exceeded `OUTBOUND_HIGH_WATER` |
| `max connections reached, rejecting` | At connection cap |
| `idle timeout` | Client hit `IDLE_TIMEOUT_MS` |
| `socket error` | Unexpected socket error |
| `notification failed` | MCP notification send failed |
| `removeFromIndex failed` | Failed to update `index.json` on shutdown |
| `unhandled rejection` / `uncaught exception` | Process-level error handlers |

## Useful queries

With `jq`:

```bash
# All inbound messages and their replies
./client.ts log -f | jq 'select(.msg=="message_in" or .msg=="reply")'

# Only errors and warnings
./client.ts log -f | jq 'select(.level!="info")'

# Connection churn
./client.ts log -f | jq 'select(.msg | startswith("connection_"))'

# Undelivered replies (client was gone or TTL expired)
./client.ts log | jq 'select(.msg=="reply" and .delivered==false)'

# Uptime check — last stopped event
./client.ts log | jq 'select(.msg=="stopped") | {t, uptime_s, reason}'
```

## Common issues

### Plugin install fails / "repository not found"

You tried `/plugin install socketchat@juanheyns-claude-plugins` and got a clone error. Usually one of:

- Marketplace not added: `/plugin marketplace add juanheyns/juanheyns-claude-plugins` first.
- Stale marketplace cache: `/plugin marketplace update juanheyns-claude-plugins`.
- Private plugin repo without credentials: check your git credential helper, or use HTTPS with a token.

### Claude doesn't see `<channel>` tags

You successfully loaded the plugin (see `mcp_connected` in the log) but sent messages don't appear as `<channel>` events in Claude.

- Confirm you're using a claude.ai OAuth login, not an API-key session (channels require OAuth)
- Confirm your Claude Code version is ≥ 2.1.80
- For Team/Enterprise orgs, `channelsEnabled` must be on in managed settings
- Run `claude --debug` to see MCP-level errors

### `ping` works, `send` times out

Plugin is up and serving. The gap is on Claude's side:

- Did the agent actually receive the `<channel>` tag? Check Claude's debug output.
- Is the agent's `CLAUDE.md` (or your prompt) telling it to reply via the `reply` tool? If it just acknowledges in text, the client never sees anything.
- Raise `--timeout` if the agent is slow / in the middle of other work.

### Stale sockets after a crash

Killed Claude with SIGKILL, now `~/.claude/channels/socketchat/sessions/` has orphan `.sock` + `.sock.lock` files. This is normal — next startup sweeps them:

```
{"msg":"swept stale instance","pid":12345,"lock":"/...*.sock.lock"}
```

If you want to clean immediately: `rm -rf ~/.claude/channels/socketchat` (state is ephemeral by design).

### `index.json` shows dead entries

The index is compacted on every write — stale entries vanish once a new session starts. If you're seeing lingering entries with no active sessions, either:

- Nothing has triggered a write recently (the file is static)
- Manual edit required: `echo '{"sessions":[]}' > ~/.claude/channels/socketchat/index.json`

### Plugin exits immediately with `parent_died`

Your launcher forked and orphaned the plugin's parent. By design, the plugin self-terminates when `process.ppid` becomes 1 (reparented to init) — this protects against runaway subprocesses after Claude crashes. The plugin should be spawned as a direct child of the Claude process, which is what happens by default with a marketplace install.

### "connect failed: ENOENT" from the client

Socket path doesn't exist. Check:

- `./client.ts ls` — is there actually an active session?
- Is the client pointing at the right state dir? `SOCKET_CHAT_DIR` must match the server's.

## Manual test plan

For a thorough walkthrough before deploying, see the [test plan](https://github.com/YOUR-ORG/YOUR-REPO/blob/main/docs/test-plan.md) — or from first principles, exercise each tier:

1. **Plugin loads** — `ls` shows an entry, `ping` returns `pong`
2. **Inbound works** — `send` produces a `<channel>` tag visible to Claude
3. **Reply routes** — agent calls `reply`, client receives it
4. **Id unification** — `SOCKET_CHAT_INSTANCE_ID=$ID --session-id=$ID` aligns paths
5. **Session switch** — `/clear` does not restart the plugin (confirmed behaviour)
6. **Crash recovery** — `kill -9` the plugin, next startup sweeps the stale socket
7. **Client disconnect** — agent's `reply` returns `{delivered:false,reason:"client_disconnected"}`

The log is the primary evidence. Every interesting transition produces an event.
