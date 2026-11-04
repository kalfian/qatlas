// Integration tests: spawn the built runner (dist/main.js) and demo-target, drive them over NDJSON.
// Run: corepack pnpm --filter @qatlas/runner test   (builds first)

import assert from 'node:assert/strict'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { DEMO_SECRETS, SHOP_CASES, runStart } from '../scripts/shop-cases.mjs'
import { Runner, byType, startDemo, stepEvents, tempDir } from './helpers.mjs'

let demo
let runner
let tmp
let runSeq = 0
const nextRunId = (name) => `run_${name}_${++runSeq}`

const msgFor = (name, cases, extra = {}) =>
  runStart({ runId: nextRunId(name), artifactDir: join(tmp.dir, `${name}-${runSeq + 1}`), baseUrl: demo.url, cases, ...extra })

before(async () => {
  tmp = tempDir()
  demo = await startDemo()
  runner = new Runner()
  const ready = await runner.ready()
  assert.equal(ready.playwright, '1.64.1')
})

after(async () => {
  const { code } = await runner.close()
  assert.equal(code, 0, `runner exit code (stderr:\n${runner.stderr})`)
  await demo.stop()
  tmp.cleanup()
})

describe('UI cases', () => {
  test('passing case with every_step screenshots and video "always"', async () => {
    const msg = msgFor('login', [SHOP_CASES.login()], { options: { screenshot: 'every_step', video: 'always' } })
    const events = await runner.run(msg)
    const types = events.map((e) => e.type)
    assert.equal(types[0], 'case.started')
    assert.equal(types.at(-1), 'run.finished')
    assert.equal(types.at(-2), 'case.finished')
    // started/finished strictly alternate per step
    const stepTypes = types.slice(1, -2)
    assert.equal(stepTypes.length, 12)
    stepTypes.forEach((t, i) => assert.equal(t, i % 2 === 0 ? 'step.started' : 'step.finished'))

    const steps = stepEvents(events, 'rc_login')
    for (const s of steps) {
      assert.equal(s.status, 'passed', `${s.step_id}: ${s.error}`)
      assert.equal(s.error, null)
      assert.ok(typeof s.duration_ms === 'number' && s.duration_ms >= 0)
      assert.ok(s.screenshot && s.screenshot.startsWith(msg.artifact_dir), `screenshot path for ${s.step_id}`)
      assert.ok(existsSync(s.screenshot) && statSync(s.screenshot).size > 0)
    }
    assert.deepEqual(steps[4].details, { expected: '/akun', actual: `${demo.url}/akun` })
    const done = byType(events, 'case.finished')[0]
    assert.equal(done.status, 'passed')
    assert.ok(done.video && done.video.endsWith('.webm') && existsSync(done.video) && statSync(done.video).size > 0)
    assert.equal(byType(events, 'run.finished')[0].status, 'passed')
  })

  test('voucher case fails with expected/actual, later steps skipped, on_failure artifacts kept', async () => {
    const msg = msgFor('voucher', [SHOP_CASES.voucher()], { options: { screenshot: 'on_failure', video: 'on_failure' } })
    const events = await runner.run(msg)
    const steps = stepEvents(events, 'rc_voucher')
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed', 'passed', 'passed', 'failed', 'skipped'])
    const failed = steps[4]
    assert.equal(failed.error, 'Expected text of getByTestId(\'grand-total\') to equal "Rp 81.000", received "Rp 90.000"')
    assert.deepEqual(failed.details, { expected: 'Rp 81.000', actual: 'Rp 90.000' })
    assert.ok(failed.screenshot && existsSync(failed.screenshot), 'screenshot on failure')
    for (const s of steps.filter((x) => x.status === 'passed')) assert.equal(s.screenshot, null)
    // the skipped step never started
    assert.equal(events.filter((e) => e.type === 'step.started' && e.step_id === steps[5].step_id).length, 0)
    assert.equal(steps[5].duration_ms, 0)
    const done = byType(events, 'case.finished')[0]
    assert.equal(done.status, 'failed')
    assert.ok(done.video && existsSync(done.video), 'video kept for a failed case')
    assert.equal(byType(events, 'run.finished')[0].status, 'failed')
  })

  test('video "on_failure" is deleted when the case passed', async () => {
    const msg = msgFor('product', [SHOP_CASES.product()], { options: { video: 'on_failure' } })
    const events = await runner.run(msg)
    const done = byType(events, 'case.finished')[0]
    assert.equal(done.status, 'passed')
    assert.equal(done.video, null)
    const caseDir = join(msg.artifact_dir, 'rc_product')
    const leftovers = existsSync(caseDir) ? readdirSync(caseDir, { recursive: true }).filter((f) => String(f).endsWith('.webm')) : []
    assert.deepEqual(leftovers, [])
  })

  test('mixed API + UI case uses context.request and saved vars', async () => {
    const events = await runner.run(msgFor('apiui', [SHOP_CASES.api_order_then_ui()]))
    const steps = stepEvents(events, 'rc_api_order_ui')
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed', 'passed', 'passed'], JSON.stringify(steps, null, 1))
    assert.match(steps[0].details.response.body.data.id, /^ORD-\d{6}$/)
  })

  test('retries re-run a failed case and report one case.finished', async () => {
    const c = SHOP_CASES.voucher()
    const events = await runner.run(msgFor('retry', [c], { options: { retries: 1 } }))
    assert.equal(byType(events, 'case.started').length, 2)
    assert.equal(byType(events, 'case.finished').length, 1)
    assert.equal(byType(events, 'case.finished')[0].status, 'failed')
    assert.equal(stepEvents(events, c.case_id).length, 12)
  })

  test('unknown variable fails the step with a clear message', async () => {
    const c = { case_id: 'rc_unknown_var', steps: [{ step_id: 'u1', action: 'goto', url: '{{env.BASE_URL}}/{{vars.nope}}' }] }
    const events = await runner.run(msgFor('unknownvar', [c]))
    const [s] = stepEvents(events, 'rc_unknown_var')
    assert.equal(s.status, 'failed')
    assert.match(s.error, /Unknown variable \{\{vars\.nope\}\}/)
  })
})

describe('HTTP-only cases', () => {
  test('run without launching a browser; http details shape', async () => {
    const r = new Runner()
    try {
      await r.ready()
      const msg = runStart({
        runId: nextRunId('http'),
        artifactDir: join(tmp.dir, 'http'),
        baseUrl: demo.url,
        cases: [SHOP_CASES.api_products(), SHOP_CASES.api_login()],
        options: { screenshot: 'every_step', video: 'always' },
      })
      const events = await r.run(msg)
      assert.equal(byType(events, 'run.finished')[0].status, 'passed', JSON.stringify(events, null, 1))
      for (const s of byType(events, 'step.finished')) {
        assert.equal(s.status, 'passed', `${s.step_id}: ${s.error}`)
        assert.equal(s.screenshot, null, 'HTTP steps never screenshot')
      }
      for (const c of byType(events, 'case.finished')) assert.equal(c.video, null)
      const req = stepEvents(events, 'rc_api_products')[0]
      assert.deepEqual(req.details.request, { method: 'GET', url: `${demo.url}/api/v1/products?limit=10` })
      assert.equal(req.details.response.status, 200)
      assert.equal(typeof req.details.response.time_ms, 'number')
      assert.equal(req.details.response.body.data[0].id, 'p_1')
      assert.deepEqual(stepEvents(events, 'rc_api_products')[2].details, { expected: 'exists', actual: 'p_1' })
      assert.doesNotMatch(r.stderr, /launching browser/, 'no browser must be launched for HTTP-only runs')
    } finally {
      await r.close()
    }
  })

  test('expect_json / expect_header / expect_status failures report expected and actual', async () => {
    const c = {
      case_id: 'rc_http_fail',
      steps: [
        { step_id: 'h1', action: 'http_request', method: 'POST', url: '{{env.API_URL}}/v1/auth/login', body_type: 'json', body: '{"email":"x@y.z","password":"no"}' },
        { step_id: 'h2', action: 'expect_status', value: 201, continue_on_failure: true },
        { step_id: 'h3', action: 'expect_status', in: [400, 401] },
        { step_id: 'h4', action: 'expect_json', path: '$.error.code', op: 'eq', value: 'invalid_credentials' },
        { step_id: 'h5', action: 'expect_json', path: '$.error.code', op: 'matches', value: '^invalid_' },
        { step_id: 'h6', action: 'expect_header', name: 'Content-Type', value: 'application/json', match: 'contains' },
        { step_id: 'h7', action: 'expect_json', path: '$.data.token', op: 'exists' },
      ],
    }
    const events = await runner.run(msgFor('httpfail', [c]))
    const steps = stepEvents(events, 'rc_http_fail')
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'failed', 'passed', 'passed', 'passed', 'passed', 'failed'])
    assert.equal(steps[1].error, 'Expected status 201, received 401')
    assert.deepEqual(steps[1].details, { expected: '201', actual: '401' })
    assert.equal(steps[6].error, 'Expected $.data.token to exist, but it is missing')
    assert.deepEqual(steps[6].details, { expected: 'exists', actual: '(missing)' })
  })
})

describe('flows', () => {
  const sharedCases = () => [
    {
      case_id: 'rc_shared_a',
      vars: { email: 'qa.bot@tokoku.id' },
      steps: [
        ...SHOP_CASES.login().steps,
        { step_id: 'a7', action: 'extract_text', selector: 'role=heading[name=\'Halo, QA Bot\']', save_as: 'greeting' },
        { step_id: 'a8', action: 'http_request', method: 'GET', url: '{{env.API_URL}}/v1/products', save: { first_slug: '$.data[0].slug' } },
      ],
    },
    {
      case_id: 'rc_shared_b',
      steps: [
        { step_id: 'b1', action: 'set_variable', name: 'copy', value: '{{vars.greeting}} / {{vars.first_slug}}' },
        { step_id: 'b2', action: 'goto', url: '{{env.BASE_URL}}/akun' },
        { step_id: 'b3', action: 'expect_visible', selector: 'text={{vars.greeting}}', timeout_ms: 2000 },
        { step_id: 'b4', action: 'goto', url: '{{env.BASE_URL}}/produk/{{vars.first_slug}}' },
        { step_id: 'b5', action: 'expect_title', value: 'Kaos Polos Hitam', match: 'contains' },
      ],
    },
  ]

  test('shared session: cookies and runtime vars carry over; one video on the first case', async () => {
    const msg = msgFor('shared', sharedCases(), { shared: true, options: { video: 'always' } })
    const events = await runner.run(msg)
    assert.equal(byType(events, 'run.finished')[0].status, 'passed', JSON.stringify(events.filter((e) => e.error), null, 1))
    const finishes = byType(events, 'case.finished')
    // a: passed (video null) · b: passed (video null) · a again with the segment video (after context close)
    assert.deepEqual(finishes.map((f) => [f.case_id, f.status]), [['rc_shared_a', 'passed'], ['rc_shared_b', 'passed'], ['rc_shared_a', 'passed']])
    assert.equal(finishes[0].video, null)
    assert.equal(finishes[1].video, null)
    assert.ok(finishes[2].video && finishes[2].video.includes('rc_shared_a') && existsSync(finishes[2].video))
    // the re-emitted case.finished comes right before run.finished
    assert.equal(events.at(-2), finishes[2])
  })

  test('isolated cases: runtime vars do not carry over', async () => {
    const events = await runner.run(msgFor('isolated', sharedCases(), { shared: false, stopOnFailure: false }))
    const b = stepEvents(events, 'rc_shared_b')
    assert.equal(b[0].status, 'failed')
    assert.match(b[0].error, /Unknown variable \{\{vars\.greeting\}\}/)
    assert.equal(byType(events, 'run.finished')[0].status, 'failed')
  })

  test('stop_on_failure skips remaining cases unless the failed case continues on failure', async () => {
    const product = SHOP_CASES.product()
    const events = await runner.run(msgFor('stop', [SHOP_CASES.voucher(), product], { stopOnFailure: true }))
    const finishes = byType(events, 'case.finished')
    assert.deepEqual(finishes.map((f) => f.status), ['failed', 'skipped'])
    assert.equal(events.filter((e) => e.case_id === product.case_id && e.type !== 'case.finished').length, 0, 'skipped case emits only case.finished')
    assert.equal(byType(events, 'run.finished')[0].status, 'failed')

    const voucher = { ...SHOP_CASES.voucher(), continue_on_failure: true }
    const events2 = await runner.run(msgFor('stop2', [voucher, SHOP_CASES.product()], { stopOnFailure: true }))
    assert.deepEqual(byType(events2, 'case.finished').map((f) => f.status), ['failed', 'passed'])
  })
})

describe('cancellation', () => {
  test('run.cancel aborts the current step quickly and skips the rest', async () => {
    const c1 = {
      case_id: 'rc_cancel_1',
      steps: [
        { step_id: 'c1', action: 'goto', url: '{{env.BASE_URL}}' },
        { step_id: 'c2', action: 'wait_for', selector: 'testid=never-there', state: 'visible', timeout_ms: 30000 },
        { step_id: 'c3', action: 'expect_title', value: 'Tokoku' },
      ],
    }
    const c2 = SHOP_CASES.home()
    const msg = msgFor('cancel', [c1, c2])
    runner.send(msg)
    await runner.waitFor((e) => e.type === 'step.started' && e.run_id === msg.run_id && e.step_id === 'c2')
    await new Promise((r) => setTimeout(r, 300))
    const t0 = Date.now()
    runner.send({ type: 'run.cancel', run_id: msg.run_id })
    await runner.waitFor((e) => e.type === 'run.finished' && e.run_id === msg.run_id, 10_000)
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 3000, `cancel took ${elapsed}ms`)
    const events = runner.events.filter((e) => e.run_id === msg.run_id)
    assert.deepEqual(stepEvents(events, 'rc_cancel_1').map((s) => s.status), ['passed', 'skipped', 'skipped'])
    assert.deepEqual(byType(events, 'case.finished').map((f) => [f.case_id, f.status]), [['rc_cancel_1', 'skipped'], [c2.case_id, 'skipped']])
    assert.equal(byType(events, 'run.finished')[0].status, 'cancelled')
    assert.equal(byType(events, 'runner.error').length, 0)
  })
})

describe('secrets', () => {
  test('secrets are interpolated for execution but never appear in events', async () => {
    const leak = {
      case_id: 'rc_secret',
      steps: [
        { step_id: 's1', action: 'goto', url: '{{env.BASE_URL}}/login' },
        { step_id: 's2', action: 'fill', selector: 'label=Email', value: 'pw={{secret.QA_PASSWORD}}' },
        { step_id: 's3', action: 'expect_value', selector: 'label=Email', value: 'something else', match: 'equals', timeout_ms: 500 },
      ],
    }
    const events = await runner.run(msgFor('secret', [SHOP_CASES.login(), leak], { stopOnFailure: false }))
    // login passing proves {{secret.QA_PASSWORD}} reached the target
    assert.equal(byType(events, 'case.finished')[0].status, 'passed')
    const failed = stepEvents(events, 'rc_secret')[2]
    assert.equal(failed.status, 'failed')
    assert.equal(failed.details.actual, 'pw=••••')
    assert.match(failed.error, /received "pw=••••"/)
    const raw = runner.rawLines.join('\n')
    assert.ok(!raw.includes(DEMO_SECRETS.QA_PASSWORD), 'secret value leaked into the event stream')
  })
})

describe('protocol errors', () => {
  test('manual steps are rejected with runner.error and run.finished error', async () => {
    const msg = msgFor('manual', [{ case_id: 'rc_manual', steps: [{ step_id: 'm1', action: 'manual', description: 'Do it by hand' }] }])
    const events = await runner.run(msg)
    assert.deepEqual(events.map((e) => e.type), ['runner.error', 'run.finished'])
    assert.match(events[0].message, /manual/)
    assert.equal(events[1].status, 'error')
  })

  test('invalid JSON line → runner.error with run_id null; runner keeps working', async () => {
    const before = runner.events.length
    runner.sendRaw('{not json')
    const err = await runner.waitFor((e) => e.type === 'runner.error' && e.run_id === null && runner.events.indexOf(e) >= before)
    assert.match(err.message, /Invalid JSON/)
    const events = await runner.run(msgFor('afterbad', [SHOP_CASES.api_products()]))
    assert.equal(byType(events, 'run.finished')[0].status, 'passed')
  })

  test('browser launch failure → step error, runner.error, case/run error', async () => {
    const empty = tempDir('qatlas-no-browsers-')
    const r = new Runner({ PLAYWRIGHT_BROWSERS_PATH: empty.dir })
    try {
      await r.ready()
      const msg = runStart({ runId: nextRunId('infra'), artifactDir: join(tmp.dir, 'infra'), baseUrl: demo.url, cases: [SHOP_CASES.home()] })
      const events = await r.run(msg)
      const steps = stepEvents(events, 'rc_home')
      assert.equal(steps[0].status, 'error')
      assert.match(steps[0].error, /Browser chromium failed to launch/)
      assert.deepEqual(steps.slice(1).map((s) => s.status), ['skipped', 'skipped', 'skipped'])
      assert.equal(byType(events, 'runner.error')[0].run_id, msg.run_id)
      assert.equal(byType(events, 'case.finished')[0].status, 'error')
      assert.equal(byType(events, 'run.finished')[0].status, 'error')
    } finally {
      await r.close()
      empty.cleanup()
    }
  })
})

describe('concurrency', () => {
  test('concurrent runs share one browser instance', async () => {
    const r = new Runner()
    try {
      await r.ready()
      const mk = (name, c) => runStart({ runId: nextRunId(name), artifactDir: join(tmp.dir, name), baseUrl: demo.url, cases: [c] })
      const [a, b] = [mk('conc_a', SHOP_CASES.search()), mk('conc_b', SHOP_CASES.category())]
      const [ea, eb] = await Promise.all([r.run(a), r.run(b)])
      assert.equal(byType(ea, 'run.finished')[0].status, 'passed', JSON.stringify(ea.filter((e) => e.error)))
      assert.equal(byType(eb, 'run.finished')[0].status, 'passed', JSON.stringify(eb.filter((e) => e.error)))
      assert.equal((r.stderr.match(/launching browser/g) ?? []).length, 1)
    } finally {
      await r.close()
    }
  })
})

describe('lifecycle', () => {
  test('stdin EOF lets in-flight runs finish, then exits 0', async () => {
    const r = new Runner()
    await r.ready()
    const msg = runStart({ runId: nextRunId('eof'), artifactDir: join(tmp.dir, 'eof'), baseUrl: demo.url, cases: [SHOP_CASES.product()] })
    r.send(msg)
    r.child.stdin.end()
    const { code } = await r.exited
    assert.equal(code, 0)
    const fin = r.events.find((e) => e.type === 'run.finished')
    assert.equal(fin?.status, 'passed', r.stderr)
  })

  test('SIGTERM cancels in-flight runs, closes browsers and exits 0', async () => {
    const r = new Runner()
    await r.ready()
    const c = {
      case_id: 'rc_sigterm',
      steps: [
        { step_id: 't1', action: 'goto', url: '{{env.BASE_URL}}' },
        { step_id: 't2', action: 'wait', ms: 20000 },
      ],
    }
    const msg = runStart({ runId: nextRunId('sigterm'), artifactDir: join(tmp.dir, 'sigterm'), baseUrl: demo.url, cases: [c] })
    r.send(msg)
    await r.waitFor((e) => e.type === 'step.started' && e.step_id === 't2')
    const t0 = Date.now()
    r.child.kill('SIGTERM')
    const { code } = await r.exited
    assert.equal(code, 0)
    assert.ok(Date.now() - t0 < 5000)
    assert.equal(r.events.find((e) => e.type === 'run.finished')?.status, 'cancelled')
    assert.match(r.stderr, /bye/)
  })
})
