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
