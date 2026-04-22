---
layout: default
title: Wire protocol
---

# Wire protocol

socketchat speaks newline-delimited JSON (NDJSON) over a Unix SOCK_STREAM socket. One JSON object per line, UTF-8, terminated by `\n`.

## Client → server messages

### Channel message (default)

Any JSON object that isn't a recognized server-side type is treated as a channel message. The body is passed through to Claude verbatim.

```json
{"action":"deploy","target":"prod","request_id":"req-42"}
```

Server response:

```json
{"type":"ack","message_id":"m1776882557921-1"}
```

The `message_id` is the correlator for the eventual reply.

### Ping (health check)

```json
{"type":"ping"}
```

Server response (does not reach Claude):

```json
{"type":"pong","ts":"2026-04-22T17:10:00.000Z"}
```

## Server → client messages

### Ack

Sent immediately after an inbound channel message:

```json
{"type":"ack","message_id":"m1776882557921-1"}
```

### Reply

Sent when the agent calls `reply(reply_to=<message_id>, text=<string>)`:

```json
{"type":"reply","reply_to":"m1776882557921-1","text":"..."}
```

The `text` field is application-defined — typically a JSON string the agent wants the sender to parse. The plugin does not interpret it.

### Error

Sent for bad input or expired state:

```json
{"type":"error","reason":"invalid_json"}
{"type":"error","reason":"reply_timeout","message_id":"m..."}
{"type":"error","reason":"max_connections"}
```

| `reason` | Meaning |
|---|---|
| `invalid_json` | Inbound line wasn't valid JSON |
| `reply_timeout` | Pending TTL elapsed without the agent replying |
| `max_connections` | Server is at the connection cap; sent before the server drops the connection |

### Server shutdown

Sent to all connected clients right before the plugin exits:

```json
{"type":"server_shutdown","reason":"sigterm"}
```

Possible reasons: `sigterm`, `sigint`, `sighup`, `stdin_end`, `stdin_close`, `parent_died`, `mcp_closed`.

## Reply routing

1. Client connects, sends a JSON line
2. Server assigns `message_id`, records `(message_id → this connection)`, emits `<channel>` notification to Claude, acks the client
3. Agent calls `reply(text, reply_to)` with the `message_id`
4. Server looks up the connection by `message_id`, writes the reply on that connection, removes the mapping
5. Returns `{delivered: bool, reason?}` to the agent

Failure modes the tool call returns to Claude (not to the sender):

| `reason` | Meaning |
|---|---|
| `unknown_or_expired_message_id` | No matching pending entry (sender never sent this, or TTL elapsed) |
| `client_disconnected` | Mapping exists but socket is destroyed |
| `write_failed` | Socket write threw (rare; disk full, pipe broken) |

## MCP notification Claude sees

The plugin emits to Claude's context:

```json
{
  "method": "notifications/claude/channel",
  "params": {
    "content": "<the JSON line verbatim>",
    "meta": {
      "chat_id": "<per-connection UUID>",
      "message_id": "m1776882557921-1",
      "user": "socketchat",
      "ts": "2026-04-22T17:10:00.000Z"
    }
  },
  "jsonrpc": "2.0"
}
```

Claude Code renders this as a `<channel source="socketchat" chat_id="..." message_id="..." user="socketchat" ts="...">…</channel>` tag in the conversation.

## Agent-facing tools

### `reply`

```
reply(text: string, reply_to: string) → {delivered: bool, reply_to: string, reason?: string}
```

Both parameters required. `text` is treated opaquely. `reply_to` must match a pending message_id.

## Limits

Configurable via env (see [Configuration](configuration)):

| Limit | Default | Purpose |
|---|---|---|
| `MAX_CONNECTIONS` | 64 | Connection cap |
| `MAX_LINE_BYTES` | 1 MiB | Per-line ceiling |
| `IDLE_TIMEOUT_MS` | 10 min | Auto-disconnect on inactivity |
| `PENDING_TTL_MS` | 5 min | Reply deadline from the agent |
| `OUTBOUND_HIGH_WATER` | 1 MiB | Slow-reader disconnect threshold |

## Encoding quick reference

| Thing | Value |
|---|---|
| Framing | `\n`-delimited, one JSON object per line |
| Charset | UTF-8 |
| Socket type | SOCK_STREAM |
| Directionality | Full duplex; client and server may send independently |
| Idle behaviour | Server disconnects after `IDLE_TIMEOUT_MS` with no data |
