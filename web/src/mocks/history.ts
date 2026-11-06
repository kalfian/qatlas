import { presetDevice } from '@/lib/device-catalog'
import { DEFAULT_RUN_OPTIONS, buildSeed, historySpecs } from './seed'
import { registerSeed, setState, type MockState } from './db'
import { advance, completeManualCase, createRun, fastForward, rngFor } from './simulator'

const DAY = 86_400_000

export function populateHistory(state: MockState) {
  const now = Date.now()
  for (const [i, spec] of historySpecs().entries()) {
    const project = state.projects.find((p) => p.key === spec.projectKey)!
    const target =
      spec.kind === 'flow'
        ? state.flows.find((f) => f.key === spec.target)
        : state.testCases.find((t) => t.key === spec.target)
    if (!target) continue
    const env = state.environments.find((e) => e.project_id === project.id && e.is_default)
    const queuedMs = now - spec.daysAgo * DAY
    const run = createRun({
      project,
      kind: spec.kind,
      targetId: target.id,
      env,
      options: { ...DEFAULT_RUN_OPTIONS, ...spec.options, ...(spec.devices ? { devices: spec.devices.map((id) => presetDevice(id)!) } : {}) },
      userId: spec.user,
      trigger: spec.trigger ?? 'manual',
      assigneeId: spec.assignee,
      rng: rngFor(`${spec.target}-${i}`),
      queuedAt: new Date(queuedMs).toISOString(),
    })
    state.runs.push(run)
    if (spec.failStep) {
      const f = spec.failStep
      const step = run.cases.find((c) => c.device_index === f.device && c.test_case_key === f.caseKey)?.steps[f.stepIndex]
      if (step) step.sim = { outcome: 'failed', error: f.error, duration_ms: 10_000 }
    }
    let t = queuedMs + 1500
    if (spec.infraError) {
      advance(run, t)
      advance(run, (t += 800))
      const c = run.cases[0]
      c.status = 'error'
      c.finished_at = new Date((t += 1200)).toISOString()
      c.duration_ms = 1200
      const s = c.steps[0]
      s.status = 'error'
      s.error_message = spec.infraError
      s.duration_ms = 1200
      for (const x of c.steps.slice(1)) x.status = 'skipped'
      run.status = 'error'
      run.error_message = spec.infraError
      run.finished_at = c.finished_at
      continue
    }
    if (spec.cancel) {
      for (let k = 0; k < 5; k++) advance(run, (t += 400))
      run.cancel_requested = true
      advance(run, (t += 300))
      continue
    }
    fastForward(run, t)
    if (run.status === 'awaiting_manual' && spec.manual && spec.manual !== 'leave-open') {
      const m = spec.manual
      const c = run.cases.find((x) => x.position === run.resume_position)!
      c.steps.forEach((s, idx) => {
        s.status = m.results[idx] ?? 'passed'
        s.actual_result = m.notes?.[idx] || null
        s.duration_ms = 40_000 + idx * 15_000
      })
      completeManualCase(run, c.id, m.by)
      const doneAt = new Date(Date.parse(run.started_at ?? run.queued_at) + 6 * 60_000).toISOString()
      c.finished_at = doneAt
      c.started_at = c.started_at ?? new Date(Date.parse(doneAt) - 4 * 60_000).toISOString()
      c.duration_ms = Date.parse(c.finished_at) - Date.parse(c.started_at)
      if (run.finished_at) run.finished_at = doneAt
      fastForward(run, Date.parse(doneAt))
    }
  }
}

/** Seed lengkap = data dasar + riwayat run yang disimulasikan secara deterministik. */
registerSeed(() => {
  const s = buildSeed()
  setState(s) // simulator memakai db() global
  populateHistory(s)
  return s
})
