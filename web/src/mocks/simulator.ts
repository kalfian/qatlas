import type { RunOptions, RunTrigger, Step, StepStatus } from '@/api/types'
import { getAction, summarizeStep } from '@/lib/steps'
import {
  db,
  isFinal,
  newId,
  nowIso,
  persist,
  type DbArtifact,
  type DbEnvironment,
  type DbProject,
  type DbRun,
  type DbRunCase,
  type DbRunStep,
  type DbTestCase,
  type SimPlan,
} from './db'

/* ------------------------------------------------------------------ "aplikasi target" palsu
 * Nilai aktual untuk assertion tertentu. Jika expected tidak cocok → step gagal dengan
 * pesan expected vs actual yang realistis. Selain itu:
 *  - parameter step yang mengandung kata "fail" → gagal
 *  - test case bertag "flaky" → assertion terakhir gagal acak (±40%)
 */
const MOCK_TRUTH: Record<string, string> = {
  'testid=grand-total': 'Rp 90.000',
  'testid=cart-count': '1',
  'testid=stock-label': 'Stok: 12',
  "role=heading[name='Pesanan berhasil']": 'Pesanan berhasil',
}

export type Rng = () => number

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const between = (rng: Rng, a: number, b: number) => Math.round(a + rng() * (b - a))

function locatorExpr(selector = ''): string {
  const m = /^(role|label|placeholder|testid|text)=(.*)$/.exec(selector)
  if (!m) return `locator('${selector}')`
  const [, kind, rest] = m
  if (kind === 'role') {
    const rm = /^(\w+)(?:\[name=['"](.*)['"]\])?$/.exec(rest)
    return rm ? `getByRole('${rm[1]}'${rm[2] ? `, { name: '${rm[2]}' }` : ''})` : `getByRole('${rest}')`
  }
  const fn = { label: 'getByLabel', placeholder: 'getByPlaceholder', testid: 'getByTestId', text: 'getByText' }[kind]!
  return `${fn}('${rest}')`
}

function containsFailMarker(step: Step): boolean {
  return Object.entries(step).some(
    ([k, v]) => !['id', 'description', 'expected'].includes(k) && typeof v === 'string' && /fail/i.test(v),
  )
}

function matches(actual: string, expected: string, mode?: string): boolean {
  if (mode === 'equals') return actual === expected
  if (mode === 'regex') {
    try {
      return new RegExp(expected).test(actual)
    } catch {
      return false
    }
  }
  return actual.includes(expected)
}

function failureFor(step: Step, timeout: number, interpolated: Step): { error: string; details?: Record<string, unknown>; duration: number } {
  const sel = interpolated.selector
  switch (step.action) {
    case 'goto':
      return { error: `page.goto: net::ERR_CONNECTION_REFUSED at ${interpolated.url}`, duration: 1200 }
    case 'expect_text':
    case 'expect_value': {
      const actual = MOCK_TRUTH[sel ?? ''] ?? '(elemen tidak ditemukan)'
      return {
        error: `expect(${locatorExpr(sel)}).${step.action === 'expect_text' ? 'toHaveText' : 'toHaveValue'}() gagal\nExpected: ${step.match === 'equals' ? '' : 'mengandung '}"${interpolated.value}"\nReceived: "${actual}"`,
        details: { expected: String(interpolated.value ?? ''), actual },
        duration: timeout,
      }
    }
    case 'expect_url':
      return {
        error: `expect(page).toHaveURL() gagal\nExpected: mengandung "${interpolated.value}"\nReceived: "https://staging.tokoku.id/login?error=1"`,
        details: { expected: String(interpolated.value ?? ''), actual: 'https://staging.tokoku.id/login?error=1' },
        duration: timeout,
      }
    case 'expect_visible':
    case 'wait_for':
      return { error: `TimeoutError: ${locatorExpr(sel)} tidak terlihat dalam ${timeout}ms`, duration: timeout }
    case 'expect_status':
      return {
        error: `Expected status ${interpolated.value}, received 500`,
        details: { expected: String(interpolated.value), actual: '500' },
        duration: 4,
      }
    case 'expect_json':
      return {
        error: `Expected ${interpolated.path} ${interpolated.op} "${interpolated.value ?? ''}", received null`,
        details: { expected: String(interpolated.value ?? ''), actual: 'null' },
        duration: 3,
      }
    case 'http_request':
      return { error: `apiRequestContext.${(interpolated.method ?? 'get').toLowerCase()}: connect ECONNREFUSED ${interpolated.url}`, duration: 3000 }
    default:
      return {
        error: `TimeoutError: ${step.action === 'fill' ? 'locator.fill' : `locator.${step.action}`}: Timeout ${timeout}ms exceeded.\nMenunggu ${locatorExpr(sel)}`,
        duration: timeout,
      }
  }
}

function normalDuration(step: Step, rng: Rng): number {
  switch (step.action) {
    case 'goto':
      return between(rng, 600, 1600)
    case 'http_request':
      return between(rng, 90, 650)
    case 'wait':
      return Number(step.ms ?? 500)
    case 'fill':
    case 'type':
      return between(rng, 60, 260)
    case 'manual':
      return 0
    default:
      return between(rng, 40, 420)
  }
}

/* ------------------------------------------------------------------ interpolasi */

/** crypto.randomUUID hanya ada di secure context; ini juga jalan di http://<IP>. */
function uuidV4(): string {
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export interface VarContext {
  env: Record<string, string>
  secretNames: string[]
  vars: Record<string, string>
}

export function interpolate(text: string, ctx: VarContext): string {
  return text.replace(/\{\{\s*([\w.]+)(?:\s+[^}]*)?\s*\}\}/g, (whole, name: string) => {
    const [ns, key] = name.split('.', 2)
    if (ns === 'env') return ctx.env[key] ?? whole
    if (ns === 'secret') return '••••'
    if (ns === 'vars') return ctx.vars[key] ?? whole
    if (ns === 'fn') {
      if (key === 'uuid') return uuidV4()
      if (key === 'now') return new Date().toISOString()
      if (key === 'random_email') return `qa+${Math.floor(Math.random() * 1e6)}@tokoku.id`
      if (key === 'random_int') return String(Math.floor(Math.random() * 100))
    }
    return whole
  })
}

function interpolateStep(step: Step, ctx: VarContext): Step {
  const out: Step = { ...step }
  for (const [k, v] of Object.entries(step)) {
    if (typeof v === 'string' && k !== 'id' && k !== 'action') (out as Record<string, unknown>)[k] = interpolate(v, ctx)
  }
  return out
}

/* ------------------------------------------------------------------ pembuatan run */

function planStep(step: Step, tc: DbTestCase, isLastAssertion: boolean, timeout: number, interpolated: Step, rng: Rng): SimPlan & { details?: Record<string, unknown> } {
  if (step.action === 'manual') return { outcome: 'passed', duration_ms: 0 }
  let fail = containsFailMarker(step)
  if (!fail && (step.action === 'expect_text' || step.action === 'expect_value')) {
    const truth = MOCK_TRUTH[interpolated.selector ?? '']
    if (truth !== undefined) fail = !matches(truth, String(interpolated.value ?? ''), step.match)
  }
  if (!fail && isLastAssertion && tc.tags.includes('flaky')) fail = rng() < 0.4
  if (fail) {
    const f = failureFor(step, timeout, interpolated)
    return { outcome: 'failed', error: f.error, duration_ms: f.duration, details: f.details }
  }
  let details: Record<string, unknown> | undefined
  if (step.action === 'http_request') {
    const status = interpolated.method === 'POST' ? 201 : 200
    details = {
      request: { method: interpolated.method ?? 'GET', url: interpolated.url },
      response: {
        status,
        time_ms: between(rng, 80, 600),
        body: interpolated.method === 'POST' ? { data: { id: `ord_${between(rng, 1000, 9999)}`, status: 'created' } } : { data: [{ id: 'p_1', name: 'Kaos Polos Hitam', price: 90000 }], meta: { total: 1 } },
      },
    }
  }
  if (step.action === 'expect_text' || step.action === 'expect_value') {
    const truth = MOCK_TRUTH[interpolated.selector ?? '']
    details = { expected: String(interpolated.value ?? ''), actual: truth ?? String(interpolated.value ?? '') }
  }
  return { outcome: 'passed', duration_ms: normalDuration(step, rng), details }
}

function buildCase(
  run: Pick<DbRun, 'options'>,
  tc: DbTestCase,
  position: number,
  ctx: VarContext,
  rng: Rng,
  continueOnFailure: boolean,
): DbRunCase {
  const enabled = tc.steps.filter((s) => s.enabled !== false)
  const lastAssertIdx = enabled.map((s) => s.action.startsWith('expect_')).lastIndexOf(true)
  let assertCounter = -1
  const steps: DbRunStep[] = tc.steps.map((step, i): DbRunStep => {
    const interp = interpolateStep(step, { ...ctx, vars: { ...tc.variables, ...ctx.vars } })
    const timeout = step.timeout_ms ?? run.options.step_timeout_ms
    if (step.enabled !== false && step.action.startsWith('expect_')) assertCounter += 1
    const plan = step.enabled === false ? undefined : planStep(step, tc, assertCounter === lastAssertIdx && step.action.startsWith('expect_'), timeout, interp, rng)
    return {
      id: newId('rs'),
      position: i + 1,
      step_id: step.id,
      action: step.action,
      summary: summarizeStep(interp),
      description: interp.description ?? '',
      expected: interp.expected ?? '',
      status: 'pending' as StepStatus,
      duration_ms: null,
      error_message: null,
      actual_result: null,
      screenshot_id: null,
      details: null,
      sim: plan ? { outcome: plan.outcome, error: plan.error, duration_ms: plan.duration_ms } : undefined,
      sim_details: plan?.details,
      continue_on_failure: step.continue_on_failure,
      enabled: step.enabled !== false,
      is_ui: getAction(step.action)?.kind === 'ui',
      force_screenshot: step.screenshot === true || step.action === 'screenshot',
    }
  })
  return {
    id: newId('rc'),
    position,
    test_case_id: tc.id,
    test_case_key: tc.key,
    test_case_revision: tc.revision,
    title: tc.title,
    execution: tc.execution,
    status: 'pending',
    executed_by_id: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    video_id: null,
    attachment_ids: [],
    continue_on_failure: continueOnFailure,
    steps,
  }
}

export function envContext(env: DbEnvironment | undefined, extraVars: Record<string, string> = {}): VarContext {
  return {
    env: env?.variables ?? {},
    secretNames: env?.secrets.map((s) => s.name) ?? [],
    vars: extraVars,
  }
}

export interface CreateRunArgs {
  project: DbProject
  kind: 'test_case' | 'flow'
  targetId: string
  env: DbEnvironment | undefined
  options: RunOptions
  userId: string
  trigger: RunTrigger
  assigneeId?: string | null
  rng?: Rng
  queuedAt?: string
  onlyTestCaseIds?: string[]
}

export function createRun(a: CreateRunArgs): DbRun {
  const rng = a.rng ?? Math.random
  const s = db()
  a.project.seq.run += 1
  const key = `${a.project.key}-R${a.project.seq.run}`
  let cases: DbRunCase[] = []
  let title = ''
  let targetKey = ''
  let shared = false
  let stopOnFailure = true
  if (a.kind === 'test_case') {
    const tc = s.testCases.find((t) => t.id === a.targetId)!
    title = tc.title
    targetKey = tc.key
    cases = [buildCase(a, tc, 1, envContext(a.env), rng, false)]
  } else {
    const flow = s.flows.find((f) => f.id === a.targetId)!
    title = flow.name
    targetKey = flow.key
    shared = flow.shared_session
    stopOnFailure = flow.stop_on_failure
    const ctx = envContext(a.env, flow.variables)
    let pos = 0
    for (const item of flow.items) {
      if (!item.enabled) continue
      if (a.onlyTestCaseIds && !a.onlyTestCaseIds.includes(item.test_case_id)) continue
      const tc = s.testCases.find((t) => t.id === item.test_case_id && !t.deleted_at)
      if (!tc) continue
      pos += 1
      cases.push(buildCase(a, tc, pos, ctx, rng, item.continue_on_failure))
    }
  }
  const firstIsManual = cases[0]?.execution === 'manual'
  const run: DbRun = {
    id: newId('run'),
    key,
    project_id: a.project.id,
    kind: a.kind,
    target_id: a.targetId,
    target_key: targetKey,
    target_title: title,
    environment_id: a.env?.id ?? null,
    environment_name: a.env?.name ?? null,
    status: firstIsManual ? 'awaiting_manual' : 'queued',
    options: a.options,
    trigger: a.trigger,
    triggered_by_id: a.userId,
    assignee_id: cases.some((c) => c.execution === 'manual') ? (a.assigneeId ?? a.userId) : null,
    shared_session: shared,
    stop_on_failure: stopOnFailure,
    queued_at: a.queuedAt ?? nowIso(),
    started_at: firstIsManual ? (a.queuedAt ?? nowIso()) : null,
    finished_at: null,
    error_message: null,
    cancel_requested: false,
    resume_position: firstIsManual ? 1 : null,
    cases,
  }
  if (cases.length === 0) {
    run.status = 'error'
    run.error_message = 'Tidak ada test case aktif untuk dijalankan'
    run.finished_at = run.queued_at
  }
  return run
}

/* ------------------------------------------------------------------ artifacts */

const PAGE_VARIANTS: [RegExp, string][] = [
  [/login|otp|logout|password|auth/i, 'login'],
  [/keranjang|cart/i, 'cart'],
  [/checkout|voucher|bayar|pembayaran|invoice|order/i, 'checkout'],
  [/produk|katalog|cari|filter/i, 'catalog'],
]

function pageVariant(title: string): string {
  return PAGE_VARIANTS.find(([re]) => re.test(title))?.[1] ?? 'home'
}

function addArtifact(run: DbRun, c: DbRunCase, step: DbRunStep | null, kind: DbArtifact['kind'], at: string): DbArtifact {
  const variant = pageVariant(c.title)
  const failed = step?.status === 'failed'
  const a: DbArtifact = {
    id: newId('art'),
    project_id: run.project_id,
    run_id: run.id,
    run_case_id: c.id,
    run_step_id: step?.id ?? null,
    kind,
    name:
      kind === 'video'
        ? `${c.test_case_key}.webm`
        : `${c.test_case_key}-step-${step?.position ?? 0}${failed ? '-failed' : ''}.png`,
    url: kind === 'video' ? '/mock-artifacts/run-video.webm' : `/mock-artifacts/${failed ? `${variant}-error` : variant}.svg`,
    mime: kind === 'video' ? 'video/webm' : 'image/svg+xml',
    size_bytes: kind === 'video' ? 1_840_000 + Math.floor(Math.random() * 600_000) : 84_000 + Math.floor(Math.random() * 40_000),
    uploaded_by: null,
    created_at: at,
    expired: false,
  }
  db().artifacts.push(a)
  return a
}

/* ------------------------------------------------------------------ mesin state */

function caseStatusFromSteps(c: DbRunCase): StepStatus {
  const st = c.steps.map((s) => s.status)
  if (st.includes('error')) return 'error'
  if (st.includes('failed')) return 'failed'
  if (st.includes('blocked')) return 'blocked'
  if (st.length > 0 && st.every((s) => s === 'skipped')) return 'skipped'
  return 'passed'
}

function finishCase(run: DbRun, c: DbRunCase, at: string) {
  c.status = caseStatusFromSteps(c)
  c.finished_at = at
  c.duration_ms = c.started_at ? Date.parse(at) - Date.parse(c.started_at) : 0
  const hasUi = c.steps.some((s) => s.is_ui && s.status !== 'skipped')
  if (c.execution === 'automated' && hasUi) {
    const wantVideo = run.options.video === 'always' || (run.options.video === 'on_failure' && c.status === 'failed')
    const sharedAlready = run.shared_session && run.cases.some((x) => x.video_id)
    if (wantVideo && !sharedAlready) c.video_id = addArtifact(run, c, null, 'video', at).id
  }
}

function finalizeRun(run: DbRun, at: string) {
  const st = run.cases.map((c) => c.status)
  run.status = st.includes('error') ? 'error' : st.includes('failed') ? 'failed' : st.includes('blocked') ? 'blocked' : 'passed'
  if (run.status === 'error' && !run.error_message) run.error_message = 'Error infrastruktur saat eksekusi'
  run.finished_at = at
  run.resume_position = null
}

function skipRemaining(c: DbRunCase) {
  for (const s of c.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped'
}

/**
 * Majukan satu run satu "langkah" simulasi. Mengembalikan true bila ada perubahan.
 * `at` = waktu simulasi (Date.now() untuk live, waktu sintetis untuk seed).
 */
export function advance(run: DbRun, at: number): boolean {
  const iso = new Date(at).toISOString()
  if (isFinal(run.status) || run.status === 'awaiting_manual') return false

  if (run.cancel_requested) {
    for (const c of run.cases) {
      if (c.status === 'pending' || c.status === 'running') {
        skipRemaining(c)
        c.status = 'skipped'
      }
    }
    run.status = 'cancelled'
    run.finished_at = iso
    return true
  }

  if (run.status === 'queued') {
    run.status = 'running'
    run.started_at = run.started_at ?? iso
    return true
  }

  const c = run.cases.find((x) => x.status === 'pending' || x.status === 'running')
  if (!c) {
    finalizeRun(run, iso)
    return true
  }

  if (c.status === 'pending') {
    // flow: cek stop_on_failure
    const prevFailed = run.cases.some((x) => x.position < c.position && (x.status === 'failed' || x.status === 'error' || x.status === 'blocked') && !x.continue_on_failure)
    if (run.kind === 'flow' && run.stop_on_failure && prevFailed) {
      skipRemaining(c)
      c.status = 'skipped'
      return true
    }
    if (c.execution === 'manual') {
      run.status = 'awaiting_manual'
      run.resume_position = c.position
      return true
    }
    c.status = 'running'
    c.started_at = iso
    return true
  }

  // case berjalan: proses step
  const running = c.steps.find((s) => s.status === 'running')
  if (running) {
    const plan = running.sim ?? { outcome: 'passed', duration_ms: 50 }
    running.status = plan.outcome
    running.duration_ms = plan.duration_ms
    running.error_message = plan.error ?? null
    running.details = running.sim_details ?? null
    const shot =
      running.is_ui &&
      (running.force_screenshot ||
        run.options.screenshot === 'every_step' ||
        (run.options.screenshot === 'on_failure' && running.status === 'failed'))
    if (shot) running.screenshot_id = addArtifact(run, c, running, 'screenshot', iso).id
    if (running.status === 'failed' && !running.continue_on_failure) {
      skipRemaining(c)
      finishCase(run, c, iso)
    }
    return true
  }
  const next = c.steps.find((s) => s.status === 'pending')
  if (!next) {
    finishCase(run, c, iso)
    return true
  }
  if (next.enabled === false) {
    next.status = 'skipped'
    return true
  }
  next.status = 'running'
  return true
}

/** Jalankan run sampai final/menunggu manual secara sinkron (untuk seed historis). */
export function fastForward(run: DbRun, startMs: number) {
  let t = startMs
  let guard = 0
  while (!isFinal(run.status) && run.status !== 'awaiting_manual' && guard < 2000) {
    const running = run.cases.find((c) => c.status === 'running')?.steps.find((s) => s.status === 'running')
    t += running?.sim ? running.sim.duration_ms : 15
    advance(run, t)
    guard += 1
  }
}

/* ------------------------------------------------------------------ manual */

export function completeManualCase(run: DbRun, caseId: string, userId: string): string | null {
  const c = run.cases.find((x) => x.id === caseId)
  if (!c || c.execution !== 'manual') return 'Case bukan case manual'
  if (c.steps.some((s) => s.status === 'pending')) return 'Masih ada step yang belum ditandai'
  const at = nowIso()
  c.executed_by_id = c.executed_by_id ?? userId
  c.started_at = c.started_at ?? run.started_at ?? at
  finishCase(run, c, at)
  run.resume_position = null
  const more = run.cases.some((x) => x.status === 'pending')
  if (!more) {
    finalizeRun(run, at)
  } else {
    run.status = 'running'
  }
  return null
}

/* ------------------------------------------------------------------ loop live */

let timer: ReturnType<typeof setInterval> | null = null

export function startSimulator() {
  if (timer) return
  const loop = () => {
    const s = db()
    let changed = false
    for (const run of s.runs) {
      if (run.status === 'queued' || run.status === 'running') {
        if (advance(run, Date.now())) changed = true
      }
    }
    if (changed) persist()
  }
  const restart = () => {
    if (timer) clearInterval(timer)
    const speed = db().sim.speed || 1
    timer = setInterval(loop, Math.round(450 / speed))
  }
  restart()
  window.addEventListener('qatlas:sim-speed', restart)
}

export function rngFor(seed: string): Rng {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619)
  return mulberry32(h >>> 0)
}

export type { DbRunCase }
