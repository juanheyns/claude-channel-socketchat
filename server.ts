#!/usr/bin/env bun
/**
 * Unix socket channel MCP plugin for Claude Code.
 *
 * Each plugin instance binds a Unix socket at
 *   ~/.claude/channels/socketchat/sessions/<instance-id>.sock
 * and advertises itself in
 *   ~/.claude/channels/socketchat/index.json
 *
 * External processes connect, send NDJSON lines, receive NDJSON replies.
 * Each inbound line becomes a <channel> event in the Claude session.
 * The agent replies with the `reply` tool; replies route back to the
 * originating connection via the message_id.
 *
 * Schema-agnostic: message bodies are application-defined. The plugin
 * handles transport, routing, and lifecycle; applications define meaning.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createServer, type Socket } from 'net'
import {
  mkdirSync, chmodSync, unlinkSync, writeFileSync, readFileSync, renameSync, readdirSync,
  createWriteStream, type WriteStream,
} from 'fs'
import { homedir } from 'os'
import { join, dirname } from 'path'
import { randomUUID } from 'crypto'

// ---------- config ----------

const STATE_DIR = process.env.SOCKET_CHAT_DIR ?? join(homedir(), '.claude', 'channels', 'socketchat')
const SESSIONS_DIR = join(STATE_DIR, 'sessions')
const INDEX_PATH = join(STATE_DIR, 'index.json')

const INSTANCE_ID = (() => {
  const override = process.env.SOCKET_CHAT_INSTANCE_ID
  if (override && /^[A-Za-z0-9._-]{1,128}$/.test(override)) return override
  if (override) process.stderr.write(`socketchat: ignoring invalid SOCKET_CHAT_INSTANCE_ID (allowed: [A-Za-z0-9._-], 1-128 chars)\n`)
  return randomUUID()
})()
const SOCKET_PATH = join(SESSIONS_DIR, `${INSTANCE_ID}.sock`)
const LOCK_PATH = `${SOCKET_PATH}.lock`

const MAX_CONNECTIONS = Number(process.env.SOCKET_CHAT_MAX_CONNECTIONS ?? 64)
const MAX_LINE_BYTES = Number(process.env.SOCKET_CHAT_MAX_LINE_BYTES ?? 1024 * 1024)
const IDLE_TIMEOUT_MS = Number(process.env.SOCKET_CHAT_IDLE_TIMEOUT_MS ?? 10 * 60 * 1000)
const PENDING_TTL_MS = Number(process.env.SOCKET_CHAT_PENDING_TTL_MS ?? 5 * 60 * 1000)
const OUTBOUND_HIGH_WATER = Number(process.env.SOCKET_CHAT_OUTBOUND_HIGH_WATER ?? 1024 * 1024)
const WATCHDOG_INTERVAL_MS = 5000

const LOG_PATH = process.env.SOCKET_CHAT_LOG_FILE ?? join(STATE_DIR, 'logs', `${INSTANCE_ID}.log`)

// ---------- logging ----------

let logStream: WriteStream | null = null
function openLog() {
  try {
    mkdirSync(dirname(LOG_PATH), { recursive: true, mode: 0o770 })
    logStream = createWriteStream(LOG_PATH, { flags: 'a', mode: 0o660 })
  } catch (err) {
    process.stderr.write(`socketchat: log file open failed: ${String(err)}\n`)
  }
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: Record<string, unknown>) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, instance: INSTANCE_ID, ...extra }) + '\n'
  try { process.stderr.write(line) } catch {}
  try { logStream?.write(line) } catch {}
}

// ---------- atomic file helpers ----------

function atomicWrite(path: string, data: string) {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`
  writeFileSync(tmp, data, { mode: 0o660 })
  renameSync(tmp, path)
}

function tryUnlink(path: string) {
  try { unlinkSync(path) } catch {}
}

// ---------- lockfile ----------

function writeLock() {
  writeFileSync(LOCK_PATH, String(process.pid), { mode: 0o660 })
}

function releaseLock() {
  tryUnlink(LOCK_PATH)
}

// Sweep stale socket/lock files from previous runs whose PID is gone.
function sweepStale() {
  let entries: string[] = []
  try { entries = readdirSync(SESSIONS_DIR) } catch { return }
  for (const entry of entries) {
    if (!entry.endsWith('.lock')) continue
    const lockPath = join(SESSIONS_DIR, entry)
    if (lockPath === LOCK_PATH) continue
    let pid = 0
    try { pid = Number(readFileSync(lockPath, 'utf8').trim()) } catch { continue }
    if (!pid) continue
    try { process.kill(pid, 0); continue } catch {} // alive, skip
    // stale — remove lock and its companion socket
    tryUnlink(lockPath)
    tryUnlink(lockPath.replace(/\.lock$/, ''))
    log('info', 'swept stale instance', { pid, lock: lockPath })
  }
}

// ---------- index.json ----------

type IndexEntry = {
  id: string
  socket: string
  pid: number
  ppid: number
  cwd: string
  started_at: string
}

function readIndex(): { sessions: IndexEntry[] } {
  try { return JSON.parse(readFileSync(INDEX_PATH, 'utf8')) } catch {}
  return { sessions: [] }
}

function writeIndex(idx: { sessions: IndexEntry[] }) {
  atomicWrite(INDEX_PATH, JSON.stringify(idx, null, 2))
}

function withIndex<T>(mutate: (idx: { sessions: IndexEntry[] }) => T): T {
  const idx = readIndex()
  // purge dead entries whenever we touch the index
  idx.sessions = idx.sessions.filter(s => {
    try { process.kill(s.pid, 0); return true } catch { return false }
  })
  const result = mutate(idx)
  writeIndex(idx)
  return result
}

function addToIndex() {
  withIndex(idx => {
    idx.sessions.push({
      id: INSTANCE_ID,
      socket: SOCKET_PATH,
      pid: process.pid,
      ppid: process.ppid,
      cwd: process.cwd(),
      started_at: new Date().toISOString(),
    })
  })
}

function removeFromIndex() {
  try {
    withIndex(idx => {
      idx.sessions = idx.sessions.filter(s => s.id !== INSTANCE_ID)
    })
  } catch (err) {
    log('warn', 'removeFromIndex failed', { err: String(err) })
  }
}

// ---------- routing state ----------

type Pending = { socket: Socket; timer: ReturnType<typeof setTimeout> }

const connections = new Map<Socket, string>() // socket -> connection-id (chat_id)
const pending = new Map<string, Pending>()    // message_id -> client socket
let msgSeq = 0

function nextMessageId() {
  return `m${Date.now()}-${++msgSeq}`
}

function dropPending(messageId: string) {
  const p = pending.get(messageId)
  if (!p) return
  clearTimeout(p.timer)
  pending.delete(messageId)
}

// ---------- socket I/O ----------

function writeLine(sock: Socket, obj: unknown): boolean {
  if (sock.destroyed || !sock.writable) return false
  if (sock.writableLength > OUTBOUND_HIGH_WATER) {
    log('warn', 'slow reader, disconnecting', { chat_id: connections.get(sock) })
    sock.destroy()
    return false
  }
  try {
    sock.write(JSON.stringify(obj) + '\n')
    return true
  } catch (err) {
    log('warn', 'write failed', { err: String(err) })
    return false
  }
}

function handleLine(sock: Socket, line: string) {
  const trimmed = line.trim()
  if (!trimmed) return

  let parsed: unknown
  try { parsed = JSON.parse(trimmed) } catch {
    writeLine(sock, { type: 'error', reason: 'invalid_json' })
    return
  }

  // Server-side health check — does not go to Claude.
  if (parsed && typeof parsed === 'object' && (parsed as { type?: unknown }).type === 'ping') {
    writeLine(sock, { type: 'pong', ts: new Date().toISOString() })
    return
  }

  // Everything else is a channel message.
  const messageId = nextMessageId()
  const chatId = connections.get(sock) ?? 'unknown'
  const timer = setTimeout(() => {
    if (!pending.has(messageId)) return
    pending.delete(messageId)
    writeLine(sock, { type: 'error', reason: 'reply_timeout', message_id: messageId })
  }, PENDING_TTL_MS)
  pending.set(messageId, { socket: sock, timer })

  // Ack the sender with the assigned message_id so they can correlate replies.
  writeLine(sock, { type: 'ack', message_id: messageId })

  log('info', 'message_in', { chat_id: chatId, message_id: messageId, bytes: trimmed.length })

  // Deliver to Claude as a channel notification.
  deliverToClaude(messageId, chatId, JSON.stringify(parsed))
}

function onConnection(sock: Socket) {
  if (connections.size >= MAX_CONNECTIONS) {
    log('warn', 'max connections reached, rejecting')
    try { sock.end(JSON.stringify({ type: 'error', reason: 'max_connections' }) + '\n') } catch {}
    sock.destroy()
    return
  }
  const chatId = randomUUID()
  connections.set(sock, chatId)
  sock.setTimeout(IDLE_TIMEOUT_MS)
  log('info', 'connection_open', { chat_id: chatId, total: connections.size })

  let buf = Buffer.alloc(0)

  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    if (buf.length > MAX_LINE_BYTES) {
      log('warn', 'line too long, closing', { chat_id: chatId })
      sock.destroy()
      return
    }
    let idx: number
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const line = buf.subarray(0, idx).toString('utf8')
      buf = buf.subarray(idx + 1)
      handleLine(sock, line)
    }
  })

  sock.on('timeout', () => { log('info', 'idle timeout', { chat_id: chatId }); sock.destroy() })
  sock.on('error', err => log('warn', 'socket error', { chat_id: chatId, err: err.message }))
  sock.on('close', () => {
    connections.delete(sock)
    for (const [mid, p] of pending) {
      if (p.socket === sock) dropPending(mid)
    }
    log('info', 'connection_close', { chat_id: chatId, total: connections.size })
  })
}

// ---------- MCP server ----------

const mcp = new Server(
  { name: 'socketchat', version: '0.0.1' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions:
      'Messages from external processes arrive as <channel source="socketchat" chat_id="<connection-id>" message_id="..."> tags. ' +
      'Each message is a discrete request that expects a single reply. Reply via the `reply` tool, passing the message_id as reply_to. ' +
      'Replies route back to the exact process that sent the message. ' +
      'If the tool result indicates delivered:false (client_disconnected or unknown_or_expired_message_id), the sender did not receive the reply. ' +
      'The plugin is schema-agnostic: message bodies are application-defined JSON.',
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description:
        'Reply to a channel message. Routes back to the connection that originated it. ' +
        'Both text and reply_to are required. Returns {delivered, reason?}.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Reply payload (typically JSON-stringified, app-defined schema).' },
          reply_to: { type: 'string', description: 'The message_id from the <channel> tag being replied to.' },
        },
        required: ['text', 'reply_to'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  if (req.params.name !== 'reply') {
    return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
  }
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  const text = typeof args.text === 'string' ? args.text : ''
  const replyTo = typeof args.reply_to === 'string' ? args.reply_to : ''
  if (!text || !replyTo) {
    return { content: [{ type: 'text', text: 'missing text or reply_to' }], isError: true }
  }
  const p = pending.get(replyTo)
  if (!p) {
    log('info', 'reply', { reply_to: replyTo, delivered: false, reason: 'unknown_or_expired_message_id' })
    return { content: [{ type: 'text', text: JSON.stringify({ delivered: false, reason: 'unknown_or_expired_message_id' }) }] }
  }
  if (p.socket.destroyed) {
    dropPending(replyTo)
    log('info', 'reply', { reply_to: replyTo, delivered: false, reason: 'client_disconnected' })
    return { content: [{ type: 'text', text: JSON.stringify({ delivered: false, reason: 'client_disconnected' }) }] }
  }
  const chatId = connections.get(p.socket)
  const ok = writeLine(p.socket, { type: 'reply', reply_to: replyTo, text })
  dropPending(replyTo)
  log('info', 'reply', { reply_to: replyTo, chat_id: chatId, delivered: ok, bytes: text.length, reason: ok ? undefined : 'write_failed' })
  return {
    content: [{ type: 'text', text: JSON.stringify(ok ? { delivered: true, reply_to: replyTo } : { delivered: false, reason: 'write_failed' }) }],
  }
})

function deliverToClaude(messageId: string, chatId: string, body: string) {
  void mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: body,
      meta: {
        chat_id: chatId,
        message_id: messageId,
        user: 'socketchat',
        ts: new Date().toISOString(),
      },
    },
  }).catch(err => log('warn', 'notification failed', { err: String(err) }))
}

// ---------- lifecycle ----------

let shuttingDown = false
const intervals: ReturnType<typeof setInterval>[] = []

async function shutdown(reason: string) {
  if (shuttingDown) return
  shuttingDown = true
  log('info', 'shutting down', { reason })

  for (const t of intervals) clearInterval(t)
  try { server.close() } catch {}

  for (const sock of connections.keys()) {
    try { writeLine(sock, { type: 'server_shutdown', reason }) } catch {}
    try { sock.end() } catch {}
  }

  // Short drain window before hard-close.
  await new Promise(r => setTimeout(r, 250))
  for (const sock of connections.keys()) {
    try { sock.destroy() } catch {}
  }

  for (const [, p] of pending) clearTimeout(p.timer)
  pending.clear()

  removeFromIndex()
  tryUnlink(SOCKET_PATH)
  releaseLock()

  log('info', 'stopped', { reason, uptime_s: Math.round(process.uptime()) })
  try { logStream?.end() } catch {}

  process.exit(0)
}

// Orphan watchdog: if parent (Claude) dies, our ppid becomes 1 (reparented to init),
// or stdin gets destroyed. Either way, self-terminate.
const originalPpid = process.ppid
function watchdog() {
  if (shuttingDown) return
  // Reparented?
  if (process.ppid !== originalPpid && process.ppid === 1) {
    void shutdown('parent_died')
    return
  }
  // Stdin closed?
  if (process.stdin.destroyed || process.stdin.readableEnded) {
    void shutdown('stdin_closed')
    return
  }
}

process.on('SIGINT', () => void shutdown('sigint'))
process.on('SIGTERM', () => void shutdown('sigterm'))
process.on('SIGHUP', () => void shutdown('sighup'))
process.on('unhandledRejection', (err) => log('error', 'unhandled rejection', { err: String(err) }))
process.on('uncaughtException', (err) => log('error', 'uncaught exception', { err: String(err) }))
process.stdin.on('end', () => void shutdown('stdin_end'))
process.stdin.on('close', () => void shutdown('stdin_close'))

// ---------- startup ----------

mkdirSync(SESSIONS_DIR, { recursive: true, mode: 0o770 })
try { chmodSync(STATE_DIR, 0o770) } catch {}
try { chmodSync(SESSIONS_DIR, 0o770) } catch {}

openLog()

// Only SOCKET_CHAT_* env vars — avoid leaking unrelated secrets into the log.
const envSnapshot = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => k.startsWith('SOCKET_CHAT_'))
)

log('info', 'boot', {
  pid: process.pid,
  ppid: process.ppid,
  cwd: process.cwd(),
  log_file: LOG_PATH,
  socket: SOCKET_PATH,
  env: envSnapshot,
  config: {
    MAX_CONNECTIONS, MAX_LINE_BYTES, IDLE_TIMEOUT_MS, PENDING_TTL_MS, OUTBOUND_HIGH_WATER,
  },
})

sweepStale()

// Our socket path is UUID-unique; a stale file at this exact path is vanishingly
// unlikely, but handle it defensively.
tryUnlink(SOCKET_PATH)
tryUnlink(LOCK_PATH)
writeLock()

const server = createServer(onConnection)
server.on('error', err => log('error', 'server error', { err: String(err) }))

await new Promise<void>((resolve, reject) => {
  server.once('error', reject)
  server.listen(SOCKET_PATH, () => {
    try { chmodSync(SOCKET_PATH, 0o660) } catch (err) { log('warn', 'chmod socket failed', { err: String(err) }) }
    resolve()
  })
})

addToIndex()
log('info', 'listening', { socket: SOCKET_PATH, pid: process.pid, ppid: process.ppid })

intervals.push(setInterval(watchdog, WATCHDOG_INTERVAL_MS))

await mcp.connect(new StdioServerTransport())
log('info', 'mcp_connected')
