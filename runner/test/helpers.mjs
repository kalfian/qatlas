import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
export const RUNNER_MAIN = join(here, '..', 'dist', 'main.js')
export const DEMO_SERVER = join(here, '..', '..', 'demo-target', 'server.mjs')

/** Start demo-target on a random free port. */
export async function startDemo(env = {}) {
  const child = spawn(process.execPath, [DEMO_SERVER], { env: { ...process.env, PORT: '0', ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const rl = createInterface({ input: child.stdout })
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('demo-target did not start')), 10_000)
    rl.once('line', (line) => {
      clearTimeout(timer)
      const m = /listening on (http:\/\/\S+)/.exec(line)
      if (m) resolve(m[1].replace('127.0.0.1', 'localhost'))
      else reject(new Error(`unexpected demo-target output: ${line}`))
    })
    child.once('exit', (code) => reject(new Error(`demo-target exited early (${code})`)))
  })
  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve()
        child.once('exit', resolve)
        child.kill('SIGTERM')
      }),
  }
}

export function tempDir(prefix = 'qatlas-runner-test-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A runner child process with an event log and helpers to await events. */
export class Runner {
  constructor(env = {}) {
    this.events = []
    this.rawLines = []
    this.stderr = ''
    this.waiters = []
    this.child = spawn(process.execPath, [RUNNER_MAIN], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', (d) => (this.stderr += d.toString()))
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.rawLines.push(line)
      const ev = JSON.parse(line) // every stdout line must be valid JSON
      this.events.push(ev)
      for (const w of [...this.waiters]) w.check()
    })
    this.exited = new Promise((resolve) => this.child.once('exit', (code, signal) => resolve({ code, signal })))
  }

  send(msg) {
    this.child.stdin.write(JSON.stringify(msg) + '\n')
  }

  sendRaw(line) {
    this.child.stdin.write(line + '\n')
  }

  /** Resolve with the first event matching pred (already received or future). */
  waitFor(pred, timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const w = {
        check: () => {
          const ev = this.events.find(pred)
          if (ev) {
            clearTimeout(timer)
            this.waiters.splice(this.waiters.indexOf(w), 1)
            resolve(ev)
          }
        },
      }
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(w), 1)
        reject(new Error(`timeout waiting for event; got:\n${this.rawLines.join('\n')}\nstderr:\n${this.stderr}`))
      }, timeoutMs)
      this.waiters.push(w)
      w.check()
    })
  }

  ready() {
    return this.waitFor((e) => e.type === 'ready')
  }

  /** Send run.start and resolve with all events of that run once run.finished arrives. */
  async run(msg, timeoutMs = 90_000) {
    this.send(msg)
    await this.waitFor((e) => e.type === 'run.finished' && e.run_id === msg.run_id, timeoutMs)
    return this.events.filter((e) => e.run_id === msg.run_id)
  }

  async close() {
    if (this.child.exitCode === null) this.child.stdin.end()
    const t = setTimeout(() => this.child.kill('SIGKILL'), 20_000)
    const res = await this.exited
    clearTimeout(t)
    return res
  }
}

export const stepEvents = (events, caseId) => events.filter((e) => e.type === 'step.finished' && e.case_id === caseId)
export const byType = (events, type) => events.filter((e) => e.type === type)
