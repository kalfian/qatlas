// QAtlas runner — long-lived process driven by the Go worker over NDJSON (docs/13).
//   stdin : {"type":"run.start",…} | {"type":"run.cancel","run_id":…}   (one JSON object per line)
//   stdout: events, one JSON object per line            stderr: logs
// Shutdown: stdin EOF → finish in-flight runs, then exit. SIGTERM/SIGINT or a broken stdout →
// cancel in-flight runs, close browsers, exit.

import { createRequire } from 'node:module'
import { createInterface } from 'node:readline'
import { BrowserPool } from './browsers.js'
import { emit, onStdoutBroken } from './emitter.js'
import { log } from './log.js'
import type { InboundMessage, RunStartMessage } from './protocol.js'
import { RunExecution, validateRunStart } from './run.js'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_VERSION: string = (require('playwright/package.json') as { version: string }).version

const pool = new BrowserPool()
const runs = new Map<string, { exec: RunExecution; done: Promise<unknown> }>()
let shuttingDown = false

function startRun(msg: RunStartMessage): void {
  const invalid = validateRunStart(msg)
  const runId = typeof msg.run_id === 'string' && msg.run_id ? msg.run_id : null
  if (invalid) {
    log.warn('rejected run.start', { run_id: runId, reason: invalid })
    emit({ type: 'runner.error', run_id: runId, message: invalid })
    if (runId && !runs.has(runId)) emit({ type: 'run.finished', run_id: runId, status: 'error' })
    return
  }
  if (runs.has(msg.run_id)) {
    emit({ type: 'runner.error', run_id: msg.run_id, message: `run.start: run ${msg.run_id} is already running in this runner` })
    return
  }
  if (shuttingDown) {
    emit({ type: 'runner.error', run_id: msg.run_id, message: 'Runner is shutting down; run not started' })
    emit({ type: 'run.finished', run_id: msg.run_id, status: 'error' })
    return
  }
  const exec = new RunExecution(msg, pool)
  log.info('run started', { run_id: msg.run_id, cases: msg.cases.length, browser: msg.options?.browser ?? 'chromium' })
  const done = exec
    .execute()
    .then((status) => log.info('run finished', { run_id: msg.run_id, status }))
    .finally(() => runs.delete(msg.run_id))
  runs.set(msg.run_id, { exec, done })
}

function handleLine(line: string): void {
  const text = line.trim()
  if (!text) return
  let msg: InboundMessage
  try {
    msg = JSON.parse(text) as InboundMessage
  } catch (err) {
    emit({ type: 'runner.error', run_id: null, message: `Invalid JSON on stdin: ${(err as Error).message}` })
    return
  }
  if (!msg || typeof msg !== 'object') {
    emit({ type: 'runner.error', run_id: null, message: 'Invalid message: expected a JSON object' })
    return
  }
  switch (msg.type) {
    case 'run.start':
      startRun(msg)
      return
    case 'run.cancel': {
      const r = runs.get(msg.run_id)
      if (r) r.exec.cancel()
      else log.warn('run.cancel for unknown run (already finished?)', { run_id: msg.run_id })
      return
    }
    default: {
      const runId = typeof (msg as { run_id?: unknown }).run_id === 'string' ? (msg as { run_id: string }).run_id : null
      emit({ type: 'runner.error', run_id: runId, message: `Unknown message type "${String((msg as { type?: unknown }).type)}"` })
    }
  }
}

async function shutdown(reason: string, cancel: boolean, code = 0): Promise<void> {
  if (shuttingDown && cancel) {
    // second signal: give up waiting
    log.warn('forced exit', { reason })
    process.exit(code || 1)
  }
  shuttingDown = true
  log.info('shutting down', { reason, in_flight: runs.size })
  if (cancel) for (const r of runs.values()) r.exec.cancel()
  const pending = Promise.allSettled([...runs.values()].map((r) => r.done))
  if (cancel) await Promise.race([pending, new Promise((res) => setTimeout(res, 10_000))])
  else await pending
  await Promise.race([pool.closeAll(), new Promise((res) => setTimeout(res, 10_000))])
  log.info('bye')
  // Let stdout flush before exiting.
  process.stdout.write('', () => process.exit(code))
}

process.on('SIGTERM', () => void shutdown('SIGTERM', true))
process.on('SIGINT', () => void shutdown('SIGINT', true))
onStdoutBroken(() => void shutdown('stdout closed', true))

process.on('unhandledRejection', (reason) => {
  const message = reason instanceof Error ? reason.message : String(reason)
  log.error('unhandled rejection', { error: reason instanceof Error ? reason.stack : message })
  emit({ type: 'runner.error', run_id: null, message: `Runner error: ${message}` })
})
process.on('uncaughtException', (err) => {
  log.error('uncaught exception', { error: err.stack })
  emit({ type: 'runner.error', run_id: null, message: `Runner crashed: ${err.message}` })
  void shutdown('uncaughtException', true, 1)
})

emit({ type: 'ready', playwright: PLAYWRIGHT_VERSION })
log.info('runner ready', { playwright: PLAYWRIGHT_VERSION, pid: process.pid })

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', handleLine)
rl.on('close', () => void shutdown('stdin closed', false))
