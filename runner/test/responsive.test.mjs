// Responsive testing (docs/14): device emulation in the browser context, set_viewport and
// expect_no_horizontal_scroll. A local HTTP server serves small fixture pages.
// Run: corepack pnpm --filter @qatlas/runner test   (builds first)

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { firefox } from 'playwright'
import { DEFAULT_OPTIONS } from '../dist/protocol.js'
import { contextOptions } from '../dist/session.js'
import { Runner, byType, stepEvents, tempDir } from './helpers.mjs'

const IPHONE_15 = {
  id: 'iphone-15',
  label: 'iPhone 15',
  category: 'mobile',
  width: 393,
  height: 659,
  device_scale_factor: 3,
  is_mobile: true,
  has_touch: true,
  playwright: 'iPhone 15',
}

const HEAD = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0;font:14px sans-serif}</style>'

const PAGES = {
  // Environment probe: what the emulated device looks like from inside the page.
  '/info': `${HEAD}<title>info</title>
    <div id="ua"></div><div id="dpr"></div><div id="touch"></div><div id="iw"></div>
    <script>
      const show = () => {
        document.getElementById('ua').textContent = navigator.userAgent
        document.getElementById('dpr').textContent = String(window.devicePixelRatio)
        document.getElementById('touch').textContent = String('ontouchstart' in window || navigator.maxTouchPoints > 0)
        document.getElementById('iw').textContent = String(window.innerWidth)
      }
      show()
      addEventListener('resize', show)
    </script>`,
  '/fit': `${HEAD}<title>fit</title><main><h1>Fits</h1><p>Short content.</p></main>`,
  // Overflowing page: a 600px banner (with a long class list) is the widest visible offender; a
  // visibility:hidden element is wider but must not be listed; a wide table inside an overflow-x:auto
  // wrapper is clipped and neither widens the page nor is an offender. Descendants that stick out no
  // further than an offending ancestor are not listed (span.cta, the sizes table and its rows), a
  // descendant that sticks out further is (div.far).
  '/wide': `${HEAD}<title>wide</title>
    <div style="width:700px;height:4px;visibility:hidden" id="ghost"></div>
    <div id="hero" class="banner wide promo extra-1 extra-2" style="width:600px;height:20px"><span class="cta" style="display:inline-block;width:450px">Buy</span></div>
    <section class="sizes" style="width:520px"><table style="width:520px"><tr><td>x</td></tr></table><div class="far" style="width:560px;height:4px"></div></section>
    <div class="table-wrap" style="overflow-x:auto;width:200px"><table style="width:900px"><tr><td>x</td></tr></table></div>`,
  // 8px wider than a 400px viewport (no vertical scrollbar: the page is short).
  '/slight': `${HEAD}<title>slight</title><div class="strip" style="width:408px;height:10px"></div>`,
  // Scroll containers: one overflowing, one fitting, plus two of the same class for the strict check.
  '/containers': `${HEAD}<title>containers</title>
    <div id="scroller" style="width:300px;overflow-x:auto"><div class="row" style="width:500px;height:10px"></div></div>
    <div id="calm" style="width:300px;overflow-x:auto"><p>short</p></div>
    <div class="twin" style="width:100px"></div><div class="twin" style="width:100px"></div>`,
}

let server
let base
let runner
let tmp
let seq = 0

before(async () => {
  tmp = tempDir()
  server = createServer((req, res) => {
    const page = PAGES[new URL(req.url, 'http://x').pathname]
    res.writeHead(page ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ?? 'not found')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  runner = new Runner()
  await runner.ready()
})

after(async () => {
  const { code } = await runner.close()
  assert.equal(code, 0, `runner exit code (stderr:\n${runner.stderr})`)
  await new Promise((r) => server.close(r))
  tmp.cleanup()
})

const S = (action, params = {}) => ({ step_id: `st_${++seq}`, action, ...params })

function run(name, steps, options = {}) {
  seq++
  const caseId = `rc_${name}`
  return runner
    .run({
      type: 'run.start',
      run_id: `run_${name}_${seq}`,
      artifact_dir: join(tmp.dir, `${name}-${seq}`),
      options: { step_timeout_ms: 2000, screenshot: 'off', ...options },
      env: { BASE_URL: base },
      cases: [{ case_id: caseId, steps }],
    })
    .then((events) => ({ events, steps: stepEvents(events, caseId) }))
}

const passed = (steps) => steps.forEach((s) => assert.equal(s.status, 'passed', `${s.step_id}: ${s.error}`))

describe('device emulation', () => {
  test('mobile device on chromium: UA from the descriptor, DPR 3, touch, 393px layout', async () => {
    const { steps } = await run(
      'iphone',
      [
        S('goto', { url: '{{env.BASE_URL}}/info' }),
        S('expect_text', { selector: '#ua', value: 'iPhone', match: 'contains' }),
        S('expect_text', { selector: '#dpr', value: '3' }),
        S('expect_text', { selector: '#touch', value: 'true' }),
        S('expect_text', { selector: '#iw', value: '393' }),
      ],
      { viewport: { width: 393, height: 659 }, device: IPHONE_15 },
    )
    passed(steps)
  })

  test('without a device the context is the plain desktop one, as before', async () => {
    const { steps } = await run('desktop', [
      S('goto', { url: '{{env.BASE_URL}}/info' }),
      S('expect_text', { selector: '#ua', value: 'HeadlessChrome', match: 'contains' }),
      S('expect_text', { selector: '#dpr', value: '1' }),
      S('expect_text', { selector: '#touch', value: 'false' }),
      S('expect_text', { selector: '#iw', value: '1280' }),
    ])
    passed(steps)
  })

  test('a device without a Playwright descriptor gets no UA override (no error); viewport falls back to the device size', async () => {
    const custom = { ...IPHONE_15, id: 'custom', label: '500×700', category: 'mobile', width: 500, height: 700, device_scale_factor: 1, is_mobile: false, has_touch: false, playwright: null }
    const { steps } = await run(
      'custom',
      [
        S('goto', { url: '{{env.BASE_URL}}/info' }),
        S('expect_text', { selector: '#iw', value: '500' }),
        S('expect_text', { selector: '#ua', value: 'HeadlessChrome', match: 'contains' }),
      ],
      { device: custom },
    )
    passed(steps)
    const unknown = { ...IPHONE_15, playwright: 'No Such Phone 9000' }
    const { steps: s2 } = await run('unknown-descriptor', [S('goto', { url: '{{env.BASE_URL}}/info' }), S('expect_text', { selector: '#ua', value: 'HeadlessChrome', match: 'contains' })], {
      viewport: { width: 393, height: 659 },
      device: unknown,
    })
    passed(s2)
  })

  test('a malformed device is rejected at run.start', async () => {
    const msg = {
      type: 'run.start',
      run_id: `run_bad_device_${++seq}`,
      artifact_dir: join(tmp.dir, 'bad-device'),
      options: { device: { ...IPHONE_15, width: 'wide' } },
      cases: [{ case_id: 'rc_bad', steps: [S('goto', { url: base })] }],
    }
    const events = await runner.run(msg)
    assert.deepEqual(events.map((e) => e.type), ['runner.error', 'run.finished'])
    assert.match(events[0].message, /options\.device\.width/)
    assert.equal(events[1].status, 'error')
  })

  test('an only_on key on a wire step is ignored by the runner; disabled steps are skipped', async () => {
    const { steps } = await run('only-on', [
      S('goto', { url: '{{env.BASE_URL}}/fit', only_on: ['mobile', 'tablet'] }),
      S('expect_title', { value: 'nope', only_on: ['desktop'], enabled: false }),
      S('expect_title', { value: 'fit', only_on: ['mobile'] }),
    ])
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'skipped', 'passed'])
  })

  test('contextOptions: device fields, video size = viewport, unchanged shape without a device', () => {
    const opts = { ...DEFAULT_OPTIONS, viewport: { width: 393, height: 659 }, device: IPHONE_15 }
    const chromium = contextOptions(opts, 'http://x/', '/tmp/v')
    assert.equal(chromium.isMobile, true)
    assert.equal(chromium.hasTouch, true)
    assert.equal(chromium.deviceScaleFactor, 3)
    assert.match(chromium.userAgent, /iPhone/)
    assert.deepEqual(chromium.recordVideo, { dir: '/tmp/v', size: { width: 393, height: 659 } })
    assert.deepEqual(contextOptions(DEFAULT_OPTIONS, undefined, null), { viewport: { width: 1280, height: 720 }, baseURL: undefined, acceptDownloads: false })
    const noDescriptor = contextOptions({ ...opts, device: { ...IPHONE_15, playwright: 'No Such Phone' } }, undefined, null)
    assert.equal('userAgent' in noDescriptor, false)
  })

  test('contextOptions: firefox never gets isMobile (unsupported there); DPR, touch and UA stay', () => {
    const ff = contextOptions({ ...DEFAULT_OPTIONS, browser: 'firefox', viewport: { width: 393, height: 659 }, device: IPHONE_15 }, undefined, null)
    assert.equal('isMobile' in ff, false)
    assert.equal(ff.hasTouch, true)
    assert.equal(ff.deviceScaleFactor, 3)
    assert.match(ff.userAgent, /iPhone/)
  })

  const firefoxInstalled = existsSync(firefox.executablePath())
  test('mobile device on firefox runs (no isMobile)', { skip: firefoxInstalled ? false : 'firefox is not installed for Playwright 1.64.1' }, async () => {
    const { steps } = await run(
      'firefox-iphone',
      [S('goto', { url: '{{env.BASE_URL}}/info' }), S('expect_text', { selector: '#ua', value: 'iPhone', match: 'contains' }), S('expect_text', { selector: '#iw', value: '393' })],
      { browser: 'firefox', viewport: { width: 393, height: 659 }, device: IPHONE_15 },
    )
    passed(steps)
  })
})

describe('set_viewport', () => {
  test('changes the page width; out-of-range or non-integer sizes fail the step', async () => {
    const { steps } = await run('set-viewport', [
      S('goto', { url: '{{env.BASE_URL}}/info' }),
      S('expect_text', { selector: '#iw', value: '1280' }),
      S('set_viewport', { width: 768, height: 1024 }),
      S('expect_text', { selector: '#iw', value: '768' }),
    ])
    passed(steps)
    assert.equal(steps[2].details, null)

    // Interpolated params arrive as strings: numeric strings are accepted.

    const ok = await runner.run({
      type: 'run.start',
      run_id: `run_set_viewport_vars_${++seq}`,
      artifact_dir: join(tmp.dir, 'set-viewport-vars'),
      options: { step_timeout_ms: 2000, screenshot: 'off' },
      env: { BASE_URL: base },
      vars: { w: 400 },
      cases: [
        {
          case_id: 'rc_vp_vars',
          steps: [S('goto', { url: '{{env.BASE_URL}}/info' }), S('set_viewport', { width: '{{vars.w}}', height: '600' }), S('expect_text', { selector: '#iw', value: '400' })],
        },
      ],
    })
    passed(stepEvents(ok, 'rc_vp_vars'))

    for (const [params, re] of [
      [{ width: 319, height: 600 }, /"width" must be an integer between 320 and 3840, got 319/],
      [{ width: 800, height: 2161 }, /"height" must be an integer between 320 and 2160, got 2161/],
      [{ width: 800.5, height: 600 }, /"width" must be an integer/],
      [{ height: 600 }, /requires parameter "width"/],
    ]) {
      const { steps: bad } = await run('set-viewport-bad', [S('goto', { url: '{{env.BASE_URL}}/info' }), S('set_viewport', params)])
      assert.equal(bad[1].status, 'failed')
      assert.match(bad[1].error, re)
    }
  })
})

describe('expect_no_horizontal_scroll', () => {
  test('passes on a fitting page with expected/actual details', async () => {
    const { steps } = await run('fit', [S('goto', { url: '{{env.BASE_URL}}/fit' }), S('expect_no_horizontal_scroll')], { viewport: { width: 393, height: 659 }, device: IPHONE_15 })
    passed(steps)
    assert.deepEqual(steps[1].details, { expected: 'content width ≤ 393px', actual: 'content width 393px' })
  })

  test('fails on an overflowing page with offenders, widest first; hidden, clipped and covered elements excluded', async () => {
    const started = Date.now()
    const { steps, events } = await run('wide', [S('goto', { url: '{{env.BASE_URL}}/wide' }), S('expect_no_horizontal_scroll')], {
      viewport: { width: 393, height: 659 },
      device: IPHONE_15,
      step_timeout_ms: 1000,
    })
    const failed = steps[1]
    assert.equal(failed.status, 'failed')
    assert.ok(Date.now() - started >= 1000, 'polled until the step timeout')
    // The hidden 700px ghost still widens the document (visibility keeps layout) but is not an offender.
    // Chromium's isMobile shrink-to-fit reports an overflowing document 1px wider (701) than without it.
    const { actual, ...rest } = failed.details
    assert.match(actual, /^content width 70[01]px$/)
    assert.deepEqual(rest, {
      expected: 'content width ≤ 393px',
      offenders: ['div#hero.banner.wide.promo… (right edge 600px)', 'div.far (right edge 560px)', 'section.sizes (right edge 520px)'],
    })
    assert.match(failed.error, /^Expected the page to have no horizontal scroll, but its content is 70[01]px wide in 393px; widest: div#hero\.banner\.wide\.promo… \(right edge 600px\)$/)
    assert.equal(byType(events, 'case.finished')[0].status, 'failed')
  })

  test('tolerance_px allows a slight overflow; out-of-range tolerance fails the step', async () => {
    const vp = { viewport: { width: 400, height: 600 } }
    const { steps } = await run('slight', [S('goto', { url: '{{env.BASE_URL}}/slight' }), S('expect_no_horizontal_scroll', { tolerance_px: 10 })], vp)
    passed(steps)
    assert.deepEqual(steps[1].details, { expected: 'content width ≤ 400px (+10px tolerance)', actual: 'content width 408px' })

    const { steps: tight } = await run('slight-tight', [S('goto', { url: '{{env.BASE_URL}}/slight' }), S('expect_no_horizontal_scroll', { tolerance_px: 5, timeout_ms: 300 })], vp)
    assert.equal(tight[1].status, 'failed')
    assert.deepEqual(tight[1].details.offenders, ['div.strip (right edge 408px)'])

    const { steps: bad } = await run('slight-bad', [S('goto', { url: '{{env.BASE_URL}}/slight' }), S('expect_no_horizontal_scroll', { tolerance_px: 51 })], vp)
    assert.equal(bad[1].status, 'failed')
    assert.match(bad[1].error, /"tolerance_px" must be between 0 and 50/)
  })

  test('selector targets a scroll container; strict: missing or ambiguous containers fail', async () => {
    const { steps } = await run('containers', [
      S('goto', { url: '{{env.BASE_URL}}/containers' }),
      S('expect_no_horizontal_scroll', { selector: '#calm' }),
      S('expect_no_horizontal_scroll', { selector: '#scroller', timeout_ms: 300, continue_on_failure: true }),
      S('expect_no_horizontal_scroll', { selector: '#missing', timeout_ms: 300, continue_on_failure: true }),
      S('expect_no_horizontal_scroll', { selector: '.twin', timeout_ms: 300, continue_on_failure: true }),
      S('expect_no_horizontal_scroll'),
    ])
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed', 'failed', 'failed', 'failed', 'passed'])
    assert.deepEqual(steps[1].details, { expected: 'content width ≤ 300px', actual: 'content width 300px' })
    assert.deepEqual(steps[2].details, { expected: 'content width ≤ 300px', actual: 'content width 500px', offenders: ['div.row (right edge 500px)'] })
    assert.match(steps[2].error, /^Expected locator\('#scroller'\) to have no horizontal scroll, but its content is 500px wide in 300px; widest: div\.row/)
    assert.match(steps[3].error, /no element matched/)
    assert.match(steps[4].error, /matched 2 elements \(make it unique\)/)
  })
})
