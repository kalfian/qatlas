// Regenerates the PNGs in docs/manual/img against a running QAtlas seeded with `qatlas seed demo`
// (for example `scripts/demo-server.sh start`). It creates data on that instance: a few runs,
// one user invite (Nina Lestari, only if missing) and one API token that is revoked right away.
//
//   cd web && node ../docs/manual/scripts/screenshots.mjs            # every shot
//   cd web && node ../docs/manual/scripts/screenshots.mjs editor     # shots whose name contains "editor"
//
// Env: QATLAS_URL (default http://127.0.0.1:8090).
import fs from 'node:fs'
import path from 'node:path'
import {
  PUBLIC_ORIGIN,
  USERS,
  api,
  BASE,
  chromium,
  escapeRe,
  hideToasts,
  IMG_DIR,
  login,
  newContext,
  redact,
  settle,
  startRun,
  waitForRun,
} from './lib.mjs'

const only = process.argv.slice(2)
fs.mkdirSync(IMG_DIR, { recursive: true })

const browser = await chromium.launch()
const done = []

async function shot(page, name, opts = {}) {
  const file = path.join(IMG_DIR, `${name}.png`)
  await page.screenshot({ path: file, ...opts })
  done.push(name)
  console.log('  ✓', name)
}

function wanted(name) {
  return only.length === 0 || only.some((o) => name.includes(o))
}

/* ------------------------------------------------------------------ fixtures */

// One signed-in admin context for most shots.
const ctx = await newContext(browser)
const page = await ctx.newPage()
await login(page)
await hideToasts(page).catch(() => {})
page.on('load', () => hideToasts(page).catch(() => {}))

/** Latest run of `target` with `status` (and optional predicate), else start one. */
async function ensureRun(target, status, { options, pred = () => true } = {}) {
  const key = target.test_case ?? target.flow
  const list = await api(page, 'GET', `/projects/SHOP/runs?target=${key}&status=${status}&limit=25`)
  for (const r of list.data.slice(0, 10)) {
    const full = await api(page, 'GET', `/runs/${r.key}`)
    if (pred(full)) return full
  }
  return startRun(page, 'SHOP', target, { options, until: [status] })
}

let mediaRun // flow run with screenshots on every step + video
let failedRun // failed voucher run with a screenshot on the failing step
async function fixtures() {
  mediaRun ??= await ensureRun({ flow: 'SHOP-F1' }, 'passed', {
    options: { screenshot: 'every_step', video: 'always' },
    pred: (r) => r.options?.video === 'always',
  })
  failedRun ??= await ensureRun({ test_case: 'SHOP-T12' }, 'failed')
}

// SHOP-T8 (product page → cart) on three devices (docs/14). The demo seed has no responsive test cases, so
// this adds an "expect_no_horizontal_scroll" step limited to tablet + mobile to SHOP-T8 first (as e2e J15
// does); the demo shop's size chart is too wide for the iPhone on purpose.
let responsiveRun
async function responsiveFixture() {
  if (responsiveRun) return
  const tc = await api(page, 'GET', '/test-cases/SHOP-T8')
  if (!tc.steps.some((s) => s.action === 'expect_no_horizontal_scroll')) {
    const step = { id: 'shots-no-hscroll', action: 'expect_no_horizontal_scroll', only_on: ['tablet', 'mobile'], description: 'The product page fits the screen' }
    await api(page, 'PATCH', '/test-cases/SHOP-T8', { revision: tc.revision, title: tc.title, steps: [...tc.steps, step] })
  }
  responsiveRun = await ensureRun({ test_case: 'SHOP-T8' }, 'failed', {
    options: { devices: [{ id: 'desktop' }, { id: 'ipad-mini' }, { id: 'iphone-15' }] },
    pred: (r) => r.options?.devices?.length === 3,
  })
}

/* ------------------------------------------------------------------ shots */

const shots = {
  async 'login'() {
    const c = await newContext(browser)
    const p = await c.newPage()
    await p.goto('/login')
    await settle(p)
    await p.getByLabel('Email', { exact: true }).fill(USERS.admin.email)
    await p.getByLabel('Password', { exact: true }).fill('password123')
    await p.getByLabel('Email', { exact: true }).blur()
    await shot(p, 'login')
    await c.close()
  },

  async 'projects'() {
    await page.goto('/projects')
    await settle(page)
    await shot(page, 'projects')
  },

  async 'dashboard'() {
    await page.goto('/p/SHOP')
    await settle(page, 900)
    await shot(page, 'dashboard')
  },

  async 'test-cases-list'() {
    await page.goto('/p/SHOP/tests')
    await settle(page)
    await shot(page, 'test-cases-list')
  },

  async 'step-editor-panel'() {
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('option', { name: /^Step 5,/ }).click()
    await settle(page, 500)
    await shot(page, 'step-editor-panel')
  },

  async 'action-palette'() {
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('button', { name: 'Add step' }).click()
    await page.getByRole('combobox', { name: 'Search actions' }).fill('http')
    await page.waitForTimeout(500)
    await shot(page, 'action-palette')
    await page.keyboard.press('Escape')
  },

  async 'step-editor-json'() {
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('radio', { name: 'JSON' }).or(page.getByRole('button', { name: 'JSON', exact: true })).first().click()
    await settle(page, 700)
    await shot(page, 'step-editor-json')
  },

  async 'editor-shortcuts'() {
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('button', { name: 'Shortcuts' }).click()
    await page.waitForTimeout(500)
    await shot(page, 'editor-shortcuts')
    await page.keyboard.press('Escape')
  },

  async 'manual-test-case-editor'() {
    await page.goto('/p/SHOP/tests/SHOP-T14')
    await settle(page)
    await page.getByRole('option', { name: /^Step 2,/ }).click()
    await settle(page, 500)
    await shot(page, 'manual-test-case-editor')
  },

  async 'flow-builder'() {
    await page.goto('/p/SHOP/flows/SHOP-F3')
    await settle(page)
    await shot(page, 'flow-builder')
  },

  async 'flows-list'() {
    await page.goto('/p/SHOP/flows')
    await settle(page)
    await shot(page, 'flows-list')
  },

  async 'run-dialog'() {
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('button', { name: /^Run$/ }).click()
    const dialog = page.getByRole('dialog')
    await dialog.locator('[aria-label="Screenshot"]').getByText('Every step').click()
    await dialog.locator('[aria-label="Video"]').getByText('On failure').click()
    await page.waitForTimeout(500)
    await shot(page, 'run-dialog')
    await page.keyboard.press('Escape')
  },

  async 'run-devices-picker'() {
    await page.goto('/p/SHOP/tests/SHOP-T8')
    await settle(page)
    await page.getByRole('button', { name: /^Run$/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: /^Devices / }).click()
    for (const name of ['iPad Mini 768×1024', 'iPhone 15 393×659']) {
      const box = page.getByRole('checkbox', { name })
      if ((await box.getAttribute('data-state')) !== 'checked') await box.click()
    }
    await page.waitForTimeout(400)
    await shot(page, 'run-devices-picker')
    await page.keyboard.press('Escape')
    await page.keyboard.press('Escape')
  },

  async 'run-matrix'() {
    await responsiveFixture()
    await page.goto(`/p/SHOP/runs/${responsiveRun.key}`)
    await settle(page, 900)
    await shot(page, 'run-matrix')
  },

  async 'run-overflow-offenders'() {
    await responsiveFixture()
    await page.goto(`/p/SHOP/runs/${responsiveRun.key}`)
    await settle(page, 900)
    await page
      .getByRole('table', { name: 'Results per test case and device' })
      .getByRole('button', { name: /SHOP-T8 .* on iPhone 15 · 393×659: Failed/ })
      .click()
    const offenders = page.getByRole('region', { name: /^Cases on iPhone 15/ }).getByText('Elements past the right edge')
    await offenders.scrollIntoViewIfNeeded()
    await page.waitForTimeout(500)
    await shot(page, 'run-overflow-offenders')
  },

  async 'run-live'() {
    // The voucher case waits 10 s on its failing assertion: enough to catch it mid-run.
    await page.goto('/p/SHOP/tests/SHOP-T12')
    await settle(page)
    await page.getByRole('button', { name: /^Run$/ }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }).click()
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    await page.locator('[data-status="running"]').first().waitFor({ timeout: 30_000 })
    await page.getByText('expect_text').first().waitFor()
    await page.waitForTimeout(3500)
    await shot(page, 'run-live')
    const key = page.url().match(/SHOP-R\d+/)[0]
    failedRun = await waitForRun(page, key)
  },

  async 'run-failed-report'() {
    await fixtures()
    await page.goto(`/p/SHOP/runs/${failedRun.key}`)
    await settle(page, 900)
    await shot(page, 'run-failed-report')
  },

  async 'screenshot-lightbox'() {
    await fixtures()
    await page.goto(`/p/SHOP/runs/${mediaRun.key}`)
    await settle(page)
    await page.getByRole('tab', { name: /Screenshots/ }).click()
    await page.evaluate(() => document.activeElement?.blur())
    await settle(page, 800)
    await shot(page, 'run-screenshots-tab')
    await page.getByRole('button', { name: /^Open Screenshot/ }).nth(9).click()
    await page.waitForTimeout(900)
    await shot(page, 'screenshot-lightbox')
    await page.keyboard.press('Escape')
  },

  async 'run-video-tab'() {
    await fixtures()
    await page.goto(`/p/SHOP/runs/${mediaRun.key}`)
    await settle(page)
    await page.getByRole('tab', { name: /Video/ }).click()
    await page.evaluate(() => document.activeElement?.blur())
    await settle(page, 600)
    // Show a frame from the middle of the recording instead of the blank first frame.
    await page.evaluate(async () => {
      const v = document.querySelector('video')
      if (!v) return
      await new Promise((r) => (v.readyState >= 1 ? r() : v.addEventListener('loadedmetadata', r, { once: true })))
      v.currentTime = Math.min(v.duration * 0.35 || 0.5, 4)
      await new Promise((r) => v.addEventListener('seeked', r, { once: true }))
    })
    await page.waitForTimeout(500)
    await shot(page, 'run-video-tab')
  },

  async 'run-http-details'() {
    const run = await ensureRun({ test_case: 'SHOP-T16' }, 'passed')
    await page.goto(`/p/SHOP/runs/${run.key}`)
    await settle(page)
    await page.getByRole('button', { name: /http_request/ }).first().click().catch(async () => {
      await page.getByText('http_request').first().click()
    })
    await settle(page, 600)
    await shot(page, 'run-http-details')
  },

  async 'runs-history'() {
    await page.goto('/p/SHOP/runs?kind=test_case')
    await settle(page)
    await page.getByRole('button', { name: /^Status/ }).or(page.getByRole('combobox', { name: /^Status/ })).first().click()
    await page.waitForTimeout(500)
    await shot(page, 'runs-history')
    await page.keyboard.press('Escape')
  },

  async 'manual-execution'() {
    // An F3 run waiting for the signed-in user (seeded SHOP-R3, or a fresh one).
    let tasks = await api(page, 'GET', '/me/manual-runs')
    let task = (tasks.data ?? tasks).find((r) => r.target?.key === 'SHOP-F3')
    if (!task) task = await startRun(page, 'SHOP', { flow: 'SHOP-F3' }, { until: ['awaiting_manual'] })

    await page.goto('/my-tasks')
    await settle(page)
    await shot(page, 'my-tasks')

    await page.getByRole('link', { name: new RegExp(`Work on ${task.key}:`) }).click()
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    await settle(page, 800)
    const decisions = page.getByRole('group', { name: 'Step result' })
    await decisions.getByRole('button', { name: /Pass/ }).click()
    await page.waitForTimeout(600)
    await decisions.getByRole('button', { name: /Fail/ }).click()
    await page.getByLabel('Actual result').fill('The store address in the header still shows the old Bandung office.')
    await page.waitForTimeout(500)
    await page.mouse.move(0, 0)
    await shot(page, 'manual-execution')

    await page.getByLabel('Actual result').press('Control+Enter')
    await decisions.getByRole('button', { name: /Pass/ }).click()
    await page.getByRole('button', { name: 'Finish', exact: true }).first().click()
    await page.getByRole('dialog').getByRole('button', { name: /^(Finish|Mark the rest Skipped & finish)$/ }).click()
    await waitForRun(page, task.key)
  },

  async 'manual-result'() {
    // The latest finished F3 run: the manual case's results inside the run report.
    const list = await api(page, 'GET', '/projects/SHOP/runs?target=SHOP-F3&limit=25')
    const run = list.data.find((r) => ['passed', 'failed'].includes(r.status))
    if (!run) throw new Error('no finished SHOP-F3 run yet: run the manual-execution shot first')
    await page.goto(`/p/SHOP/runs/${run.key}`)
    await settle(page, 800)
    const row = page.locator('[aria-expanded]').filter({ hasText: 'SHOP-T14' }).first()
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click()
    await settle(page, 600)
    await page.mouse.move(0, 0)
    await shot(page, 'manual-execution-done')
  },

  async 'environments'() {
    await page.goto('/p/SHOP/environments')
    await settle(page)
    await page.getByRole('button', { name: 'Secret', exact: true }).click()
    await page.getByLabel(/^(Name|Key)$/).first().fill('PAYMENT_SANDBOX_KEY').catch(() => {})
    await page.waitForTimeout(500)
    await shot(page, 'environments-secret-dialog')
    await page.keyboard.press('Escape')
    await page.waitForTimeout(300)
    await shot(page, 'environments')
  },

  async 'project-members'() {
    await page.goto('/p/SHOP/settings?section=members')
    await settle(page)
    await shot(page, 'project-members')
  },

  async 'admin-users'() {
    await page.goto('/admin/users')
    await settle(page)
    await shot(page, 'admin-users')

    const users = await api(page, 'GET', '/admin/users')
    const exists = (users.data ?? users).some((u) => u.email === 'nina@tokoku.id')
    if (!exists) {
      await page.getByRole('button', { name: 'Create user' }).first().click()
      const dialog = page.getByRole('dialog')
      await dialog.getByLabel('Email').fill('nina@tokoku.id')
      await dialog.getByLabel('Name').fill('Nina Lestari')
      await dialog.getByRole('button', { name: 'Create user' }).click()
    } else {
      // Re-issue the invite link of the existing invited user.
      await page.getByRole('button', { name: /Actions for Nina Lestari|More actions.*Nina/ }).first().click()
      await page.getByRole('menuitem', { name: /invite link/i }).click()
      const confirm = page.getByRole('alertdialog')
      if (await confirm.isVisible().catch(() => false)) await confirm.getByRole('button').last().click()
    }
    const input = page.locator('#invite-url')
    await input.waitFor()
    await page.waitForTimeout(500)
    await page.locator('#invite-url').blur()
    const url = await input.inputValue()
    const origin = new URL(url).origin
    await redact(page, [
      [new RegExp(`${escapeRe(origin)}/invite/[A-Za-z0-9_-]+`, 'g'), `${PUBLIC_ORIGIN}/invite/xxxxxxxxxxxxxxxxxxxxxxxx`],
    ])
    await shot(page, 'admin-invite-link')
    await page.keyboard.press('Escape')
  },

  async 'api-token'() {
    await page.goto('/settings/tokens')
    await settle(page)
    await page.getByRole('button', { name: 'Create token' }).first().click()
    const dialog = page.getByRole('dialog')
    await dialog.getByLabel('Name', { exact: true }).fill('Claude Code laptop')
    await dialog.locator('#token-scope-write').check()
    await dialog.locator('#token-scope-run').check()
    await page.waitForTimeout(300)
    await redact(page, [[new URL(BASE).origin, PUBLIC_ORIGIN]])
    await shot(page, 'api-token-create')
    await dialog.getByRole('button', { name: 'Create token' }).click()
    const secretInput = dialog.locator('#token-secret')
    await secretInput.waitFor()
    const secret = await secretInput.inputValue()
    try {
      await redact(page, [
        [secret, 'qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'],
        [/qat_[0-9a-f]{8}(?=…|_|\b)/g, 'qat_xxxxxxxx'],
        [new URL(BASE).origin, PUBLIC_ORIGIN],
      ])
      await page.waitForTimeout(400)
      await shot(page, 'api-token-created')
    } finally {
      // Never leave a working token behind: revoke it straight away.
      await dialog.getByRole('button', { name: "I've copied it" }).click().catch(() => page.keyboard.press('Escape'))
      const tokens = await api(page, 'GET', '/me/tokens')
      for (const t of tokens.data ?? tokens) {
        if (t.name === 'Claude Code laptop' && !t.revoked_at) await api(page, 'DELETE', `/me/tokens/${t.id}`)
      }
    }
    await page.reload()
    await settle(page)
    await redact(page, [
      [/qat_[0-9a-f]{8}(?=…|_|\b)/g, 'qat_xxxxxxxx'],
      [new URL(BASE).origin, PUBLIC_ORIGIN],
    ])
    await shot(page, 'api-tokens')
  },

  async 'account-language'() {
    await page.goto('/settings/profile')
    await settle(page)
    const card = page.getByText('Language', { exact: true }).first().locator('xpath=ancestor::section[1]')
    await card.scrollIntoViewIfNeeded().catch(() => {})
    await shot(page, 'account-language')
  },

  async 'command-palette'() {
    await page.goto('/p/SHOP')
    await settle(page)
    await page.keyboard.press('Control+k')
    await page.keyboard.type('checkout')
    await page.waitForTimeout(700)
    await shot(page, 'command-palette')
    await page.keyboard.press('Escape')
  },

  /* ---------------------------------------------------- Indonesian UI (as Dimas) */
  async 'ui-indonesian'() {
    const c = await newContext(browser)
    const p = await c.newPage()
    await login(p, USERS.editor.email)
    await hideToasts(p)
    try {
      await api(p, 'PATCH', '/me', { locale: 'id' })
      await p.goto('/p/SHOP/tests/SHOP-T12')
      await settle(p)
      await p.getByRole('option').nth(4).click()
      await settle(p, 500)
      await shot(p, 'ui-indonesian-step-editor')
      await p.goto('/p/SHOP')
      await settle(p, 900)
      await shot(p, 'ui-indonesian-dashboard')
    } finally {
      await api(p, 'PATCH', '/me', { locale: 'en' })
      await c.close()
    }
  },

  /* ---------------------------------------------------------------- dark theme */
  async 'dark'() {
    await fixtures()
    const c = await newContext(browser, { theme: 'dark' })
    const p = await c.newPage()
    await login(p)
    await hideToasts(p)
    await p.goto('/p/SHOP')
    await settle(p, 900)
    await shot(p, 'dark-dashboard')
    await p.goto(`/p/SHOP/runs/${failedRun.key}`)
    await settle(p, 900)
    await shot(p, 'dark-run-failed-report')
    await p.goto('/p/SHOP/tests/SHOP-T5')
    await settle(p)
    await p.getByRole('option', { name: /^Step 2,/ }).click()
    await settle(p, 500)
    await shot(p, 'dark-step-editor')
    await c.close()
  },

  /* ---------------------------------------------------------------- mobile 390 */
  async 'mobile'() {
    await fixtures()
    const c = await newContext(browser, { mobile: true })
    const p = await c.newPage()
    await login(p)
    await hideToasts(p)
    await p.goto(`/p/SHOP/runs/${failedRun.key}`)
    await settle(p, 900)
    // The report scrolls to the failed step on open; start from the run header instead.
    await p.evaluate(() => {
      for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0
      window.scrollTo(0, 0)
    })
    await p.waitForTimeout(400)
    await shot(p, 'mobile-run-report')
    await p.goto('/p/SHOP')
    await settle(p, 900)
    await shot(p, 'mobile-dashboard')
    await c.close()
  },
}

try {
  for (const [name, fn] of Object.entries(shots)) {
    if (!wanted(name)) continue
    console.log(name)
    await fn()
  }
} finally {
  await browser.close()
}
console.log(`${done.length} screenshots → ${path.relative(process.cwd(), IMG_DIR)}`)
