// Shared helpers for the manual's screenshot and video scripts.
// Run the scripts from web/ so `@playwright/test` resolves from web/node_modules:
//   cd web && node ../docs/manual/scripts/screenshots.mjs
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(path.join(process.cwd(), 'package.json'))
export const { chromium } = require('@playwright/test')

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const MANUAL_DIR = path.resolve(HERE, '..')
export const IMG_DIR = path.join(MANUAL_DIR, 'img')
export const VIDEO_DIR = path.join(MANUAL_DIR, 'video')

export const BASE = (process.env.QATLAS_URL ?? 'http://127.0.0.1:8090').replace(/\/$/, '')
export const PASSWORD = process.env.QATLAS_DEMO_PASSWORD ?? 'password123'
export const USERS = {
  admin: { email: 'rina@tokoku.id', name: 'Rina Kusuma' },
  editor: { email: 'dimas@tokoku.id', name: 'Dimas Pratama' },
  viewer: { email: 'sari@tokoku.id', name: 'Sari Wulandari' },
}
/** Public placeholder that replaces the real origin and any secret in redacted shots. */
export const PUBLIC_ORIGIN = 'https://qatlas.example.com'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * A browser context with the theme fixed before the SPA boots (it reads localStorage
 * `qatlas.theme`). `mobile` gives a 390px phone viewport.
 */
export async function newContext(browser, { theme = 'light', mobile = false, video = null, viewport } = {}) {
  const ctx = await browser.newContext({
    viewport: viewport ?? (mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }),
    deviceScaleFactor: mobile ? 2 : 1,
    isMobile: mobile,
    hasTouch: mobile,
    colorScheme: theme,
    locale: 'en-US',
    timezoneId: 'Asia/Jakarta',
    baseURL: BASE,
    ...(video ? { recordVideo: { dir: video.dir, size: video.size } } : {}),
  })
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem('qatlas.theme', t)
    } catch {
      /* ignore */
    }
  }, theme)
  return ctx
}

export async function login(page, email = USERS.admin.email) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(PASSWORD)
  await page.getByRole('button', { name: /^(Sign in|Masuk)$/ }).click()
  await page.waitForURL((u) => !u.pathname.startsWith('/login'))
}

/** JSON API call with the page's session cookie (CSRF header as the SPA sends it). */
export async function api(page, method, url, data) {
  const res = await page.request.fetch(`/api/v1${url}`, {
    method,
    data,
    headers: { 'X-QAtlas-CSRF': '1' },
  })
  const text = await res.text()
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${text}`)
  return text ? JSON.parse(text) : null
}

const FINAL = ['passed', 'failed', 'error', 'cancelled']

export async function waitForRun(page, key, until = FINAL, timeoutMs = 120_000) {
  const t0 = Date.now()
  for (;;) {
    const run = await api(page, 'GET', `/runs/${key}`)
    if (until.includes(run.status)) return run
    if (FINAL.includes(run.status)) throw new Error(`run ${key} ended as ${run.status}, wanted ${until}`)
    if (Date.now() - t0 > timeoutMs) throw new Error(`run ${key} still ${run.status}`)
    await sleep(700)
  }
}

/** Starts a run through the API and waits for one of `until`. Returns the run. */
export async function startRun(page, project, target, { options, until = FINAL } = {}) {
  const run = await api(page, 'POST', `/projects/${project}/runs`, { ...target, ...(options ? { options } : {}) })
  return waitForRun(page, run.key, until)
}

/** Waits until loading skeletons are gone and the UI had time to finish transitions. */
export async function settle(page, ms = 600) {
  await page.waitForLoadState('domcontentloaded')
  await page.evaluate(() => document.fonts.ready)
  await page
    .waitForFunction(() => document.querySelectorAll('.animate-pulse').length === 0, null, { timeout: 15_000 })
    .catch(() => {})
  await page.waitForTimeout(ms)
}

/** Hides toasts so they never cover content in a still. */
export async function hideToasts(page) {
  await page.addStyleTag({ content: '[data-sonner-toaster]{display:none!important}' })
}

/**
 * Replaces secrets and the instance origin in the visible DOM (text nodes and input values)
 * before a screenshot. Every pair is [RegExp|string, replacement].
 */
export async function redact(page, pairs) {
  await page.evaluate((list) => {
    const rules = list.map(([src, flags, rep]) => [new RegExp(src, flags), rep])
    const fix = (s) => rules.reduce((acc, [re, rep]) => acc.replace(re, rep), s)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const next = fix(n.nodeValue)
      if (next !== n.nodeValue) n.nodeValue = next
    }
    for (const el of document.querySelectorAll('input, textarea')) {
      const next = fix(el.value)
      if (next !== el.value) el.value = next
    }
  }, pairs.map(([re, rep]) => (re instanceof RegExp ? [re.source, re.flags, rep] : [re.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g', rep])))
}

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
