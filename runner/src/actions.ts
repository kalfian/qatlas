import { join } from 'node:path'
import type { APIResponse, Page } from 'playwright'
import { CancelledError, InfraError, StepFailure, cleanPlaywrightMessage, isTargetClosed } from './errors.js'
import { regexDecodeMode, textForRegex, type RegexDecode } from './decode.js'
import { toVarString } from './interpolate.js'
import { evalJsonPath } from './jsonpath.js'
import { matchMode, matchPhrase, matches, normalizeWs, toRegExp, type MatchMode } from './match.js'
import { pollUntil, sleep, withCancel } from './poll.js'
import type { WireStep } from './protocol.js'
import { resolveSelector, type ResolvedLocator } from './selectors.js'
import type { Session } from './session.js'

export interface LastResponse {
  status: number
  headers: Record<string, string>
  timeMs: number
  text: string
  json: unknown
  isJson: boolean
}

export interface StepContext {
  session: Session
  signal: AbortSignal
  timeoutMs: number
  /** Runtime vars of the case/segment (save, extract_text, set_variable write here). */
  runtime: Record<string, string>
  http: { last: LastResponse | null }
  /** Path for an explicit `screenshot` action file. */
  screenshotPath: (name?: string) => string
}

export interface StepOutcome {
  details: Record<string, unknown> | null
  /** Set when the action itself produced the step's screenshot. */
  screenshot: string | null
}

const BODY_LIMIT = 8 * 1024
const MAX_WAIT_MS = 30_000

const ok = (details: Record<string, unknown> | null = null, screenshot: string | null = null): StepOutcome => ({ details, screenshot })
const str = (v: unknown) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v))

function requireParam(step: WireStep, name: string): unknown {
  const v = step[name]
  if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) {
    throw new StepFailure(`Step "${step.action}" requires parameter "${name}"`)
  }
  return v
}

/** Run a Playwright call; map its errors to StepFailure/CancelledError with a clean message. */
async function pw<T>(ctx: StepContext, subject: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await withCancel(fn(), ctx.signal)
  } catch (err) {
    if (err instanceof CancelledError || ctx.signal.aborted) throw new CancelledError()
    if (err instanceof StepFailure || err instanceof InfraError) throw err
    if (isTargetClosed(err)) throw new InfraError(`${subject}: the browser page was closed unexpectedly`)
    throw new StepFailure(cleanPlaywrightMessage(err, subject))
  }
}

async function loc(ctx: StepContext, step: WireStep): Promise<{ page: Page } & ResolvedLocator> {
  const page = await ctx.session.page()
  return { page, ...resolveSelector(page, requireParam(step, 'selector')) }
}

/* ------------------------------------------------------------------ UI actions */

async function goto(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const url = String(requireParam(step, 'url'))
  const page = await ctx.session.page()
  await pw(ctx, `goto ${url}`, () => page.goto(url, { timeout: ctx.timeoutMs, waitUntil: 'load' }))
  return ok()
}

async function interact(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  const timeout = ctx.timeoutMs
  const a = step.action
  await pw(ctx, `${a} ${describe}`, () => {
    switch (a) {
      case 'click':
        return locator.click({ timeout })
      case 'dblclick':
        return locator.dblclick({ timeout })
      case 'hover':
        return locator.hover({ timeout })
      case 'check':
        return locator.check({ timeout })
      case 'uncheck':
        return locator.uncheck({ timeout })
      case 'fill':
        return locator.fill(str(step.value), { timeout })
      case 'type': {
        const delay = Number(step.delay_ms ?? 0)
        return locator.pressSequentially(str(step.value), { timeout, delay: Number.isFinite(delay) ? delay : 0 })
      }
      default:
        throw new InfraError(`interact() called for ${a}`)
    }
  })
  return ok()
}

async function press(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const key = String(requireParam(step, 'key'))
  if (typeof step.selector === 'string' && step.selector.trim()) {
    const { locator, describe } = await loc(ctx, step)
    await pw(ctx, `press ${key} on ${describe}`, () => locator.press(key, { timeout: ctx.timeoutMs }))
  } else {
    const page = await ctx.session.page()
    await pw(ctx, `press ${key}`, () => page.keyboard.press(key))
  }
  return ok()
}

async function selectOption(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  const hasValue = step.value !== undefined && step.value !== null && str(step.value) !== ''
  const hasLabel = step.label !== undefined && step.label !== null && str(step.label) !== ''
  if (!hasValue && !hasLabel) throw new StepFailure('select_option requires "value" or "label"')
  const option = hasValue ? { value: str(step.value) } : { label: str(step.label) }
  await pw(ctx, `select_option ${describe}`, () => locator.selectOption(option, { timeout: ctx.timeoutMs }))
  return ok()
}

async function waitFor(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  const state = (step.state ?? 'visible') as string
  if (state === 'visible' || state === 'attached') {
    // Non-strict: wait until at least one matching element is visible/attached.
    const target = state === 'visible' ? locator.filter({ visible: true }).first() : locator.first()
    await pw(ctx, `wait_for ${describe} ${state}`, () => target.waitFor({ state, timeout: ctx.timeoutMs }))
    return ok()
  }
  if (state === 'hidden') {
    const r = await pollUntil(() => locator.filter({ visible: true }).count(), (n) => n === 0, ctx.timeoutMs, ctx.signal)
    if (!r.ok) throw new StepFailure(`wait_for ${describe} hidden: still visible after ${ctx.timeoutMs}ms`)
    return ok()
  }
  throw new StepFailure(`Invalid state "${state}" (expected visible, hidden or attached)`)
}

const safeName = (s: string) => s.replace(/[^\w.-]+/g, '_').slice(0, 60)

async function screenshot(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const page = await ctx.session.page()
  const path = ctx.screenshotPath(step.name ? safeName(str(step.name)) : undefined)
  await pw(ctx, 'screenshot', () => page.screenshot({ path, fullPage: step.full_page === true, timeout: ctx.timeoutMs }))
  return ok(null, path)
}

async function extractText(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const saveAs = String(requireParam(step, 'save_as'))
  const { locator, describe } = await loc(ctx, step)
  const text = await pw(ctx, `extract_text ${describe}`, () => locator.textContent({ timeout: ctx.timeoutMs }))
  ctx.runtime[saveAs] = normalizeWs(text ?? '')
  return ok()
}

/* ------------------------------------------------------------------ UI assertions (polling) */

function assertionFailure(message: string, expected: string, actual: string): StepFailure {
  return new StepFailure(message, { expected, actual })
}

async function expectVisibility(ctx: StepContext, step: WireStep, wantVisible: boolean): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  // Non-strict: "visible" = at least one match visible; "hidden" = no match visible (or none exists).
  const probe = async () => ({ visible: await locator.filter({ visible: true }).count(), total: await locator.count() })
  const r = await pollUntil(probe, (v) => (wantVisible ? v.visible > 0 : v.visible === 0), ctx.timeoutMs, ctx.signal)
  const expected = wantVisible ? 'visible' : 'hidden'
  const actual = !r.value ? 'unknown' : r.value.total === 0 ? 'not found' : r.value.visible > 0 ? 'visible' : 'hidden'
  if (r.ok) return ok({ expected, actual })
  const why = r.value
    ? r.value.total === 0
      ? 'no element matched'
      : wantVisible
        ? `${r.value.total} matching element(s) but none visible`
        : `${r.value.visible} matching element(s) still visible`
    : `could not evaluate the selector (${cleanPlaywrightMessage(r.error)})`
  throw assertionFailure(`Expected ${describe} to be ${expected} within ${ctx.timeoutMs}ms, but ${why}`, expected, actual)
}

/** Strict text/value assertion: exactly one element must match. */
async function expectElementString(ctx: StepContext, step: WireStep, kind: 'text' | 'value'): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  const mode: MatchMode = matchMode(step.match)
  const rawExpected = str(requireParam(step, 'value'))
  const expected = mode === 'regex' ? rawExpected : normalizeWs(rawExpected)
  if (mode === 'regex') toRegExp(expected) // validate early
  const probe = async (): Promise<string[]> =>
    kind === 'text'
      ? (await locator.allTextContents()).map(normalizeWs)
      : await locator.evaluateAll((els) => els.map((e) => String((e as unknown as { value?: unknown }).value ?? '')))
  const check = (vals: string[]) => vals.length === 1 && matches(vals[0], expected, mode)
  const r = await pollUntil(probe, check, ctx.timeoutMs, ctx.signal)
  const what = kind === 'text' ? 'text' : 'value'
  const vals = r.value ?? []
  if (r.ok) return ok({ expected: rawExpected, actual: vals[0] })
  if (vals.length === 1) {
    throw assertionFailure(`Expected ${what} of ${describe} ${matchPhrase(expected, mode)}, received ${JSON.stringify(vals[0])}`, rawExpected, vals[0])
  }
  if (vals.length === 0) {
    const extra = r.error ? ` (${cleanPlaywrightMessage(r.error)})` : ''
    throw assertionFailure(`Expected ${what} of ${describe} ${matchPhrase(expected, mode)}, but no element matched within ${ctx.timeoutMs}ms${extra}`, rawExpected, '(element not found)')
  }
  throw assertionFailure(
    `Expected ${what} of ${describe} ${matchPhrase(expected, mode)}, but the selector matched ${vals.length} elements (make it unique)`,
    rawExpected,
    `(${vals.length} elements: ${vals.slice(0, 3).map((v) => JSON.stringify(v)).join(', ')}${vals.length > 3 ? ', …' : ''})`,
  )
}

async function expectPage(ctx: StepContext, step: WireStep, kind: 'url' | 'title'): Promise<StepOutcome> {
  const page = await ctx.session.page()
  const mode = matchMode(step.match)
  const raw = str(requireParam(step, 'value'))
  let expected = raw
  // equals with a relative URL ("/akun") compares against the absolute URL resolved on the current page.
  if (kind === 'url' && mode === 'equals' && raw.startsWith('/')) {
    try {
      expected = new URL(raw, page.url()).href
    } catch {
      /* keep raw */
    }
  }
  if (mode === 'regex') toRegExp(expected)
  const probe = async () => (kind === 'url' ? page.url() : await page.title())
  const r = await pollUntil(probe, (v) => matches(v, expected, mode), ctx.timeoutMs, ctx.signal)
  const actual = r.value ?? ''
  if (r.ok) return ok({ expected: raw, actual })
  const label = kind === 'url' ? 'page URL' : 'page title'
  throw assertionFailure(`Expected ${label} ${matchPhrase(expected, mode)}, received ${JSON.stringify(actual)}`, raw, actual)
}

async function expectCount(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const { locator, describe } = await loc(ctx, step)
  const want = Number(requireParam(step, 'value'))
  if (!Number.isFinite(want)) throw new StepFailure(`expect_count value must be a number, got ${JSON.stringify(step.value)}`)
  const op = (step.op ?? 'eq') as string
  const cmp: Record<string, [string, (n: number) => boolean]> = {
    eq: ['=', (n) => n === want],
    gte: ['>=', (n) => n >= want],
    lte: ['<=', (n) => n <= want],
  }
  if (!cmp[op]) throw new StepFailure(`Invalid op "${op}" (expected eq, gte or lte)`)
  const [sym, test] = cmp[op]
  const r = await pollUntil(() => locator.count(), test, ctx.timeoutMs, ctx.signal)
  const expected = `${sym} ${want}`
  const actual = r.value === undefined ? 'unknown' : String(r.value)
  if (r.ok) return ok({ expected, actual })
  throw assertionFailure(`Expected count of ${describe} to be ${expected}, received ${actual}`, expected, actual)
}

/* ------------------------------------------------------------------ HTTP */

function truncateBody(text: string): string {
  const buf = Buffer.from(text, 'utf8')
  if (buf.length <= BODY_LIMIT) return text
  return buf.subarray(0, BODY_LIMIT).toString('utf8').replace(/\uFFFD+$/, '') + '…[truncated]'
}

function asStringRecord(v: unknown, name: string): Record<string, string> | undefined {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      throw new StepFailure(`"${name}" must be an object of key → value`)
    }
  }
  if (typeof v !== 'object' || Array.isArray(v)) throw new StepFailure(`"${name}" must be an object of key → value`)
  const out: Record<string, string> = {}
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = toVarString(val)
  return out
}

type FetchOptions = Parameters<Awaited<ReturnType<Session['api']>>['fetch']>[1]

const POLL_MAX_MS = 120_000
const POLL_MIN_INTERVAL_MS = 200
const POLL_DEFAULT_INTERVAL_MS = 1000

function optionalNumber(step: WireStep, name: string): number | undefined {
  const v = step[name]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(String(v).trim())
  if (!Number.isFinite(n)) throw new StepFailure(`"${name}" must be a number, got ${JSON.stringify(v)}`)
  return n
}

interface PollSettings {
  timeoutMs: number
  intervalMs: number
  until: string | undefined
}

function pollSettings(step: WireStep): PollSettings | null {
  const timeoutMs = optionalNumber(step, 'poll_timeout_ms') ?? 0
  if (timeoutMs < 0 || timeoutMs > POLL_MAX_MS) throw new StepFailure(`poll_timeout_ms must be between 0 and ${POLL_MAX_MS}`)
  const intervalMs = optionalNumber(step, 'poll_interval_ms') ?? POLL_DEFAULT_INTERVAL_MS
  if (intervalMs < POLL_MIN_INTERVAL_MS) throw new StepFailure(`poll_interval_ms must be at least ${POLL_MIN_INTERVAL_MS}`)
  const until = typeof step.poll_until === 'string' && step.poll_until.trim() ? step.poll_until.trim() : undefined
  return timeoutMs > 0 ? { timeoutMs, intervalMs, until } : null
}

/** One request/response exchange of an http_request step. */
interface Exchange {
  last: LastResponse | null
  details: Record<string, unknown>
  /** Network/protocol error message when no response arrived. */
  error: string | null
}

/** What the response still lacks: [] when every save/save_regex/poll_until is satisfied. */
interface Extraction {
  saves: Record<string, string>
  missing: string[]
}

function extract(
  last: LastResponse,
  save: Record<string, string> | undefined,
  saveRegex: [string, string, RegExp][],
  decode: RegexDecode,
  until: string | undefined,
): Extraction {
  const saves: Record<string, string> = {}
  const missing: string[] = []
  const evalPath = (path: string) => {
    try {
      return evalJsonPath(last.json, path)
    } catch (e) {
      // A malformed JSONPath never resolves: fail at once instead of polling until the timeout.
      throw new StepFailure((e as Error).message)
    }
  }
  if (until) {
    const r = last.isJson ? evalPath(until) : { found: false, value: undefined }
    if (!last.isJson) missing.push(`poll_until ${until}: response body is not JSON`)
    else if (!r.found || r.value === null) missing.push(`poll_until ${until} not found`)
    else if (Array.isArray(r.value) && r.value.length === 0) missing.push(`poll_until ${until} is an empty array`)
  }
  for (const [name, path] of Object.entries(save ?? {})) {
    if (!last.isJson) {
      missing.push(`Cannot save "${name}" from ${path}: response body is not JSON`)
      continue
    }
    const r = evalPath(path)
    if (!r.found) missing.push(`Cannot save "${name}": ${path} not found in the response`)
    else saves[name] = toVarString(r.value)
  }
  if (saveRegex.length) {
    const text = textForRegex(last.text, last.json, last.isJson, decode)
    for (const [name, pattern, re] of saveRegex) {
      re.lastIndex = 0
      const m = re.exec(text)
      if (!m) missing.push(`Cannot save "${name}": pattern ${pattern} not found in the response${decode === 'none' ? '' : ` (decoded: ${decode})`}`)
      else saves[name] = m.length > 1 ? (m[1] ?? '') : m[0]
    }
  }
  return { saves, missing }
}

async function httpRequest(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const method = String(step.method ?? 'GET').toUpperCase()
  const rawUrl = String(requireParam(step, 'url'))
  const headers = { ...(asStringRecord(step.headers, 'headers') ?? {}) }
  const query = asStringRecord(step.query, 'query')
  const save = asStringRecord(step.save, 'save')
  const saveRegex: [string, string, RegExp][] = Object.entries(asStringRecord(step.save_regex, 'save_regex') ?? {}).map(([name, pattern]) => {
    if (!pattern.trim()) throw new StepFailure(`save_regex "${name}" needs a pattern`)
    const re = toRegExp(pattern)
    return [name, re.toString(), re]
  })
  const decode = regexDecodeMode(step.regex_decode)
  const poll = pollSettings(step)
  let url = rawUrl
  if (query && Object.keys(query).length) {
    const u = new URL(rawUrl)
    for (const [k, v] of Object.entries(query)) u.searchParams.append(k, v)
    url = u.toString()
  }
  const hasHeader = (name: string) => Object.keys(headers).some((h) => h.toLowerCase() === name)
  const bodyType = String(step.body_type ?? 'json')
  const body = step.body
  const fetchOpts: FetchOptions = {
    method,
    headers,
    timeout: ctx.timeoutMs,
    failOnStatusCode: false,
  }
  if (body !== undefined && body !== null && body !== '') {
    if (bodyType === 'form') {
      let form: Record<string, string>
      if (typeof body === 'string' && !body.trim().startsWith('{')) form = Object.fromEntries(new URLSearchParams(body))
      else form = asStringRecord(body, 'body') ?? {}
      fetchOpts.form = form
    } else if (bodyType === 'text') {
      fetchOpts.data = str(body)
      if (!hasHeader('content-type')) headers['Content-Type'] = 'text/plain; charset=utf-8'
    } else if (bodyType === 'json') {
      if (typeof body === 'string') {
        try {
          JSON.parse(body)
        } catch (e) {
          throw new StepFailure(`Request body is not valid JSON: ${(e as Error).message}`)
        }
        fetchOpts.data = body
      } else {
        fetchOpts.data = JSON.stringify(body)
      }
      if (!hasHeader('content-type')) headers['Content-Type'] = 'application/json'
    } else {
      throw new StepFailure(`Invalid body_type "${bodyType}" (expected json, text or form)`)
    }
  }
  const requestInfo = { method, url }
  const api = await ctx.session.api()

  const send = async (timeout: number): Promise<Exchange> => {
    const started = performance.now()
    let res: APIResponse
    let text: string
    try {
      res = await withCancel(api.fetch(url, { ...fetchOpts, timeout }), ctx.signal)
      text = await withCancel(res.text(), ctx.signal)
    } catch (err) {
      if (err instanceof CancelledError || ctx.signal.aborted) throw new CancelledError()
      return { last: null, details: { request: requestInfo, response: null }, error: cleanPlaywrightMessage(err, `${method} ${url}`) }
    }
    const timeMs = Math.round(performance.now() - started)
    let json: unknown = undefined
    let isJson = false
    if (text) {
      try {
        json = JSON.parse(text)
        isJson = true
      } catch {
        /* not JSON */
      }
    }
    const last: LastResponse = { status: res.status(), headers: res.headers() /* lower-cased names */, timeMs, text, json, isJson }
    const truncated = Buffer.byteLength(text, 'utf8') > BODY_LIMIT
    return {
      last,
      details: { request: requestInfo, response: { status: last.status, time_ms: timeMs, body: isJson && !truncated ? json : truncateBody(text) } },
      error: null,
    }
  }

  if (!poll) {
    const ex = await send(ctx.timeoutMs)
    if (!ex.last) throw new StepFailure(ex.error ?? `${method} ${url} failed`, ex.details)
    ctx.http.last = ex.last
    let r: Extraction
    try {
      r = extract(ex.last, save, saveRegex, decode, undefined)
    } catch (e) {
      throw e instanceof StepFailure ? new StepFailure(e.message, ex.details) : e
    }
    if (r.missing.length) throw new StepFailure(r.missing[0], ex.details)
    Object.assign(ctx.runtime, r.saves)
    return ok(ex.details)
  }

  // Polling: re-send until 2xx AND poll_until AND every save/save_regex resolves, or the deadline.
  const deadline = Date.now() + poll.timeoutMs
  let attempts = 0
  let ex: Exchange
  let missing: string[]
  for (;;) {
    attempts++
    const remaining = deadline - Date.now()
    ex = await send(Math.max(1000, Math.min(ctx.timeoutMs, remaining)))
    if (ex.last) {
      ctx.http.last = ex.last
      let r: Extraction
      try {
        r = extract(ex.last, save, saveRegex, decode, poll.until)
      } catch (e) {
        throw e instanceof StepFailure ? new StepFailure(e.message, { ...ex.details, attempts }) : e
      }
      const ok2xx = ex.last.status >= 200 && ex.last.status < 300
      missing = ok2xx ? r.missing : [`status ${ex.last.status} (waiting for 2xx)`]
      if (missing.length === 0) {
        Object.assign(ctx.runtime, r.saves)
        return ok({ ...ex.details, attempts })
      }
    } else {
      missing = [`no response (${ex.error})`]
    }
    const left = deadline - Date.now()
    if (left <= 0) break
    await sleep(Math.min(poll.intervalMs, left), ctx.signal)
  }
  throw new StepFailure(
    `Polling ${method} ${url} timed out after ${poll.timeoutMs} ms (${attempts} attempt${attempts === 1 ? '' : 's'}); still missing: ${missing.join('; ')}`,
    { ...ex.details, attempts },
  )
}

function lastResponse(ctx: StepContext, action: string): LastResponse {
  if (!ctx.http.last) throw new StepFailure(`${action} needs a preceding http_request step in this test case`)
  return ctx.http.last
}

function expectStatus(ctx: StepContext, step: WireStep): StepOutcome {
  const last = lastResponse(ctx, 'expect_status')
  const list = Array.isArray(step.in) ? step.in.map(Number) : null
  if (!list && (step.value === undefined || step.value === null || step.value === '')) {
    throw new StepFailure('expect_status requires "value" (status code) or "in" (list of codes)')
  }
  const expected = list ? `in [${list.join(', ')}]` : String(Number(step.value))
  const pass = list ? list.includes(last.status) : last.status === Number(step.value)
  const actual = String(last.status)
  if (pass) return ok({ expected, actual })
  throw assertionFailure(`Expected status ${expected}, received ${actual}`, expected, actual)
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** eq semantics for a UI-entered (string) expected value against any JSON value. */
function looseEquals(actual: unknown, expected: unknown): boolean {
  if (deepEqual(actual, expected)) return true
  if (typeof expected !== 'string') return false
  if (typeof actual === 'string') return actual === expected
  try {
    if (deepEqual(actual, JSON.parse(expected))) return true
  } catch {
    /* not JSON */
  }
  return actual !== null && typeof actual !== 'object' && String(actual) === expected
}

function expectJson(ctx: StepContext, step: WireStep): StepOutcome {
  const last = lastResponse(ctx, 'expect_json')
  const path = String(requireParam(step, 'path'))
  const op = String(step.op ?? 'eq')
  if (!last.isJson) {
    throw assertionFailure(`Expected a JSON response body for ${path}, received ${JSON.stringify(truncateBody(last.text).slice(0, 200))}`, path, '(not JSON)')
  }
  let r
  try {
    r = evalJsonPath(last.json, path)
  } catch (e) {
    throw new StepFailure((e as Error).message)
  }
  const expectedVal = step.value
  const actualStr = r.found ? str(r.value) : '(missing)'
  const expected = op === 'exists' ? 'exists' : op === 'eq' ? str(expectedVal) : `${op} ${str(expectedVal)}`
  let pass: boolean
  switch (op) {
    case 'exists':
      pass = r.found
      break
    case 'eq':
      pass = r.found && looseEquals(r.value, expectedVal)
      break
    case 'neq':
      pass = !(r.found && looseEquals(r.value, expectedVal))
      break
    case 'contains':
      pass =
        r.found &&
        (typeof r.value === 'string'
          ? r.value.includes(str(expectedVal))
          : Array.isArray(r.value)
            ? r.value.some((x) => looseEquals(x, expectedVal))
            : r.value !== null && typeof r.value === 'object' && str(expectedVal) in (r.value as object))
      break
    case 'gt':
    case 'lt': {
      const a = Number(r.value)
      const b = Number(expectedVal)
      pass = r.found && r.value !== null && r.value !== '' && Number.isFinite(a) && Number.isFinite(b) && (op === 'gt' ? a > b : a < b)
      break
    }
    case 'matches':
      pass = r.found && toRegExp(str(expectedVal)).test(str(r.value))
      break
    default:
      throw new StepFailure(`Invalid op "${op}" (expected eq, neq, contains, exists, gt, lt or matches)`)
  }
  if (pass) return ok({ expected, actual: actualStr })
  const msg =
    op === 'exists'
      ? `Expected ${path} to exist, but it is missing`
      : !r.found && op !== 'neq'
        ? `Expected ${path} ${op} ${JSON.stringify(str(expectedVal))}, but ${path} is missing`
        : `Expected ${path} ${op} ${JSON.stringify(str(expectedVal))}, received ${actualStr}`
  throw assertionFailure(msg, expected, actualStr)
}

function expectHeader(ctx: StepContext, step: WireStep): StepOutcome {
  const last = lastResponse(ctx, 'expect_header')
  const name = String(requireParam(step, 'name')).toLowerCase()
  const mode = matchMode(step.match)
  const expected = str(requireParam(step, 'value'))
  const actual = last.headers[name]
  if (actual !== undefined && matches(actual, expected, mode)) return ok({ expected, actual })
  if (actual === undefined) throw assertionFailure(`Expected header ${name} ${matchPhrase(expected, mode)}, but the response has no ${name} header`, expected, '(missing)')
  throw assertionFailure(`Expected header ${name} ${matchPhrase(expected, mode)}, received ${JSON.stringify(actual)}`, expected, actual)
}

function expectResponseTime(ctx: StepContext, step: WireStep): StepOutcome {
  const last = lastResponse(ctx, 'expect_response_time')
  const max = Number(requireParam(step, 'max_ms'))
  if (!Number.isFinite(max)) throw new StepFailure(`max_ms must be a number, got ${JSON.stringify(step.max_ms)}`)
  const expected = `<= ${max} ms`
  const actual = `${last.timeMs} ms`
  if (last.timeMs <= max) return ok({ expected, actual })
  throw assertionFailure(`Expected response time <= ${max} ms, took ${last.timeMs} ms`, expected, actual)
}

/* ------------------------------------------------------------------ common */

async function wait(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  const ms = Number(requireParam(step, 'ms'))
  if (!Number.isFinite(ms) || ms < 0) throw new StepFailure(`wait: invalid ms ${JSON.stringify(step.ms)}`)
  await sleep(Math.min(ms, MAX_WAIT_MS), ctx.signal)
  return ok()
}

function setVariable(ctx: StepContext, step: WireStep): StepOutcome {
  const name = String(requireParam(step, 'name'))
  ctx.runtime[name] = toVarString(step.value ?? '')
  return ok()
}

/* ------------------------------------------------------------------ dispatch */

export async function executeStep(ctx: StepContext, step: WireStep): Promise<StepOutcome> {
  switch (step.action) {
    case 'goto':
      return goto(ctx, step)
    case 'click':
    case 'dblclick':
    case 'hover':
    case 'fill':
    case 'type':
    case 'check':
    case 'uncheck':
      return interact(ctx, step)
    case 'press':
      return press(ctx, step)
    case 'select_option':
      return selectOption(ctx, step)
    case 'wait_for':
      return waitFor(ctx, step)
    case 'screenshot':
      return screenshot(ctx, step)
    case 'extract_text':
      return extractText(ctx, step)
    case 'expect_visible':
      return expectVisibility(ctx, step, true)
    case 'expect_hidden':
      return expectVisibility(ctx, step, false)
    case 'expect_text':
      return expectElementString(ctx, step, 'text')
    case 'expect_value':
      return expectElementString(ctx, step, 'value')
    case 'expect_url':
      return expectPage(ctx, step, 'url')
    case 'expect_title':
      return expectPage(ctx, step, 'title')
    case 'expect_count':
      return expectCount(ctx, step)
    case 'http_request':
      return httpRequest(ctx, step)
    case 'expect_status':
      return expectStatus(ctx, step)
    case 'expect_json':
      return expectJson(ctx, step)
    case 'expect_header':
      return expectHeader(ctx, step)
    case 'expect_response_time':
      return expectResponseTime(ctx, step)
    case 'wait':
      return wait(ctx, step)
    case 'set_variable':
      return setVariable(ctx, step)
    default:
      // run.start validation rejects unknown/manual actions before execution starts.
      throw new InfraError(`Unsupported action "${step.action}"`)
  }
}

/** Screenshot after a step (every_step / on_failure / step.screenshot). Never fails the step. */
export async function captureScreenshot(session: Session, path: string): Promise<string | null> {
  if (!session.hasPage) return null
  try {
    const page = await session.page()
    await page.screenshot({ path, timeout: 5000 })
    return path
  } catch {
    return null
  }
}

export const screenshotFile = (caseDir: string, index: number, stepId: string, attempt: number, name?: string) =>
  join(caseDir, `step-${String(index + 1).padStart(2, '0')}-${safeName(stepId)}${name ? `-${name}` : ''}${attempt > 1 ? `-attempt${attempt}` : ''}.png`)
