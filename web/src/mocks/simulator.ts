import type { RunOptions, RunTrigger, Step, StepStatus } from '@/api/types'
import { getAction, summarizeStep } from '@/lib/steps'
import {
  activeStorageBackend,
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
  'testid=stock-label': 'Stock: 12',
  "role=heading[name='Order placed']": 'Order placed',
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
      const actual = MOCK_TRUTH[sel ?? ''] ?? '(element not found)'
      return {
        error: `expect(${locatorExpr(sel)}).${step.action === 'expect_text' ? 'toHaveText' : 'toHaveValue'}() failed\nExpected: ${step.match === 'equals' ? '' : 'containing '}"${interpolated.value}"\nReceived: "${actual}"`,
        details: { expected: String(interpolated.value ?? ''), actual },
        duration: timeout,
      }
    }
    case 'expect_url':
      return {
        error: `expect(page).toHaveURL() failed\nExpected: containing "${interpolated.value}"\nReceived: "https://staging.tokoku.id/login?error=1"`,
        details: { expected: String(interpolated.value ?? ''), actual: 'https://staging.tokoku.id/login?error=1' },
        duration: timeout,
      }
    case 'expect_visible':
    case 'wait_for':
      return { error: `TimeoutError: ${locatorExpr(sel)} not visible within ${timeout}ms`, duration: timeout }
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
        error: `TimeoutError: ${step.action === 'fill' ? 'locator.fill' : `locator.${step.action}`}: Timeout ${timeout}ms exceeded.\nWaiting for ${locatorExpr(sel)}`,
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

/** Mock `{{fn.totp …}}`: a 6-digit code that changes every 30 s (mock mode never sees real seeds). */
function mockTotp(now = Date.now()): string {
  const period = Math.floor(now / 30_000)
  return String((Math.imul(period ^ 0x5bd1e995, 2654435761) >>> 0) % 1_000_000).padStart(6, '0')
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
      if (key === 'totp') return mockTotp()
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

/* ------------------------------------------------------------------ HTTP palsu (Mailpit dkk.) */

/** Parameter step di luar tipe Step yang digenerate (save_regex, poll_*, …) dibaca lewat sini. */
const param = (step: Step, name: string): unknown => (step as Record<string, unknown>)[name]

function stringRecord(v: unknown): Record<string, string> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, String(x)]))
}

/** JSONPath sederhana: `$.a.b[0]['c']`. */
function jsonPathGet(doc: unknown, path: string): unknown {
  if (!path.startsWith('$')) return undefined
  let cur: unknown = doc
  const re = /\.([A-Za-z_][\w-]*)|\[(\d+)\]|\[['"]([^'"]+)['"]\]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(path.slice(1)))) {
    if (cur === null || typeof cur !== 'object') return undefined
    const key = m[2] !== undefined ? Number(m[2]) : (m[1] ?? m[3])
    cur = (cur as Record<string | number, unknown>)[key]
  }
  return cur
}

function decodeQuotedPrintable(text: string): string {
  const unfolded = text.replace(/=[ \t]*\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < unfolded.length; i++) {
    const hex = unfolded.slice(i + 1, i + 3)
    if (unfolded[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16))
      i += 2
    } else {
      bytes.push(...new TextEncoder().encode(unfolded[i]))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function jsonStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) v.forEach((x) => jsonStrings(x, out))
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => jsonStrings(x, out))
  return out
}

/** Teks yang dicocokkan save_regex — meniru runner (runner/src/decode.ts) secukupnya. */
function regexText(body: unknown, mode: string): string {
  const raw = typeof body === 'string' ? body : JSON.stringify(body)
  if (!mode || mode === 'none') return raw
  let text = typeof body === 'string' ? body : jsonStrings(body).join('\n')
  if (mode === 'quoted_printable' || (mode === 'auto' && /=\r?\n|=3D/i.test(text))) text = decodeQuotedPrintable(text)
  if (mode === 'html' || mode === 'auto') text = text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  return text
}

const MOCK_MAIL_ID = (rng: Rng) => Array.from({ length: 22 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'[Math.floor(rng() * 56)]).join('')

/** Respons palsu untuk API Mailpit (bentuk sama dengan Mailpit v1.33) — dipakai test case email di seed. */
function mailpitResponse(url: string, ctx: { env: Record<string, string>; vars: Record<string, string> }, rng: Rng): unknown | undefined {
  const m = /\/api\/v1\/(search|messages|message\/([\w-]+)(\/raw)?)(?:[/?#]|$)/.exec(url)
  if (!m) return undefined
  const to = ctx.vars.email ?? 'qa@tokoku.id'
  const id = m[2] && !m[2].startsWith('{{') ? m[2] : MOCK_MAIL_ID(rng)
  const code = String(between(rng, 100000, 999999))
  const link = `${ctx.env.BASE_URL ?? 'https://staging.tokoku.id'}/verify?token=${MOCK_MAIL_ID(rng)}`
  const subject = 'Verify your Tokoku account'
  const text = `Hi QA,\r\n\r\nWelcome to Tokoku! Confirm your email address to activate your account.\r\n\r\nYour verification code is ${code}\r\n\r\nOr open this link:\r\n${link}\r\n`
  const htmlBody = `<p>Your verification code is <strong>${code}</strong></p>\r\n<p><a href="${link}">Verify my email</a></p>`
  const address = (a: string, name = '') => ({ Name: name, Address: a })
  if (m[1] === 'search' || m[1] === 'messages') {
    const msg = { ID: id, MessageID: `${id.slice(0, 12)}@tokoku.id`, Read: false, From: address('no-reply@tokoku.id', 'Tokoku'), To: [address(to)],
      Cc: null, Bcc: null, ReplyTo: null, Subject: subject, Created: new Date().toISOString(), Username: '', Tags: [], Size: 1971, Attachments: 0,
      Snippet: `Hi QA, Welcome to Tokoku! Confirm your email address to activate your account. Your verification code is ${code} Verify my email…` }
    return { total: 1, unread: 1, count: 1, messages_count: 1, messages_unread: 1, start: 0, tags: [], messages: [msg] }
  }
  if (m[3]) {
    // /raw: sumber RFC 822 dengan HTML quoted-printable (soft line break di tengah link)
    const qp = htmlBody.replace(/=/g, '=3D').replace(/(.{70})/g, '$1=\r\n')
    return `From: "Tokoku" <no-reply@tokoku.id>\r\nTo: <${to}>\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${qp}\r\n`
  }
  return { ID: id, MessageID: `${id.slice(0, 12)}@tokoku.id`, From: address('no-reply@tokoku.id', 'Tokoku'), To: [address(to)], Cc: [], Bcc: [], ReplyTo: [],
    ReturnPath: 'no-reply@tokoku.id', Subject: subject, Date: new Date().toISOString(), Tags: [], Username: '', Text: text, HTML: htmlBody,
    Size: 1971, Inline: [], Attachments: [] }
}

/* ------------------------------------------------------------------ REST API palsu (demo-target)
 * Meniru REST API demo-target (demo-target/server.mjs): /v1 = Tokoku shop (login, me, products CRUD,
 * orders, slow), Pay = payment-intents/refunds/test/webhooks. State per test case (seperti token &
 * produk per sesi di demo-target). Respons dari sini dipakai assertion HTTP berikutnya (expect_status,
 * expect_json, expect_header, expect_response_time) untuk expected vs actual yang realistis.
 * URL lain → respons generik lama (tanpa evaluasi assertion).
 */

interface SimResponse {
  status: number
  time_ms: number
  /** Nama header lower-case (seperti runner/Playwright). */
  headers: Record<string, string>
  body: unknown
}

interface ApiSim {
  tokens: Map<string, string> // token → email
  products: Map<string, Record<string, unknown>>
  intents: Map<string, Record<string, unknown>>
  refunds: Map<string, Record<string, unknown>>
  reads: number
  /** Respons terakhir yang berasal dari API palsu (null = belum ada / respons generik). */
  last: SimResponse | null
}

const newApiSim = (): ApiSim => ({ tokens: new Map(), products: new Map(), intents: new Map(), refunds: new Map(), reads: 0, last: null })

const MOCK_CATALOG: Record<string, unknown>[] = [
  { id: 'p_1', slug: 'plain-black-tee', name: 'Plain Black Tee', price: 90000, stock: 12, category: 'menswear' },
  { id: 'p_2', slug: 'plain-white-tee', name: 'Plain White Tee', price: 85000, stock: 7, category: 'menswear' },
  { id: 'p_3', slug: 'plaid-flannel-shirt', name: 'Plaid Flannel Shirt', price: 175000, stock: 4, category: 'menswear' },
  { id: 'p_4', slug: 'linen-blouse', name: 'Linen Blouse', price: 150000, stock: 9, category: 'ladieswear' },
  { id: 'p_5', slug: 'baseball-cap', name: 'Baseball Cap', price: 60000, stock: 20, category: 'accessories' },
  { id: 'p_6', slug: 'canvas-tote', name: 'Canvas Tote', price: 120000, stock: 0, category: 'accessories' },
]
const MOCK_CATEGORIES = ['menswear', 'ladieswear', 'accessories']
const RATE_LIMIT = 600

const hexOf = (rng: Rng, n: number) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rng() * 16)]).join('')
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

interface FakeRequest {
  method: string
  url: string
  headers: Record<string, string>
  body: string | undefined
  polling: boolean
}

/** Respons API palsu, atau undefined bila URL bukan endpoint demo-target yang dikenal. */
function fakeApiResponse(req: FakeRequest, sim: ApiSim, rng: Rng): SimResponse | undefined {
  let u: URL
  try {
    u = new URL(req.url)
  } catch {
    return undefined
  }
  const path = u.pathname.replace(/\/+$/, '')
  const shop = /\/v1\/(auth\/login|me|products(?:\/([\w-]+))?|orders(?:\/([\w-]+))?|slow)$/.exec(path)
  const pay = /\/(payment-intents(?:\/([\w-]+)(\/confirm)?)?|refunds(?:\/([\w-]+))?|test\/webhooks|v2\/health)$/.exec(path)
  if (!shop && !pay) return undefined

  const method = req.method.toUpperCase()
  const header = (name: string) => Object.entries(req.headers).find(([k]) => k.toLowerCase() === name)?.[1]
  let body: Record<string, unknown> = {}
  try {
    const v: unknown = req.body ? JSON.parse(req.body) : {}
    if (v && typeof v === 'object' && !Array.isArray(v)) body = v as Record<string, unknown>
  } catch {
    /* body bukan JSON → objek kosong */
  }
  const time = between(rng, 40, 260)
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', 'x-request-id': `req_${hexOf(rng, 16)}` }
  if (method === 'GET' && !path.endsWith('/health')) {
    sim.reads += 1
    Object.assign(headers, { 'x-ratelimit-limit': String(RATE_LIMIT), 'x-ratelimit-remaining': String(RATE_LIMIT - sim.reads), 'x-ratelimit-reset': '60' })
  }
  const res = (status: number, data: unknown, extra: Record<string, string> = {}, ms = time): SimResponse => ({
    status, time_ms: ms, headers: { ...headers, ...extra }, body: data,
  })
  const err = (status: number, code: string, message: string, details?: { path: string; message: string }[], extra: Record<string, string> = {}) =>
    res(status, { error: { code, message, ...(details?.length ? { details } : {}) } }, extra)
  const invalid = (details: { path: string; message: string }[]) => err(422, 'validation_failed', 'The request has invalid fields', details)
  const now = new Date().toISOString()

  if (shop) {
    const [, route, productId, orderId] = shop
    const token = /^Bearer\s+(.+)$/i.exec(header('authorization') ?? '')?.[1]?.trim()
    const email = token ? (sim.tokens.get(token) ?? (token === '••••' ? 'admin@tokoku.id' : undefined)) : undefined
    const unauthorized = () =>
      token
        ? err(401, 'unauthenticated', 'Invalid or expired bearer token', undefined, {
            'www-authenticate': 'Bearer realm="tokoku", error="invalid_token", error_description="The access token is invalid or expired"',
          })
        : err(401, 'unauthenticated', 'Missing bearer token: send "Authorization: Bearer <token>" (POST /api/v1/auth/login)', undefined, {
            'www-authenticate': 'Bearer realm="tokoku"',
          })
    const productErrors = (partial: boolean) => {
      const d: { path: string; message: string }[] = []
      if (!partial || body.name !== undefined) {
        if (typeof body.name !== 'string' || !body.name.trim()) d.push({ path: 'name', message: 'is required' })
      }
      if ((!partial || body.price !== undefined) && (!isInt(body.price) || body.price < 1 || body.price > 100_000_000)) {
        d.push({ path: 'price', message: 'must be an integer between 1 and 100000000 (IDR)' })
      }
      if (body.stock !== undefined && (!isInt(body.stock) || body.stock < 0)) d.push({ path: 'stock', message: 'must be an integer between 0 and 100000' })
      if (body.category !== undefined && body.category !== null && !MOCK_CATEGORIES.includes(String(body.category))) {
        d.push({ path: 'category', message: `must be one of: ${MOCK_CATEGORIES.join(', ')}` })
      }
      return d
    }

    if (route === 'auth/login' && method === 'POST') {
      const d = ['email', 'password'].filter((k) => typeof body[k] !== 'string' || !body[k]).map((k) => ({ path: k, message: 'is required' }))
      if (d.length) return invalid(d)
      const t = `tkk_${hexOf(rng, 32)}`
      sim.tokens.set(t, String(body.email))
      const name = String(body.email).startsWith('qa.2fa') ? 'QA 2FA' : 'QA Bot'
      return res(201, { data: { token: t, token_type: 'Bearer', expires_in: 3600, user: { email: body.email, name } } })
    }
    if (route === 'me' && method === 'GET') {
      if (!email) return unauthorized()
      const name = email === 'admin@tokoku.id' ? 'Tokoku Admin' : email.startsWith('qa.2fa') ? 'QA 2FA' : 'QA Bot'
      return res(200, { data: { email, name, role: email === 'admin@tokoku.id' ? 'admin' : 'customer', two_factor: email.startsWith('qa.2fa') } })
    }
    if (route === 'products' && method === 'GET') {
      const q = (u.searchParams.get('q') ?? '').toLowerCase()
      const category = u.searchParams.get('category')
      const all = [...MOCK_CATALOG, ...(email ? sim.products.values() : [])].filter(
        (p) => (!q || String(p.name).toLowerCase().includes(q)) && (!category || p.category === category),
      )
      const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit') ?? 20) || 20))
      const offset = Math.max(0, Math.floor(Number(u.searchParams.get('offset') ?? 0) || 0))
      const page = all.slice(offset, offset + limit)
      return res(200, { data: page, meta: { total: all.length, limit, offset, count: page.length, next_offset: offset + limit < all.length ? offset + limit : null } })
    }
    if (route === 'products' && method === 'POST') {
      if (!email) return unauthorized()
      const d = productErrors(false)
      if (d.length) return invalid(d)
      const id = `prd_${hexOf(rng, 16)}`
      const name = String(body.name).trim()
      const p = { id, slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}-${id.slice(4, 10)}`, name, price: body.price,
        stock: body.stock ?? 0, category: body.category ?? null, created_at: now, updated_at: now }
      sim.products.set(id, p)
      return res(201, { data: p }, { location: `/api/v1/products/${id}` })
    }
    if (productId) {
      const own = email ? sim.products.get(productId) : undefined
      const catalog = MOCK_CATALOG.find((p) => p.id === productId || p.slug === productId)
      if (method === 'GET') return own ?? catalog ? res(200, { data: own ?? catalog }) : err(404, 'not_found', `Product ${productId} not found`)
      if (method === 'PATCH' || method === 'DELETE') {
        if (!email) return unauthorized()
        if (!own) {
          return catalog
            ? err(403, 'forbidden', 'Catalog products are read-only; create your own with POST /api/v1/products')
            : err(404, 'not_found', `Product ${productId} not found`)
        }
        if (method === 'DELETE') {
          sim.products.delete(productId)
          return { status: 204, time_ms: time, headers: { 'x-request-id': headers['x-request-id'] }, body: '' }
        }
        const d = productErrors(true)
        if (d.length) return invalid(d)
        for (const k of ['name', 'price', 'stock', 'category']) if (body[k] !== undefined) own[k] = k === 'name' ? String(body[k]).trim() : body[k]
        own.updated_at = now
        return res(200, { data: own })
      }
    }
    if (route === 'orders' && method === 'POST') {
      if (!email) return unauthorized()
      const id = `ORD-${between(rng, 100000, 999999)}`
      return res(201, { data: { id, status: 'awaiting_payment', total: 90000 * (Number(body.qty) || 1) } }, { location: `/api/v1/orders/${id}` })
    }
    if (orderId && method === 'GET') {
      return res(200, { data: { id: orderId, status: 'awaiting_payment', lines: [{ sku: 'PBT-L', name: 'Plain Black Tee', size: 'L', qty: 1, price: 90000 }], total: 90000, source: 'api' } })
    }
    if (route === 'slow' && method === 'GET') {
      const ms = Math.min(Math.max(0, Number(u.searchParams.get('ms') ?? 1000) || 0), 10_000)
      return res(200, { data: { requested_ms: ms, delayed_ms: ms, max_ms: 10000 } }, {}, ms + between(rng, 2, 15))
    }
    return err(405, 'method_not_allowed', `${method} is not allowed here`)
  }

  // Tokoku Pay
  const [, route, intentId, confirm, refundId] = pay!
  if (route === 'v2/health') return { status: 200, time_ms: time, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-request-id': headers['x-request-id'] }, body: 'ok' }
  if (!header('x-api-key')) return err(401, 'missing_api_key', 'Send your API key in the X-Api-Key header')
  const refundView = (r: Record<string, unknown>, settled: boolean) =>
    ({ ...r, status: settled ? 'succeeded' : 'pending', succeeded_at: settled ? new Date(Date.parse(String(r.created_at)) + 2000).toISOString() : null })
  const refunded = (piId: string) => [...sim.refunds.values()].filter((r) => r.payment_intent === piId).reduce((s, r) => s + Number(r.amount), 0)
  const intentView = (pi: Record<string, unknown>) => ({
    ...pi, amount_refunded: refunded(String(pi.id)), amount_refundable: pi.status === 'succeeded' ? Number(pi.amount) - refunded(String(pi.id)) : 0,
  })

  if (route === 'payment-intents' && method === 'POST') {
    const d: { path: string; message: string }[] = []
    if (!isInt(body.amount) || body.amount < 1) d.push({ path: 'amount', message: 'must be an integer between 1 and 100000000 (smallest currency unit)' })
    if (!['IDR', 'USD', 'SGD'].includes(String(body.currency))) d.push({ path: 'currency', message: 'must be one of: IDR, USD, SGD' })
    if (d.length) return invalid(d)
    const pi = { id: `pi_${hexOf(rng, 16)}`, object: 'payment_intent', amount: body.amount, currency: body.currency, status: 'requires_payment',
      description: null, created_at: now, confirmed_at: null }
    sim.intents.set(pi.id, pi)
    return res(201, { data: intentView(pi) }, { location: `/api/v2/payment-intents/${pi.id}` })
  }
  if (intentId) {
    const pi = sim.intents.get(intentId)
    if (!pi) return err(404, 'not_found', `Payment intent ${intentId} not found`)
    if (confirm && method === 'POST') {
      if (pi.status === 'requires_payment') Object.assign(pi, { status: 'succeeded', confirmed_at: now })
      return res(200, { data: intentView(pi) })
    }
    if (!confirm && method === 'GET') return res(200, { data: intentView(pi) })
  }
  if (route === 'refunds' && method === 'POST') {
    if (typeof body.payment_intent !== 'string' || !body.payment_intent) return invalid([{ path: 'payment_intent', message: 'is required' }])
    const pi = sim.intents.get(body.payment_intent)
    if (!pi) return err(404, 'not_found', `Payment intent ${body.payment_intent} not found`)
    if (pi.status !== 'succeeded') return err(409, 'invalid_state', `Payment intent ${pi.id} has not been paid yet (status ${pi.status}); confirm it first`)
    const refundable = Number(pi.amount) - refunded(String(pi.id))
    const amount = isInt(body.amount) ? body.amount : refundable
    if (amount > refundable || refundable === 0) {
      return err(422, 'amount_exceeds_refundable', `Refund amount ${amount} exceeds the refundable amount ${refundable}`,
        [{ path: 'amount', message: `must be at most ${refundable}` }])
    }
    const r = { id: `re_${hexOf(rng, 16)}`, object: 'refund', payment_intent: pi.id, amount, currency: pi.currency, reason: null, created_at: now }
    sim.refunds.set(r.id, r)
    return res(201, { data: refundView(r, false) }, { location: `/api/v2/refunds/${r.id}` })
  }
  if (refundId && method === 'GET') {
    const r = sim.refunds.get(refundId)
    // Polling: percobaan terakhir melihat refund yang sudah selesai (DEMO_REFUND_DELAY_MS di demo-target).
    return r ? res(200, { data: refundView(r, req.polling) }) : err(404, 'not_found', `Refund ${refundId} not found`)
  }
  if (route === 'test/webhooks' && method === 'POST') {
    const events = ['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed']
    if (!events.includes(String(body.event))) return invalid([{ path: 'event', message: `must be one of: ${events.join(', ')}` }])
    const t = Math.floor(Date.now() / 1000)
    const id = `evt_${hexOf(rng, 16)}`
    return res(200, { delivered: true, event: body.event, id, signature: `t=${t},v1=${hexOf(rng, 64)}`, payload: JSON.stringify({ id, type: body.event, created: t }) })
  }
  return err(405, 'method_not_allowed', `${method} is not allowed here`)
}

/* ------------------------------------------------------------------ assertion HTTP (seperti runner/src/actions.ts) */

const asText = (v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v))

function looseEquals(actual: unknown, expected: unknown): boolean {
  if (JSON.stringify(actual) === JSON.stringify(expected)) return true
  if (typeof expected !== 'string') return false
  if (typeof actual === 'string') return actual === expected
  try {
    if (JSON.stringify(actual) === JSON.stringify(JSON.parse(expected))) return true
  } catch {
    /* bukan JSON */
  }
  return actual !== null && typeof actual !== 'object' && String(actual) === expected
}

function toRegExp(pattern: string): RegExp | null {
  const lit = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(pattern)
  try {
    return lit ? new RegExp(lit[1], lit[2]) : new RegExp(pattern)
  } catch {
    return null
  }
}

/** Evaluasi assertion HTTP terhadap respons API palsu terakhir: { pass, expected, actual, error }. */
function checkHttpAssertion(step: Step, last: SimResponse): { pass: boolean; expected: string; actual: string; error: string } | undefined {
  const p = (name: string) => param(step, name)
  switch (step.action) {
    case 'expect_status': {
      const list = Array.isArray(p('in')) ? (p('in') as unknown[]).map(Number) : null
      const expected = list ? `in [${list.join(', ')}]` : String(Number(step.value))
      const actual = String(last.status)
      const pass = list ? list.includes(last.status) : last.status === Number(step.value)
      return { pass, expected, actual, error: `Expected status ${expected}, received ${actual}` }
    }
    case 'expect_json': {
      const path = String(step.path ?? '')
      const op = String(step.op ?? 'eq')
      const v = typeof last.body === 'object' ? jsonPathGet(last.body, path) : undefined
      const found = v !== undefined
      const want = step.value
      const actual = found ? asText(v) : '(missing)'
      const expected = op === 'exists' ? 'exists' : op === 'eq' ? asText(want ?? '') : `${op} ${asText(want ?? '')}`
      let pass = false
      if (op === 'exists') pass = found
      else if (op === 'eq') pass = found && looseEquals(v, want)
      else if (op === 'neq') pass = !(found && looseEquals(v, want))
      else if (op === 'contains') {
        pass = found && (typeof v === 'string' ? v.includes(asText(want)) : Array.isArray(v) ? v.some((x) => looseEquals(x, want)) : v !== null && typeof v === 'object' && asText(want) in (v as object))
      } else if (op === 'gt' || op === 'lt') {
        const a = Number(v)
        const b = Number(want)
        pass = found && v !== null && v !== '' && Number.isFinite(a) && Number.isFinite(b) && (op === 'gt' ? a > b : a < b)
      } else if (op === 'matches') pass = found && (toRegExp(asText(want))?.test(asText(v)) ?? false)
      const error = op === 'exists'
        ? `Expected ${path} to exist, but it is missing`
        : !found && op !== 'neq'
          ? `Expected ${path} ${op} ${JSON.stringify(asText(want))}, but ${path} is missing`
          : `Expected ${path} ${op} ${JSON.stringify(asText(want))}, received ${actual}`
      return { pass, expected, actual, error }
    }
    case 'expect_header': {
      const name = String(step.name ?? '').toLowerCase()
      const expected = asText(step.value ?? '')
      const mode = step.match || 'contains'
      const actual = last.headers[name]
      const pass = actual !== undefined && (mode === 'equals' ? actual === expected : mode === 'regex' ? (toRegExp(expected)?.test(actual) ?? false) : actual.includes(expected))
      const phrase = mode === 'equals' ? `to equal ${JSON.stringify(expected)}` : mode === 'regex' ? `to match ${toRegExp(expected) ?? expected}` : `to contain ${JSON.stringify(expected)}`
      return actual === undefined
        ? { pass, expected, actual: '(missing)', error: `Expected header ${name} ${phrase}, but the response has no ${name} header` }
        : { pass, expected, actual, error: `Expected header ${name} ${phrase}, received ${JSON.stringify(actual)}` }
    }
    case 'expect_response_time': {
      const max = Number(p('max_ms'))
      return { pass: last.time_ms <= max, expected: `<= ${max} ms`, actual: `${last.time_ms} ms`, error: `Expected response time <= ${max} ms, took ${last.time_ms} ms` }
    }
    default:
      return undefined
  }
}

/* ------------------------------------------------------------------ pembuatan run */

type StepPlan = SimPlan & { details?: Record<string, unknown>; saves?: Record<string, string> }

function planStep(
  step: Step,
  tc: DbTestCase,
  isLastAssertion: boolean,
  timeout: number,
  interpolated: Step,
  rng: Rng,
  vctx: { env: Record<string, string>; vars: Record<string, string> } = { env: {}, vars: {} },
  api: ApiSim = newApiSim(),
): StepPlan {
  if (step.action === 'manual') return { outcome: 'passed', duration_ms: 0 }
  let fail = containsFailMarker(step)
  if (!fail && (step.action === 'expect_text' || step.action === 'expect_value')) {
    const truth = MOCK_TRUTH[interpolated.selector ?? '']
    if (truth !== undefined) fail = !matches(truth, String(interpolated.value ?? ''), step.match)
  }
  // Assertion HTTP setelah respons API palsu: dievaluasi sungguhan (expected vs actual seperti runner).
  const httpCheck = !fail && api.last ? checkHttpAssertion(interpolated, api.last) : undefined
  if (httpCheck && !httpCheck.pass) {
    return { outcome: 'failed', error: httpCheck.error, duration_ms: 3, details: { expected: httpCheck.expected, actual: httpCheck.actual } }
  }
  if (!fail && isLastAssertion && tc.tags.includes('flaky')) fail = rng() < 0.4
  if (fail) {
    const f = failureFor(step, timeout, interpolated)
    return { outcome: 'failed', error: f.error, duration_ms: f.duration, details: f.details }
  }
  let details: Record<string, unknown> | undefined
  let saves: Record<string, string> | undefined
  let duration: number | undefined // undefined → normalDuration (dipanggil terakhir: urutan rng run lama tetap)
  if (step.action === 'http_request') {
    const status = interpolated.method === 'POST' ? 201 : 200
    const mail = mailpitResponse(interpolated.url ?? '', vctx, rng)
    const pollTimeoutMs = Number(param(interpolated, 'poll_timeout_ms') ?? 0)
    let fake: SimResponse | undefined
    let request: Record<string, unknown> = { method: interpolated.method ?? 'GET', url: interpolated.url }
    if (!mail) {
      // headers/query adalah objek → tidak ikut interpolateStep; secret tetap ••••.
      const ictx: VarContext = { env: vctx.env, secretNames: [], vars: vctx.vars }
      const headers = Object.fromEntries(Object.entries(stringRecord(param(step, 'headers'))).map(([k, v]) => [k, interpolate(v, ictx)]))
      const query = Object.entries(stringRecord(param(step, 'query'))).map(([k, v]) => [k, interpolate(v, ictx)])
      let url = interpolated.url ?? ''
      if (query.length) {
        try {
          const u = new URL(url)
          for (const [k, v] of query) u.searchParams.append(k, v)
          url = u.toString()
        } catch {
          /* URL tidak valid → apa adanya */
        }
      }
      const bodyText = typeof interpolated.body === 'string' ? interpolated.body : interpolated.body ? JSON.stringify(interpolated.body) : undefined
      fake = fakeApiResponse({ method: interpolated.method ?? 'GET', url, headers, body: bodyText, polling: pollTimeoutMs > 0 }, api, rng)
      if (fake) {
        let shownBody: unknown = bodyText
        try {
          shownBody = bodyText ? JSON.parse(bodyText) : undefined
        } catch {
          /* teks biasa */
        }
        request = { method: (interpolated.method ?? 'GET').toUpperCase(), url, ...(Object.keys(headers).length ? { headers } : {}), ...(shownBody !== undefined ? { body: shownBody } : {}) }
      }
    }
    api.last = fake ?? null
    const response = fake ?? {
      status,
      time_ms: between(rng, 80, 600),
      body: mail ?? (interpolated.method === 'POST' ? { data: { id: `ord_${between(rng, 1000, 9999)}`, status: 'created' } } : { data: [{ id: 'p_1', name: 'Plain Black T-shirt', price: 90000 }], meta: { total: 1 } }),
    }
    details = { request, response }
    // save / save_regex → vars untuk step berikutnya (seperti runner)
    saves = {}
    for (const [name, path] of Object.entries(stringRecord(param(interpolated, 'save')))) {
      const v = jsonPathGet(response.body, path)
      if (v !== undefined) saves[name] = typeof v === 'string' ? v : JSON.stringify(v)
      else if (fake) return { outcome: 'failed', error: `Cannot save "${name}": ${path} not found in the response`, duration_ms: response.time_ms, details }
    }
    const regexes = stringRecord(param(interpolated, 'save_regex'))
    if (Object.keys(regexes).length) {
      const text = regexText(response.body, String(param(interpolated, 'regex_decode') ?? 'none'))
      for (const [name, pattern] of Object.entries(regexes)) {
        let match: RegExpExecArray | null = null
        try {
          match = new RegExp(pattern).exec(text)
        } catch {
          /* pola tidak valid → nilai contoh */
        }
        saves[name] = match ? (match[1] ?? match[0]) : `mock-${name}`
      }
    }
    // Polling: email/refund "datang" setelah beberapa percobaan.
    const pollTimeout = pollTimeoutMs
    if (pollTimeout > 0) {
      const interval = Math.max(200, Number(param(interpolated, 'poll_interval_ms') ?? 1000))
      const attempts = Math.min(between(rng, 2, 4), Math.max(1, Math.floor(pollTimeout / interval)))
      details.attempts = attempts
      duration = (attempts - 1) * interval + response.time_ms
    }
  }
  if (step.action === 'set_variable' && interpolated.name) saves = { [interpolated.name]: String(interpolated.value ?? '') }
  if (step.action === 'expect_text' || step.action === 'expect_value') {
    const truth = MOCK_TRUTH[interpolated.selector ?? '']
    details = { expected: String(interpolated.value ?? ''), actual: truth ?? String(interpolated.value ?? '') }
  }
  if (httpCheck) details = { expected: httpCheck.expected, actual: httpCheck.actual }
  return { outcome: 'passed', duration_ms: duration ?? normalDuration(step, rng), details, saves }
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
  const runtime: Record<string, string> = {} // hasil save / save_regex / set_variable
  const api = newApiSim() // state API palsu per test case (token, produk, payment intent, refund)
  const steps: DbRunStep[] = tc.steps.map((step, i): DbRunStep => {
    const vars = { ...tc.variables, ...ctx.vars, ...runtime }
    const interp = interpolateStep(step, { ...ctx, vars })
    const timeout = step.timeout_ms ?? run.options.step_timeout_ms
    if (step.enabled !== false && step.action.startsWith('expect_')) assertCounter += 1
    const plan = step.enabled === false ? undefined : planStep(step, tc, assertCounter === lastAssertIdx && step.action.startsWith('expect_'), timeout, interp, rng, { env: ctx.env, vars }, api)
    if (plan?.outcome === 'passed' && plan.saves) Object.assign(runtime, plan.saves)
    return {
      id: newId('rs'),
      position: i + 1,
      step_id: step.id,
      action: step.action,
      summary: summarizeStep(interp, { lng: 'en' }), // data run dari server → English
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
    run.error_message = 'No enabled test cases to run'
    run.finished_at = run.queued_at
  }
  return run
}

/* ------------------------------------------------------------------ artifacts */

const PAGE_VARIANTS: [RegExp, string][] = [
  [/login|log in|otp|logout|password|auth|2fa|sign up|signup|verify|email/i, 'login'],
  [/keranjang|cart/i, 'cart'],
  [/checkout|voucher|bayar|pembayaran|payment|invoice|order/i, 'checkout'],
  [/produk|product|katalog|catalog|cari|search|filter/i, 'catalog'],
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
    storage: activeStorageBackend(),
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
  if (run.status === 'error' && !run.error_message) run.error_message = 'Infrastructure error during execution'
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
  if (!c || c.execution !== 'manual') return 'Case is not a manual case'
  if (c.steps.some((s) => s.status === 'pending')) return 'Some steps are not marked yet'
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
