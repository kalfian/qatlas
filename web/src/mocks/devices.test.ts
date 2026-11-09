import { setupServer } from 'msw/node'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Device, Run, Step } from '@/api/types'
import { customDevice, presetDevice } from '@/lib/devices'
import './history'
import { db, resetDb, toProject, toRun } from './db'
import { handlers } from './handlers'
import { runToJUnit } from './junit'
import { DEFAULT_RUN_OPTIONS } from './seed'
import { completeManualCase, createRun, fastForward, horizontalOverflow } from './simulator'

/** Responsive testing in the mock (docs/14): device resolution, per-device cases, only_on, new actions. */

const project = (key: string) => db().projects.find((p) => p.key === key)!
const env = (projectId: string) => db().environments.find((e) => e.project_id === projectId && e.is_default)
const tc = (key: string) => db().testCases.find((t) => t.key === key)!
const devices = (...ids: string[]): Device[] => ids.map((id) => presetDevice(id)!)

function runOf(kind: 'test_case' | 'flow', key: string, devs: Device[], extra: Partial<typeof DEFAULT_RUN_OPTIONS> = {}) {
  const p = project(key.split('-')[0])
  const targetId = kind === 'flow' ? db().flows.find((f) => f.key === key)!.id : tc(key).id
  const run = createRun({ project: p, kind, targetId, env: env(p.id), options: { ...DEFAULT_RUN_OPTIONS, ...extra, devices: devs }, userId: 'u_rina', trigger: 'manual' })
  db().runs.push(run)
  return run
}

beforeEach(() => {
  localStorage.clear()
  resetDb()
})

describe('mock runs on several devices', () => {
  it('creates cases device by device: positions 1..N per device, device_index, viewport = devices[0]', () => {
    const run = runOf('flow', 'SHOP-F1', devices('desktop', 'ipad-mini', 'iphone-15'))
    expect(run.cases.map((c) => [c.position, c.device_index, c.test_case_key])).toEqual([
      [1, 0, 'SHOP-T1'], [2, 0, 'SHOP-T8'], [3, 0, 'SHOP-T11'],
      [4, 1, 'SHOP-T1'], [5, 1, 'SHOP-T8'], [6, 1, 'SHOP-T11'],
      [7, 2, 'SHOP-T1'], [8, 2, 'SHOP-T8'], [9, 2, 'SHOP-T11'],
    ])
    expect(run.options.viewport).toEqual({ width: 1280, height: 720 })
    const api = toRun(run)
    expect(api.options.devices.map((d) => d.id)).toEqual(['desktop', 'ipad-mini', 'iphone-15'])
    expect(api.cases.every((c) => c.steps.every((s) => s.only_on === null))).toBe(true)
  })

  it('stop_on_failure only applies within the same device; shared session = one video per device', () => {
    const run = runOf('flow', 'SHOP-F1', devices('desktop', 'iphone-15'), { video: 'always' })
    // fail SHOP-T8 on the iPhone only
    const iphoneT8 = run.cases.find((c) => c.device_index === 1 && c.test_case_key === 'SHOP-T8')!
    iphoneT8.steps[2].sim = { outcome: 'failed', error: 'element is outside of the viewport', duration_ms: 100 }
    fastForward(run, Date.now())
    expect(run.status).toBe('failed')
    expect(run.cases.map((c) => c.status)).toEqual(['passed', 'passed', 'passed', 'passed', 'failed', 'skipped'])
    expect(run.cases.filter((c) => c.video_id).map((c) => c.device_index)).toEqual([0, 1])
  })

  it('only_on: a step outside the device category is disabled → skipped, with the only_on snapshot', () => {
    const t = tc('SHOP-T18')
    t.steps[2] = { ...t.steps[2], only_on: ['desktop'] } // main navigation is only checked on desktop
    const run = runOf('test_case', 'SHOP-T18', devices('desktop', 'pixel-7'))
    fastForward(run, Date.now())
    const [desk, phone] = run.cases
    expect(desk.steps[2]).toMatchObject({ status: 'passed', only_on: ['desktop'] })
    expect(phone.steps[2]).toMatchObject({ status: 'skipped', only_on: ['desktop'], enabled: false })
    expect(phone.status).toBe('passed')
    expect(toRun(run).cases[1].steps[2].only_on).toEqual(['desktop'])
  })

  it('manual cases repeat per device; steps not meant for the device are skipped up front', () => {
    const manual = tc('SHOP-T4')
    manual.steps[0] = { ...manual.steps[0], only_on: ['mobile'] }
    const run = runOf('test_case', 'SHOP-T4', devices('desktop', 'iphone-se'))
    expect(run.status).toBe('awaiting_manual')
    expect(run.cases.map((c) => c.steps[0].status)).toEqual(['skipped', 'pending'])
    const [desk, phone] = run.cases
    desk.steps.filter((s) => s.status === 'pending').forEach((s) => (s.status = 'passed'))
    expect(completeManualCase(run, desk.id, 'u_rina')).toBeNull()
    fastForward(run, Date.now())
    expect(run.status).toBe('awaiting_manual')
    expect(run.resume_position).toBe(phone.position)
  })
})

describe('responsive actions in the simulator', () => {
  const addSteps = (key: string, steps: Step[]) => tc(key).steps.splice(1, 0, ...steps)

  it('expect_no_horizontal_scroll fails on phones on a wide page, with offenders; passes on tablet/desktop', () => {
    addSteps('SHOP-T8', [{ id: 'nhs', action: 'expect_no_horizontal_scroll' }])
    const run = runOf('test_case', 'SHOP-T8', devices('desktop', 'ipad-mini', 'iphone-15'))
    fastForward(run, Date.now())
    const step = (di: number) => run.cases[di].steps.find((s) => s.step_id === 'nhs')!
    expect([step(0).status, step(1).status, step(2).status]).toEqual(['passed', 'passed', 'failed'])
    expect(step(2).error_message).toBe(
      'Expected the page to have no horizontal scroll, but its content is 650px wide in 393px; widest: table (right edge 650px)',
    )
    expect(step(1).details).toEqual({ expected: 'content width ≤ 768px', actual: 'content width 768px' })
    expect(step(2).details).toEqual({
      expected: 'content width ≤ 393px',
      actual: 'content width 650px',
      offenders: ['table (right edge 650px)'],
    })
    expect(step(2).summary).toBe('Expect no horizontal scroll')
    expect(run.cases.map((c) => c.status)).toEqual(['passed', 'passed', 'failed'])
  })

  it('set_viewport passes and changes the width later checks see; tolerance_px is honoured', () => {
    addSteps('SHOP-T8', [
      { id: 'vp', action: 'set_viewport', width: 1024, height: 768 },
      { id: 'nhs', action: 'expect_no_horizontal_scroll', selector: 'main' },
    ])
    const run = runOf('test_case', 'SHOP-T8', devices('iphone-15'))
    fastForward(run, Date.now())
    const steps = run.cases[0].steps
    expect(steps.find((s) => s.step_id === 'vp')).toMatchObject({ status: 'passed', summary: 'Set viewport 1024×768' })
    expect(steps.find((s) => s.step_id === 'nhs')).toMatchObject({ status: 'passed', summary: 'Expect no horizontal scroll in main' })

    expect(horizontalOverflow({ width: 600, category: 'tablet', pageUrl: 'https://x/products/a' }, 50).pass).toBe(true)
    expect(horizontalOverflow({ width: 600, category: 'tablet', pageUrl: 'https://x/products/a' }, 49).pass).toBe(false)
    expect(horizontalOverflow({ width: 390, category: 'mobile', pageUrl: 'https://x/account' }).pass).toBe(true)
  })
})

describe('seed', () => {
  it('every run and project carries devices; old runs have one device, device_index 0 and only_on null', () => {
    for (const p of db().projects) expect(toProject(p, db().users[0]).default_run_options.devices.map((d) => d.id)).toEqual(['desktop'])
    const single = db().runs.filter((r) => r.options.devices.length === 1)
    expect(single.length).toBeGreaterThan(30)
    for (const r of single.map(toRun)) {
      expect(r.options.viewport).toEqual({ width: r.options.devices[0].width, height: r.options.devices[0].height })
      expect(r.cases.every((c) => c.device_index === 0 && c.steps.every((s) => s.only_on === null))).toBe(true)
    }
  })

  it('has no multi-device sample runs (responsive sample data removed)', () => {
    expect(db().runs.filter((r) => r.options.devices.length > 1)).toEqual([])
    expect(db().flows.map((f) => f.key)).not.toContain('SHOP-F5')
    expect(db().folders.map((f) => f.name)).not.toContain('Responsive')
  })

  it('JUnit of a multi-device run names test cases "{title} [{device}]"', () => {
    const run = runOf('flow', 'SHOP-F1', devices('desktop', 'ipad-mini', 'iphone-15'))
    fastForward(run, Date.now())
    const xml = runToJUnit(toRun(run))
    expect(xml).toContain('name="SHOP-T8 Add a product to the cart [iPhone 15]"')
    expect(xml).toContain('name="SHOP-T8 Add a product to the cart [Desktop]"')
    expect(xml).not.toContain('[#')
  })
})

describe('mock API: run options with devices', () => {
  const server = setupServer(...handlers)
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterAll(() => server.close())
  beforeEach(() => {
    db().session = { user_id: 'u_rina' }
  })

  const post = (path: string, body: unknown, method = 'POST') =>
    // handlers are registered with relative paths → resolved against jsdom's location
    fetch(new URL(`/api/v1${path}`, location.href), { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  it('POST runs resolves presets and custom sizes; viewport follows devices[0]', async () => {
    const res = await post('/projects/SHOP/runs', { flow: 'SHOP-F2', options: { devices: [{ id: 'iphone-15' }, { id: 'custom', width: 900, height: 1200 }] } })
    expect(res.status).toBe(202)
    const run = (await res.json()) as Run
    expect(run.options.devices).toEqual([presetDevice('iphone-15'), customDevice({ width: 900, height: 1200 })])
    expect(run.options.viewport).toEqual({ width: 393, height: 659 })
    expect(run.cases).toHaveLength(10)
    expect(run.cases.at(-1)).toMatchObject({ position: 10, device_index: 1 })
  })

  it('a lone legacy viewport becomes one device; no options → project default', async () => {
    const legacy = (await (await post('/projects/SHOP/runs', { test_case: 'SHOP-T1', options: { viewport: { width: 1440, height: 900 } } })).json()) as Run
    expect(legacy.options.devices.map((d) => d.id)).toEqual(['laptop'])
    const plain = (await (await post('/projects/SHOP/runs', { test_case: 'SHOP-T1' })).json()) as Run
    expect(plain.options.devices.map((d) => d.id)).toEqual(['desktop'])
  })

  it('422 validation_failed with the backend paths', async () => {
    const bad = async (devices: unknown) => {
      const res = await post('/projects/SHOP/runs', { test_case: 'SHOP-T1', options: { devices } })
      expect(res.status).toBe(422)
      const body = (await res.json()) as { error: { code: string; details: { path: string }[] } }
      expect(body.error.code).toBe('validation_failed')
      return body.error.details.map((d) => d.path)
    }
    expect(await bad([])).toEqual(['options.devices'])
    expect(await bad([{ id: 'desktop' }, { id: 'nokia-3310' }])).toEqual(['options.devices[1].id'])
    expect(await bad([{ id: 'custom', width: 10, height: 844 }])).toEqual(['options.devices[0].width'])
    expect(await bad([{ id: 'ipad-mini' }, { id: 'ipad-mini' }])).toEqual(['options.devices[1]'])
  })

  it('PATCH project default_run_options.devices (validated, stored resolved)', async () => {
    const bad = await post('/projects/SHOP', { default_run_options: { devices: [{ id: 'custom', width: 390, height: 9999 }] } }, 'PATCH')
    expect(bad.status).toBe(400) // PATCH project keeps 400 validation_failed (backend projects/options.go)
    expect(((await bad.json()) as { error: { details: { path: string }[] } }).error.details[0].path).toBe('default_run_options.devices[0].height')
    const ok = await post('/projects/SHOP', { default_run_options: { devices: [{ id: 'desktop' }, { id: 'pixel-7' }] } }, 'PATCH')
    expect(ok.status).toBe(200)
    expect(project('SHOP').default_run_options.devices.map((d) => d.id)).toEqual(['desktop', 'pixel-7'])
    const run = (await (await post('/projects/SHOP/runs', { test_case: 'SHOP-T1' })).json()) as Run
    expect(run.cases.map((c) => c.device_index)).toEqual([0, 1])
  })
})

describe('overflow details follow the runner format', () => {
  it('tolerance appears in expected; only elements past clientWidth + tolerance are offenders', () => {
    const r = horizontalOverflow({ width: 640, category: 'tablet', pageUrl: 'https://x/products/a' }, 5, false, 'main')
    expect(r.pass).toBe(false)
    expect(r.details).toEqual({ expected: 'content width ≤ 640px (+5px tolerance)', actual: 'content width 650px', offenders: ['table (right edge 650px)'] })
    expect(r.error).toBe("Expected locator('main') to have no horizontal scroll, but its content is 650px wide in 640px (tolerance 5px); widest: table (right edge 650px)")
    const within = horizontalOverflow({ width: 640, category: 'tablet', pageUrl: 'https://x/products/a' }, 10)
    expect(within).toEqual({ pass: true, details: { expected: 'content width ≤ 640px (+10px tolerance)', actual: 'content width 650px' } })
  })
})
