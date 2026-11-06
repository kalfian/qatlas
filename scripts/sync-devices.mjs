#!/usr/bin/env node
// Copies the device catalog (api/devices.json, the single source; docs/14-responsive-testing.md)
// to the Go backend (embedded) and the web app. `--check` exits 1 when a copy is out of date.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = readFileSync(join(root, 'api/devices.json'), 'utf8')
JSON.parse(source) // fail loudly on a broken catalog
const targets = ['backend/internal/devices/devices.json', 'web/src/lib/devices.json']
const check = process.argv.includes('--check')
let stale = 0
for (const t of targets) {
  const path = join(root, t)
  let current = null
  try {
    current = readFileSync(path, 'utf8')
  } catch {}
  if (current === source) continue
  if (check) {
    console.error(`${t} differs from api/devices.json: run node scripts/sync-devices.mjs`)
    stale++
  } else {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, source)
    console.log(`wrote ${t}`)
  }
}
process.exit(stale ? 1 : 0)
