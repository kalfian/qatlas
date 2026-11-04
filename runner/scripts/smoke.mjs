#!/usr/bin/env node
// End-to-end smoke test: starts demo-target (unless BASE_URL is set), spawns the built runner,
// sends one run.start and prints every NDJSON event the runner emits (stdout of this script).
//
//   corepack pnpm --filter @qatlas/runner build
//   node runner/scripts/smoke.mjs [case] [--video] [--every-step] [--headed] [--list]
//     case: one of the keys of SHOP_CASES (default: login); --list prints them.
//   BASE_URL=http://localhost:8099 node runner/scripts/smoke.mjs voucher   # use a running demo-target
//
// Exit code: 0 when run.finished arrived (whatever its status), 1 otherwise.

import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { SHOP_CASES, runStart } from './shop-cases.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runnerMain = join(here, '..', 'dist', 'main.js')
const demoServer = join(here, '..', '..', 'demo-target', 'server.mjs')

const args = process.argv.slice(2)
if (args.includes('--list')) {
  console.log(Object.keys(SHOP_CASES).join('\n'))
  process.exit(0)
}
const caseName = args.find((a) => !a.startsWith('--')) ?? 'login'
if (!SHOP_CASES[caseName]) {
  console.error(`Unknown case "${caseName}". Available: ${Object.keys(SHOP_CASES).join(', ')}`)
  process.exit(2)
}

async function startDemo() {
  const child = spawn(process.execPath, [demoServer], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit'] })
  const rl = createInterface({ input: child.stdout })
  const url = await new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      const m = /listening on (http:\/\/\S+)/.exec(line)
      if (m) resolve(m[1].replace('127.0.0.1', 'localhost'))
      else reject(new Error(`unexpected demo-target output: ${line}`))
    })
    child.once('exit', (code) => reject(new Error(`demo-target exited (${code})`)))
  })
  return { child, url }
}

const demo = process.env.BASE_URL ? null : await startDemo()
const baseUrl = process.env.BASE_URL ?? demo.url
const artifactDir = mkdtempSync(join(tmpdir(), 'qatlas-smoke-'))
console.error(`# target ${baseUrl}  artifacts ${artifactDir}`)

const runner = spawn(process.execPath, [runnerMain], { stdio: ['pipe', 'pipe', 'inherit'] })
const events = createInterface({ input: runner.stdout })
let finished = false

events.on('line', (line) => {
  console.log(line)
  const ev = JSON.parse(line)
  if (ev.type === 'ready') {
    const msg = runStart({
      runId: `smoke-${Date.now()}`,
      artifactDir,
      baseUrl,
      cases: [SHOP_CASES[caseName]()],
      options: {
        headless: !args.includes('--headed'),
        video: args.includes('--video') ? 'always' : 'off',
        screenshot: args.includes('--every-step') ? 'every_step' : 'on_failure',
      },
    })
    runner.stdin.write(JSON.stringify(msg) + '\n')
  }
  if (ev.type === 'run.finished') {
    finished = true
    runner.stdin.end() // EOF → runner exits after in-flight runs
  }
})

runner.on('exit', (code) => {
  demo?.child.kill('SIGTERM')
  console.error(`# runner exited with ${code}; artifacts in ${artifactDir}`)
  process.exit(finished ? 0 : 1)
})
