// Records the manual's walkthrough videos (Playwright recordVideo, 1280×800) against a running
// QAtlas seeded with `qatlas seed demo`. Each walkthrough creates real data on that instance
// (a test case, runs, a flow run that waits for manual work). Encode afterwards with encode.sh.
//
//   cd web && node ../docs/manual/scripts/videos.mjs              # all three
//   cd web && node ../docs/manual/scripts/videos.mjs manual       # only names containing "manual"
//
// Env: QATLAS_URL (default http://127.0.0.1:8090), RAW_DIR (default <tmp>/qatlas-manual-raw):
// where the .webm files go; encode.sh reads them from there.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { api, chromium, login, newContext, settle, sleep, startRun, waitForRun } from './lib.mjs'

const RAW_DIR = process.env.RAW_DIR ?? path.join(os.tmpdir(), 'qatlas-manual-raw')
fs.mkdirSync(RAW_DIR, { recursive: true })
const SIZE = { width: 1280, height: 800 }
const only = process.argv.slice(2)

const browser = await chromium.launch()

// Sign in once without recording; the recorded contexts reuse the session.
const authCtx = await newContext(browser, { viewport: SIZE })
const authPage = await authCtx.newPage()
await login(authPage)
const storageState = await authCtx.storageState()

/** A visible pointer (headless recordings have none) that glides between targets. */
const CURSOR = () => {
  addEventListener('DOMContentLoaded', () => {
    const dot = document.createElement('div')
    dot.setAttribute('aria-hidden', 'true')
    dot.style.cssText =
      'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;' +
      'background:rgba(37,99,235,.35);border:2px solid rgba(37,99,235,.9);pointer-events:none;' +
      'z-index:2147483647;transition:transform .12s ease;transform:translate(-100px,-100px)'
    document.documentElement.appendChild(dot)
    let x = -100
    let y = -100
    addEventListener('mousemove', (e) => {
      x = e.clientX
      y = e.clientY
      dot.style.transform = `translate(${x}px,${y}px)`
    }, true)
    addEventListener('mousedown', () => (dot.style.transform = `translate(${x}px,${y}px) scale(.7)`), true)
    addEventListener('mouseup', () => (dot.style.transform = `translate(${x}px,${y}px)`), true)
  })
}

async function recorder(name) {
  const ctx = await newContext(browser, { viewport: SIZE, video: { dir: RAW_DIR, size: SIZE } })
  await ctx.addCookies(storageState.cookies)
  await ctx.addInitScript(CURSOR)
  const page = await ctx.newPage()
  let mouse = { x: 640, y: 400 }
  const h = {
    page,
    beat: (ms = 700) => page.waitForTimeout(ms),
    /** Glide to the element, pause, click. */
    async click(locator, opts = {}) {
      await locator.scrollIntoViewIfNeeded()
      const box = await locator.boundingBox()
      if (box) {
        const to = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
        await page.mouse.move(to.x, to.y, { steps: 14 })
        mouse = to
        await page.waitForTimeout(180)
      }
      await locator.click(opts)
    },
    async type(locator, text, delay = 38) {
      await locator.pressSequentially(text, { delay })
    },
    async finish() {
      await page.waitForTimeout(400)
      const video = page.video()
      await ctx.close()
      const src = await video.path()
      const dst = path.join(RAW_DIR, `${name}.webm`)
      fs.renameSync(src, dst)
      console.log('  ✓', dst)
      void mouse
    },
  }
  return h
}

/** Opens the action palette, picks an action, and fills its fields. */
async function addStep(h, action, fields) {
  const { page } = h
  await h.click(page.getByRole('button', { name: 'Add step' }))
  await h.beat(300)
  await h.type(page.getByRole('combobox', { name: 'Search actions' }), action, 60)
  await h.beat(450)
  await page.keyboard.press('Enter')
  await h.beat(450)
  for (const [label, value] of fields) {
    const field = page.getByRole('textbox', { name: new RegExp(`^${label}( optional)?$`) })
    await h.click(field)
    await h.type(field, value)
    await field.press('Escape') // closes the {{variable}} autocomplete if it opened
    await h.beat(250)
  }
  await h.beat(400)
}

const walkthroughs = {
  /* (a) write a test case in the step editor → run it → live progress → report */
  async 'create-and-run-test-case'() {
    const h = await recorder('create-and-run-test-case')
    const { page } = h
    await page.goto('/p/SHOP/tests')
    await settle(page, 900)
    await h.click(page.getByRole('link', { name: 'Test case', exact: true }).or(page.getByRole('button', { name: 'Test case', exact: true })).first())
    await page.waitForURL(/\/tests\/new/)
    await settle(page, 600)
    await h.click(page.getByLabel('Test case title'))
    await h.type(page.getByLabel('Test case title'), 'Plain black tee: price and add to cart')
    await h.beat()

    await addStep(h, 'goto', [['URL', '{{env.BASE_URL}}/products/plain-black-tee']])
    await addStep(h, 'expect_text', [
      ['Selector', 'testid=product-price'],
      ['Text', 'Rp 90.000'],
    ])
    await addStep(h, 'click', [['Selector', "role=button[name='Add to cart']"]])
    await addStep(h, 'expect_visible', [['Selector', 'text=Added to cart']])
    await h.beat(600)

    await page.keyboard.press('Control+s')
    await page.waitForURL(/\/tests\/SHOP-T\d+/)
    await settle(page, 1200)

    await h.click(page.getByRole('button', { name: /^Run$/ }))
    const dialog = page.getByRole('dialog')
    await h.beat(600)
    await h.click(dialog.locator('[aria-label="Screenshot"]').getByText('Every step'))
    await h.beat(300)
    await h.click(dialog.locator('[aria-label="Video"]').getByText('Always'))
    await h.beat(700)
    await h.click(dialog.getByRole('button', { name: 'Run', exact: true }))
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    const key = page.url().match(/SHOP-R\d+/)[0]
    await waitForRun(page, key)
    await h.beat(2200)

    await h.click(page.getByRole('tab', { name: /Screenshots/ }))
    await h.beat(1200)
    await h.click(page.getByRole('button', { name: /^Open Screenshot/ }).nth(2))
    await h.beat(1400)
    await page.keyboard.press('ArrowRight')
    await h.beat(1200)
    await page.keyboard.press('ArrowRight')
    await h.beat(1200)
    await page.keyboard.press('Escape')
    await h.beat(500)
    await h.click(page.getByRole('tab', { name: /Video/ }))
    await h.beat(1200)
    await page.locator('video').first().evaluate((v) => v.play()).catch(() => {})
    await h.beat(2500)
    await h.finish()
  },

  /* (b) failed run → expected vs actual → fix the step → re-run passes */
  async 'fix-a-failing-test'() {
    // A test case whose expectation is out of date (the price is Rp 90.000 now). Re-recording
    // resets the same test case instead of creating another one.
    const title = 'Product page shows the current price'
    const definition = {
      title,
      priority: 'medium',
      status: 'ready',
      tags: ['catalog'],
      steps: [
        { id: 'p1', action: 'goto', url: '{{env.BASE_URL}}/products/plain-black-tee' },
        { id: 'p2', action: 'expect_visible', selector: 'testid=product-price' },
        {
          id: 'p3',
          action: 'expect_text',
          selector: 'testid=product-price',
          value: 'Rp 85.000',
          match: 'equals',
          description: 'Price on the product page',
          timeout_ms: 4000,
        },
        { id: 'p4', action: 'expect_text', selector: 'testid=stock-label', value: 'Stock', match: 'contains' },
      ],
    }
    const found = await api(authPage, 'GET', `/projects/SHOP/test-cases?q=${encodeURIComponent(title)}&limit=5`)
    const existing = found.data.find((t) => t.title === title)
    let tc
    if (existing) {
      const full = await api(authPage, 'GET', `/test-cases/${existing.key}`)
      tc = await api(authPage, 'PATCH', `/test-cases/${existing.key}`, { ...definition, revision: full.revision, change_note: 'reset for the manual video' })
    } else {
      tc = await api(authPage, 'POST', '/projects/SHOP/test-cases', definition)
    }

    const h = await recorder('fix-a-failing-test')
    const { page } = h
    await page.goto(`/p/SHOP/tests/${tc.key}`)
    await settle(page, 1000)
    await h.click(page.getByRole('button', { name: /^Run$/ }))
    await h.beat(800)
    await h.click(page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }))
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    await waitForRun(page, page.url().match(/SHOP-R\d+/)[0])
    await settle(page, 1500)
    // Point at expected vs actual.
    const actualBox = await page.getByText('Actual', { exact: true }).first().boundingBox()
    if (actualBox) await page.mouse.move(actualBox.x + 40, actualBox.y + 30, { steps: 20 })
    await h.beat(2500)

    // Look at the failure: expected vs actual and the screenshot.
    await h.click(page.getByRole('button', { name: /^Open Screenshot/ }).first())
    await h.beat(2200)
    await page.keyboard.press('Escape')
    await h.beat(800)

    // Fix the step in the editor.
    await h.click(page.getByRole('link', { name: tc.key }).first())
    await page.waitForURL(new RegExp(`/tests/${tc.key}`))
    await settle(page, 900)
    await h.click(page.getByRole('option', { name: /^Step 3,/ }))
    await h.beat(700)
    const text = page.getByRole('textbox', { name: /^Text( optional)?$/ })
    await h.click(text, { clickCount: 3 })
    await h.type(text, 'Rp 90.000')
    await text.press('Escape')
    await h.beat(1500)
    await page.keyboard.press('Control+s')
    await page.getByText(/Revision \d+ saved/).first().waitFor()
    await h.beat(1200)

    await h.click(page.getByRole('button', { name: /^Run$/ }))
    await h.beat(700)
    await h.click(page.getByRole('dialog').getByRole('button', { name: 'Run', exact: true }))
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    await waitForRun(page, page.url().match(/SHOP-R\d+/)[0])
    await h.beat(1000)
    await h.click(page.getByRole('button', { name: /expect_text.*Rp 90\.000|Rp 90\.000/ }).first()).catch(() => {})
    await h.beat(3000)
    await h.finish()
  },

  /* (c) a flow pauses for a manual test case → the assignee works through it → the flow resumes */
  async 'manual-execution'() {
    // Reuse a flow run already waiting for this user, else start one.
    const waiting = await api(authPage, 'GET', '/me/manual-runs')
    const run =
      (waiting.data ?? waiting).find((r) => r.target?.key === 'SHOP-F3' && r.status === 'awaiting_manual') ??
      (await startRun(authPage, 'SHOP', { flow: 'SHOP-F3' }, { until: ['awaiting_manual'] }))
    // Evidence to attach: a screenshot of the shop's order page.
    const shop = await authCtx.newPage()
    await shop.setViewportSize({ width: 900, height: 600 })
    await shop.goto('http://localhost:8099/account').catch(() => {})
    const evidence = await shop.screenshot()
    await shop.close()

    const h = await recorder('manual-execution')
    const { page } = h
    await page.goto('/my-tasks')
    await settle(page, 1200)
    await h.click(page.getByRole('link', { name: new RegExp(`Work on ${run.key}:`) }))
    await page.waitForURL(/\/runs\/SHOP-R\d+/)
    await settle(page, 1500)

    const decisions = page.getByRole('group', { name: 'Step result' })
    // Step 1: pass.
    await h.beat(2000)
    await h.click(decisions.getByRole('button', { name: /Pass/ }))
    await h.beat(1400)
    // Step 2: pass, with a note.
    const actual = page.getByLabel(/Actual result/)
    await h.click(actual)
    await h.type(actual, 'Logo, address and NPWP match the brand guideline.')
    await h.beat(500)
    await h.click(decisions.getByRole('button', { name: /Pass/ }))
    await h.beat(1400)
    // Step 3: pass, with a screenshot as evidence.
    await h.beat(1500)
    const drop = page.getByText(/Drop files here/).first()
    await drop.scrollIntoViewIfNeeded()
    const dropBox = await drop.boundingBox()
    if (dropBox) await page.mouse.move(dropBox.x + dropBox.width / 2, dropBox.y + dropBox.height / 2, { steps: 16 })
    await h.beat(600)
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'order-page.png', mimeType: 'image/png', buffer: evidence })
    await page.getByText('order-page.png').first().waitFor()
    await drop.scrollIntoViewIfNeeded().catch(() => {})
    await h.beat(2000)
    await h.click(decisions.getByRole('button', { name: /Pass/ }))
    await h.beat(1200)

    await h.click(page.getByRole('button', { name: 'Finish', exact: true }).first())
    await h.beat(800)
    await h.click(page.getByRole('dialog').getByRole('button', { name: /^(Finish|Mark the rest Skipped & finish)$/ }))
    // The worker picks the flow up again and runs the remaining automated case.
    await waitForRun(page, run.key)
    await h.beat(1000)
    await page.evaluate(() => {
      for (const el of document.querySelectorAll('*')) if (el.scrollTop > 0) el.scrollTop = 0
      window.scrollTo(0, 0)
    })
    await h.beat(3000)
    await h.finish()
  },
}

try {
  for (const [name, fn] of Object.entries(walkthroughs)) {
    if (only.length && !only.some((o) => name.includes(o))) continue
    console.log(name)
    await fn()
  }
} finally {
  await authCtx.close()
  await browser.close()
}
await sleep(0)
