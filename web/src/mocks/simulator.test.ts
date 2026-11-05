import { beforeEach, describe, expect, it } from 'vitest'
import './history'
import { db, resetDb } from './db'
import { DEFAULT_RUN_OPTIONS } from './seed'
import { completeManualCase, createRun, fastForward } from './simulator'

function project(key: string) {
  return db().projects.find((p) => p.key === key)!
}
function env(projectId: string) {
  return db().environments.find((e) => e.project_id === projectId && e.is_default)
}

describe('mock run simulator', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDb()
  })

  it('seed berisi riwayat run dan run manual yang masih terbuka', () => {
    const s = db()
    expect(s.runs.length).toBeGreaterThan(30)
    expect(s.runs.filter((r) => r.status === 'awaiting_manual').length).toBeGreaterThanOrEqual(2)
    expect(s.runs.some((r) => r.status === 'failed')).toBe(true)
  })

  it('test voucher (SHOP-T12) gagal dengan expected vs actual, lalu lolos setelah expected diperbaiki', () => {
    const p = project('SHOP')
    const tc = db().testCases.find((t) => t.key === 'SHOP-T12')!
    const run = createRun({ project: p, kind: 'test_case', targetId: tc.id, env: env(p.id), options: { ...DEFAULT_RUN_OPTIONS, screenshot: 'every_step' }, userId: 'u_rina', trigger: 'manual' })
    db().runs.push(run)
    fastForward(run, Date.now())
    expect(run.status).toBe('failed')
    const failed = run.cases[0].steps.find((s) => s.status === 'failed')!
    expect(failed.details).toMatchObject({ expected: 'Rp 81.000', actual: 'Rp 90.000' })
    expect(failed.screenshot_id).not.toBeNull()
    expect(run.cases[0].steps.at(-1)!.status).toBe('skipped')

    const step = tc.steps.find((s) => s.selector === 'testid=grand-total')!
    step.value = 'Rp 90.000'
    const rerun = createRun({ project: p, kind: 'test_case', targetId: tc.id, env: env(p.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
    db().runs.push(rerun)
    fastForward(rerun, Date.now())
    expect(rerun.status).toBe('passed')
  })

  it('case 2FA & verifikasi email (SHOP-T20…T22) lolos; polling, save_regex dan fn.totp disimulasikan', () => {
    const p = project('SHOP')
    const byTitle = (title: string) => db().testCases.find((t) => t.title === title)!
    expect(['SHOP-T20', 'SHOP-T21', 'SHOP-T22'].map((k) => db().testCases.find((t) => t.key === k)!.title)).toEqual([
      'Log in with TOTP 2FA', 'Sign up and verify email (Mailpit)', 'Verify email with the 6-digit code',
    ])
    const runOf = (title: string) => {
      const run = createRun({ project: p, kind: 'test_case', targetId: byTitle(title).id, env: env(p.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
      db().runs.push(run)
      fastForward(run, Date.now())
      expect(run.status).toBe('passed')
      return run.cases[0].steps
    }

    const totp = runOf('Log in with TOTP 2FA').find((s) => s.summary.includes('Authentication code'))!
    expect(totp.summary).toMatch(/\b\d{6}\b/)

    const link = runOf('Sign up and verify email (Mailpit)')
    const poll = link.find((s) => s.action === 'http_request')!
    expect(poll.details).toMatchObject({ attempts: expect.any(Number), response: { body: { messages: [{ Subject: 'Verify your Tokoku account' }] } } })
    expect((poll.details as { attempts: number }).attempts).toBeGreaterThan(1)
    const visit = link.find((s) => s.action === 'goto' && s.summary.includes('/verify?token='))
    expect(visit?.summary).toContain('https://staging.tokoku.id/verify?token=')

    const code = runOf('Verify email with the 6-digit code').find((s) => s.action === 'fill' && s.summary.includes('Verification code'))!
    expect(code.summary).toMatch(/\b\d{6}\b/)
  })

  it('contoh API testing (SHOP-T23…T27, SHOP-F4, PAY) lolos dengan request/response, status dan header realistis', () => {
    const shop = project('SHOP')
    const byKey = (key: string) => db().testCases.find((t) => t.key === key)!
    expect(['SHOP-T23', 'SHOP-T24', 'SHOP-T25', 'SHOP-T26', 'SHOP-T27'].map((k) => byKey(k).title)).toEqual([
      'API: log in and fetch my profile', 'API: product CRUD lifecycle', 'API: validation errors return 422',
      'API: unauthorized without token', 'API: list products with pagination',
    ])
    const runCase = (key: string) => {
      const tc = byKey(key)
      const p = db().projects.find((x) => x.id === tc.project_id)!
      const run = createRun({ project: p, kind: 'test_case', targetId: tc.id, env: env(p.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
      db().runs.push(run)
      fastForward(run, Date.now())
      return run
    }
    for (const key of ['SHOP-T23', 'SHOP-T24', 'SHOP-T25', 'SHOP-T26', 'SHOP-T27', 'PAY-T1', 'PAY-T2']) {
      const run = runCase(key)
      expect({ key, status: run.status, failed: run.cases[0].steps.find((s) => s.status !== 'passed')?.error_message }).toEqual({ key, status: 'passed', failed: undefined })
    }

    // CRUD: Location header, 204 on delete, 404 afterwards; the token is sent as Bearer (secrets stay masked).
    const crud = runCase('SHOP-T24').cases[0].steps
    type Http = { request: { method: string; url: string; headers?: Record<string, string>; body?: unknown }; response: { status: number; headers: Record<string, string>; body: unknown } }
    const http = crud.filter((s) => s.action === 'http_request').map((s) => s.details as unknown as Http)
    expect(http.map((d) => `${d.request.method} ${d.response.status}`)).toEqual(['POST 201', 'POST 201', 'GET 200', 'PATCH 200', 'DELETE 204', 'GET 404'])
    expect(http[0].request.body).toEqual({ email: 'qa.bot@tokoku.id', password: '••••' })
    expect(http[1].request.headers?.Authorization).toMatch(/^Bearer tkk_[0-9a-f]{32}$/)
    expect(http[1].response.headers.location).toMatch(/^\/api\/v1\/products\/prd_[0-9a-f]+$/)
    expect(crud.find((s) => s.action === 'expect_header')!.details).toMatchObject({ actual: http[1].response.headers.location })
    expect(crud.at(-1)!.details).toEqual({ expected: 'not_found', actual: 'not_found' })

    const unauthorized = runCase('SHOP-T26').cases[0].steps.filter((s) => s.action === 'expect_header').map((s) => s.details)
    expect(unauthorized[0]).toEqual({ expected: 'Bearer', actual: 'Bearer realm="tokoku"' })
    const pagination = runCase('SHOP-T27').cases[0].steps
    expect((pagination[0].details as unknown as Http).request.url).toBe('https://api.staging.tokoku.id/v1/products?limit=2&offset=2')

    // Refund: pending → polling → succeeded, then 422 for more than the rest (flaky tag removed for a stable result).
    const refund = byKey('PAY-T3')
    refund.tags = refund.tags.filter((t) => t !== 'flaky')
    const refundRun = runCase('PAY-T3')
    expect(refundRun.status).toBe('passed')
    const poll = refundRun.cases[0].steps.find((s) => s.step_id === 'rf7')!
    expect(poll.details).toMatchObject({ attempts: expect.any(Number), response: { status: 200, body: { data: { status: 'succeeded' } } } })
    expect(refundRun.cases[0].steps.find((s) => s.step_id === 'rf10')!.details).toEqual({ expected: '422', actual: '422' })

    const flow = db().flows.find((f) => f.key === 'SHOP-F4')!
    expect(flow).toMatchObject({ name: 'API regression', shared_session: false })
    const flowRun = createRun({ project: shop, kind: 'flow', targetId: flow.id, env: env(shop.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
    db().runs.push(flowRun)
    fastForward(flowRun, Date.now())
    expect(flowRun.status).toBe('passed')
    expect(flowRun.cases).toHaveLength(7)

    // A wrong expectation fails with expected vs actual, like the real runner.
    byKey('SHOP-T24').steps.find((s) => s.action === 'expect_status' && s.value === 204)!.value = 200
    const broken = runCase('SHOP-T24')
    expect(broken.status).toBe('failed')
    const failed = broken.cases[0].steps.find((s) => s.status === 'failed')!
    expect(failed.error_message).toBe('Expected status 200, received 204')
    expect(failed.details).toEqual({ expected: '200', actual: '204' })
  })

  it('secret dimask di ringkasan step', () => {
    const p = project('SHOP')
    const tc = db().testCases.find((t) => t.key === 'SHOP-T1')!
    const run = createRun({ project: p, kind: 'test_case', targetId: tc.id, env: env(p.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
    const summaries = run.cases[0].steps.map((s) => s.summary).join('\n')
    expect(summaries).toContain('••••')
    expect(summaries).not.toContain('Qa-Staging-2026!')
    expect(summaries).toContain('https://staging.tokoku.id/login')
  })

  it('flow campuran berhenti di case manual lalu lanjut setelah diselesaikan', () => {
    const p = project('SHOP')
    const flow = db().flows.find((f) => f.key === 'SHOP-F3')!
    const run = createRun({ project: p, kind: 'flow', targetId: flow.id, env: env(p.id), options: DEFAULT_RUN_OPTIONS, userId: 'u_rina', trigger: 'manual' })
    db().runs.push(run)
    fastForward(run, Date.now())
    expect(run.status).toBe('awaiting_manual')
    const manual = run.cases.find((c) => c.position === run.resume_position)!
    expect(manual.execution).toBe('manual')
    expect(completeManualCase(run, manual.id, 'u_rina')).toMatch(/not marked yet/)
    manual.steps.forEach((s) => (s.status = 'passed'))
    expect(completeManualCase(run, manual.id, 'u_rina')).toBeNull()
    expect(run.status).toBe('running')
    fastForward(run, Date.now())
    expect(run.status).toBe('passed')
    expect(run.cases.every((c) => c.status === 'passed')).toBe(true)
  })

  it('stop_on_failure men-skip case setelah case gagal', () => {
    const p = project('SHOP')
    const flow = db().flows.find((f) => f.key === 'SHOP-F1')!
    flow.items.splice(1, 0, { id: 'x', test_case_id: db().testCases.find((t) => t.key === 'SHOP-T12')!.id, continue_on_failure: false, enabled: true })
    const run = createRun({ project: p, kind: 'flow', targetId: flow.id, env: env(p.id), options: { ...DEFAULT_RUN_OPTIONS, video: 'always' }, userId: 'u_rina', trigger: 'manual' })
    db().runs.push(run)
    fastForward(run, Date.now())
    expect(run.status).toBe('failed')
    expect(run.cases.map((c) => c.status)).toEqual(['passed', 'failed', 'skipped', 'skipped'])
    // shared session → satu video untuk seluruh flow
    expect(run.cases.filter((c) => c.video_id).length).toBe(1)
  })
})
