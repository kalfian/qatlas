#!/usr/bin/env node
// Regenerates backend/internal/seed/demo.json (the fixture of `qatlas seed demo`) from the web mock
// seed web/src/mocks/seed.ts, so mock mode and the real demo share the same users, projects,
// environments, folders, test cases and flows.
//
//   node scripts/export-demo-seed.mjs > backend/internal/seed/demo.json
//   node scripts/export-demo-seed.mjs --bundle /path/seed.bundle.mjs   # use an existing ESM bundle
//
// Without --bundle, seed.ts is bundled first with the workspace's esbuild binary
// (node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild, installed by `pnpm install`)
// into a temporary directory that is removed afterwards.
//
// Only stable, environment-independent fields are exported. Values that differ between mock and
// real mode (BASE_URL/API_URL/MAILPIT_URL of SHOP staging, secret values) are set by the Go seed
// (backend/internal/seed/seed.go, `qatlas seed demo` flags), not here. After regenerating, run
// `go test ./internal/seed/...` in backend/ (with QATLAS_TEST_DATABASE_URL) — it pins counts,
// folders and environments.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

function esbuildBinary() {
  const store = join(ROOT, 'node_modules/.pnpm')
  const versions = readdirSync(store)
    .filter((d) => /^esbuild@\d/.test(d))
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!versions.length) throw new Error(`no esbuild in ${store} — run "corepack pnpm install" first`)
  return join(store, versions.at(-1), 'node_modules/esbuild/bin/esbuild')
}

function bundleSeed(outFile) {
  execFileSync(
    esbuildBinary(),
    [
      join(ROOT, 'web/src/mocks/seed.ts'),
      '--bundle',
      '--format=esm',
      '--platform=node',
      `--tsconfig=${join(ROOT, 'web/tsconfig.app.json')}`, // resolves the "@/…" path alias
      `--outfile=${outFile}`,
      '--log-level=warning',
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  )
}

const args = process.argv.slice(2)
const bundleArg = args.indexOf('--bundle')
let bundle
let tmp
if (bundleArg >= 0) {
  bundle = args[bundleArg + 1]
  if (!bundle) throw new Error('--bundle needs a file')
} else {
  tmp = mkdtempSync(join(tmpdir(), 'qatlas-seed-'))
  bundle = join(tmp, 'seed.bundle.mjs')
  bundleSeed(bundle)
}

try {
  const { buildSeed } = await import(pathToFileURL(bundle).href)
  const s = buildSeed()
  const byId = (id) => s.folders.find((f) => f.id === id)
  const folderPath = (id) => {
    const f = byId(id)
    if (!f) return null
    const parent = f.parent_id ? folderPath(f.parent_id) : null
    return parent ? `${parent}/${f.name}` : f.name
  }
  const emailOf = (id) => s.users.find((u) => u.id === id).email
  const caseKey = (id) => s.testCases.find((t) => t.id === id).key
  const out = {
    users: s.users
      .filter((u) => u.status !== 'disabled')
      .map((u) => ({ email: u.email, name: u.name, system_role: u.system_role, status: u.status })),
    projects: s.projects.map((p) => ({
      key: p.key,
      name: p.name,
      description: p.description,
      members: s.members.filter((m) => m.project_id === p.id).map((m) => ({ email: emailOf(m.user_id), role: m.role })),
      environments: s.environments
        .filter((e) => e.project_id === p.id)
        .map((e) => ({ name: e.name, is_default: e.is_default, variables: e.variables, secrets: e.secrets.map((x) => x.name) })),
      folders: s.folders.filter((f) => f.project_id === p.id).map((f) => folderPath(f.id)),
      test_cases: s.testCases
        .filter((t) => t.project_id === p.id)
        .map((t) => ({
          key: t.key,
          folder: folderPath(t.folder_id),
          title: t.title,
          description: t.description,
          preconditions: t.preconditions,
          priority: t.priority,
          status: t.status,
          execution: t.execution,
          tags: t.tags,
          variables: t.variables,
          steps: t.steps,
        })),
      flows: s.flows
        .filter((f) => f.project_id === p.id)
        .map((f) => ({
          key: f.key,
          name: f.name,
          description: f.description,
          tags: f.tags,
          shared_session: f.shared_session,
          stop_on_failure: f.stop_on_failure,
          variables: f.variables,
          items: f.items.map((i) => ({ test_case: caseKey(i.test_case_id), continue_on_failure: i.continue_on_failure })),
        })),
    })),
  }
  process.stdout.write(JSON.stringify(out, null, 2) + '\n')
} finally {
  if (tmp) rmSync(tmp, { recursive: true, force: true })
}
