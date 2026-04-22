#!/usr/bin/env bun
/**
 * CLI client for the socketchat channel plugin.
 *
 *   client.ts ls [pattern] [--json]
 *   client.ts send [target] <json|-> [--no-wait] [--timeout SECS]
 *   client.ts chat [target]
 *
 * target: instance id (exact or unique prefix) or cwd substring.
 *         Omit if exactly one session is active.
 */

import { connect, type Socket } from 'net'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { createInterface } from 'readline'

const STATE_DIR = process.env.SOCKET_CHAT_DIR ?? join(homedir(), '.claude', 'channels', 'socketchat')
const INDEX_PATH = join(STATE_DIR, 'index.json')
const LOGS_DIR = join(STATE_DIR, 'logs')

type Entry = { id: string; socket: string; pid: number; ppid: number; cwd: string; started_at: string }

// ---------- helpers ----------

function die(msg: string, code = 1): never {
  process.stderr.write(msg + '\n')
  process.exit(code)
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readIndex(): Entry[] {
  try {
    const raw = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
    const sessions: Entry[] = Array.isArray(raw?.sessions) ? raw.sessions : []
    return sessions.filter(e => isAlive(e.pid))
  } catch { return [] }
}

function pickEntry(target?: string): Entry {
  const entries = readIndex()
  if (!entries.length) die('no active sessions')
  if (!target) {
    if (entries.length === 1) return entries[0]!
    die(`multiple sessions (${entries.length}); specify a target:\n` +
      entries.map(e => `  ${e.id}  cwd=${e.cwd}`).join('\n'))
  }
  const exact = entries.filter(e => e.id === target)
  if (exact.length === 1) return exact[0]!
  const prefix = entries.filter(e => e.id.startsWith(target))
  if (prefix.length === 1) return prefix[0]!
  if (prefix.length > 1) die(
    `ambiguous id prefix "${target}":\n` + prefix.map(e => `  ${e.id}`).join('\n'))
  const cwd = entries.filter(e => e.cwd.includes(target))
  if (cwd.length === 1) return cwd[0]!
  if (cwd.length > 1) die(
    `ambiguous cwd match "${target}":\n` + cwd.map(e => `  ${e.id}  cwd=${e.cwd}`).join('\n'))
  die(`no session matches "${target}"`)
}

function prettyAge(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function openConn(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath, () => resolve(sock))
    sock.once('error', reject)
  })
}

function onLines(sock: Socket, cb: (obj: unknown, raw: string) => void): void {
  let buf = Buffer.alloc(0)
  sock.on('data', chunk => {
    buf = Buffer.concat([buf, chunk])
    let idx: number
    while ((idx = buf.indexOf(0x0a)) !== -1) {
      const raw = buf.subarray(0, idx).toString('utf8')
      buf = buf.subarray(idx + 1)
      let obj: unknown
      try { obj = JSON.parse(raw) } catch { obj = undefined }
      cb(obj, raw)
    }
  })
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

// ---------- commands ----------

function cmdList(args: string[]) {
  const json = args.includes('--json')
  const pattern = args.find(a => !a.startsWith('--'))
  let entries = readIndex()
  if (pattern) entries = entries.filter(e => e.id.includes(pattern) || e.cwd.includes(pattern))
  if (json) { process.stdout.write(JSON.stringify(entries, null, 2) + '\n'); return }
  if (!entries.length) { process.stdout.write('no active sessions\n'); return }
  for (const e of entries) {
    process.stdout.write(`${e.id}\t${prettyAge(e.started_at)}\tpid=${e.pid}\tcwd=${e.cwd}\n`)
  }
}

async function cmdSend(args: string[]) {
  let timeoutS = 60
  let noWait = false
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--no-wait') noWait = true
    else if (a === '--timeout') timeoutS = Number(args[++i])
    else positional.push(a)
  }
  if (positional.length === 0) die('usage: send [target] <json|->')
  const [target, body] =
    positional.length === 1 ? [undefined, positional[0]!] : [positional[0]!, positional[1]!]
  const input = (body === '-' ? readFileSync(0, 'utf8') : body).trim()
  try { JSON.parse(input) } catch { die('invalid JSON body') }

  const entry = pickEntry(target)
  let sock: Socket
  try { sock = await openConn(entry.socket) }
  catch (err: any) { die('connect failed: ' + err.message) }

  let messageId: string | null = null
  let resolved = false
  const result = await new Promise<{ ok: boolean; output?: string }>(resolve => {
    const finish = (r: { ok: boolean; output?: string }) => {
      if (resolved) return
      resolved = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => finish({ ok: false, output: 'timeout' }), timeoutS * 1000)
    onLines(sock, (msg: any) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ack') {
        messageId = msg.message_id
        if (noWait) finish({ ok: true, output: `ack ${messageId}` })
      } else if (msg.type === 'reply' && msg.reply_to === messageId) {
        finish({ ok: true, output: prettyJson(msg.text) })
      } else if (msg.type === 'error') {
        finish({ ok: false, output: `error: ${msg.reason ?? 'unknown'}` })
      }
    })
    sock.on('error', err => finish({ ok: false, output: 'socket error: ' + err.message }))
    sock.on('close', () => finish({ ok: false, output: 'connection closed' }))
    sock.write(input + '\n')
  })
  sock.end()
  if (result.output) (result.ok ? process.stdout : process.stderr).write(result.output + '\n')
  if (!result.ok) process.exit(1)
}

function cmdLog(args: string[]) {
  const follow = args.includes('-f') || args.includes('--follow')
  const target = args.find(a => !a.startsWith('-'))
  const entry = pickEntry(target)
  const path = join(LOGS_DIR, `${entry.id}.log`)
  process.stderr.write(`log file: ${path}\n`)
  const { spawn } = require('child_process') as typeof import('child_process')
  const proc = spawn('tail', follow ? ['-n', '+1', '-F', path] : ['-n', '+1', path], { stdio: 'inherit' })
  proc.on('exit', code => process.exit(code ?? 0))
}

async function cmdPing(args: string[]) {
  let timeoutS = 5
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--timeout') timeoutS = Number(args[++i])
    else positional.push(a)
  }
  const entry = pickEntry(positional[0])
  let sock: Socket
  try { sock = await openConn(entry.socket) }
  catch (err: any) { die('connect failed: ' + err.message) }

  const start = Date.now()
  const result = await new Promise<{ ok: boolean; output: string }>(resolve => {
    const timer = setTimeout(() => resolve({ ok: false, output: 'timeout' }), timeoutS * 1000)
    onLines(sock, (msg: any) => {
      if (msg?.type === 'pong') {
        clearTimeout(timer)
        resolve({ ok: true, output: `pong from ${entry.id} (${Date.now() - start}ms)` })
      }
    })
    sock.on('error', err => { clearTimeout(timer); resolve({ ok: false, output: 'socket error: ' + err.message }) })
    sock.on('close', () => { clearTimeout(timer); resolve({ ok: false, output: 'connection closed' }) })
    sock.write('{"type":"ping"}\n')
  })
  sock.end()
  ;(result.ok ? process.stdout : process.stderr).write(result.output + '\n')
  if (!result.ok) process.exit(1)
}

async function cmdChat(args: string[]) {
  const target = args.find(a => !a.startsWith('--'))
  const entry = pickEntry(target)

  process.stderr.write(`connected to ${entry.id}\n`)
  process.stderr.write(`socket:   ${entry.socket}\n`)
  process.stderr.write(`cwd:      ${entry.cwd}\n`)
  process.stderr.write(`type JSON lines; Ctrl+D to exit.\n\n`)

  let sock: Socket
  try { sock = await openConn(entry.socket) }
  catch (err: any) { die('connect failed: ' + err.message) }

  onLines(sock, (msg, raw) => {
    if (msg && typeof msg === 'object') {
      process.stdout.write('< ' + JSON.stringify(msg) + '\n')
    } else {
      process.stdout.write('< ' + raw + '\n')
    }
  })
  sock.on('close', () => { process.stderr.write('\nconnection closed\n'); process.exit(0) })
  sock.on('error', err => die('socket error: ' + err.message))

  const rl = createInterface({ input: process.stdin })
  rl.on('line', line => {
    const t = line.trim()
    if (!t) return
    try { JSON.parse(t) } catch { process.stderr.write('invalid JSON (ignored)\n'); return }
    sock.write(t + '\n')
  })
  rl.on('close', () => sock.end())
}

// ---------- dispatch ----------

const [, , cmd, ...rest] = process.argv

const usage =
  'usage: client.ts <command> [args]\n' +
  '  ls [pattern] [--json]                   list active sessions\n' +
  '  ping [target] [--timeout SECS]          server-side health check (no Claude)\n' +
  '  send [target] <json|-> [flags]          send one message (reads stdin if body is -)\n' +
  '    --no-wait        return after ack, do not wait for Claude reply\n' +
  '    --timeout SECS   abort if no reply in SECS (default 60)\n' +
  '  chat [target]                           interactive REPL\n' +
  '  log [target] [-f]                       print (or tail -F) the session log file\n' +
  '\n' +
  'target: instance id, unique prefix, or cwd substring. omit if exactly one session.\n'

if (cmd === 'ls' || cmd === 'list') cmdList(rest)
else if (cmd === 'ping') await cmdPing(rest)
else if (cmd === 'send') await cmdSend(rest)
else if (cmd === 'chat') await cmdChat(rest)
else if (cmd === 'log') cmdLog(rest)
else { process.stderr.write(usage); process.exit(cmd ? 1 : 0) }
