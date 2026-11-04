import { beforeEach, describe, expect, it } from 'vitest'
import type { Run, RunCase, RunStep } from '@/api/types'
import './history'
import { db, resetDb, toRun } from './db'
import { junitFilename, runToJUnit } from './junit'

function step(p: Partial<RunStep> & Pick<RunStep, 'position' | 'step_id' | 'status'>): RunStep {
  return {
    id: `st_${p.step_id}_${p.position}`,
    action: 'goto',
    summary: '',
    description: '',
    expected: '',
    duration_ms: null,
    error_message: null,
    actual_result: null,
    screenshot: null,
    details: null,
    ...p,
  } as RunStep
}

function kase(p: Partial<RunCase> & Pick<RunCase, 'position' | 'test_case_key' | 'title' | 'status' | 'steps'>): RunCase {
  return {
    id: `c${p.position}`,
    test_case_id: `tc_${p.test_case_key}`,
    test_case_revision: 1,
    execution: 'automated',
    executed_by: null,
    started_at: null,
    finished_at: null,
    duration_ms: null,
    video: null,
    attachments: [],
    ...p,
  } as RunCase
}

/** Same fixture as backend/internal/runs/junit_test.go (junitFixture) so both builders can be compared. */
function fixture(): Run {
  const login = step({ position: 1, step_id: 's1', action: 'fill', summary: 'fill label=Password with ••••', status: 'passed', duration_ms: 120 })
  const failed = step({
    position: 2,
    step_id: 's2',
    action: 'expect_text',
    summary: 'text "Total" contains "<Rp 10.000>"',
    status: 'failed',
    duration_ms: 5003,
    error_message: '\u001b[31mExpected\u001b[39m text to contain "<Rp 10.000>" & more\u0000',
    details: { expected: '<Rp 10.000>', actual: 'Rp 9.000 & "tax"' },
  })
  return {
    id: 'r12',
    key: 'SHOP-R12',
    project_key: 'SHOP',
    kind: 'flow',
    target: { id: 'f2', key: 'SHOP-F2', title: 'Checkout "happy" path' },
    environment: { id: 'e1', name: 'Staging' },
    status: 'failed',
    trigger: 'api',
    triggered_by: { id: 'u1', name: 'CI bot', email: 'ci@example.com' },
    assignee: null,
    has_manual: true,
    summary: {} as Run['summary'],
    queued_at: '2026-11-04T02:30:14Z',
    started_at: '2026-11-04T02:30:15Z',
    finished_at: '2026-11-04T02:30:27Z',
    duration_ms: 12345,
    options: { browser: 'firefox' } as Run['options'],
    shared_session: false,
    stop_on_failure: true,
    error_message: null,
    cancel_requested: false,
    resume_position: null,
    cases: [
      kase({ position: 1, test_case_key: 'SHOP-T1', title: 'Login', status: 'passed', duration_ms: 1500, steps: [login] }),
      kase({ position: 2, test_case_key: 'SHOP-T3', title: 'Cart <total>', status: 'failed', duration_ms: 5200, steps: [login, failed] }),
      kase({
        position: 3,
        test_case_key: 'SHOP-T7',
        title: 'Invoice',
        execution: 'manual',
        status: 'failed',
        executed_by: { id: 'u2', name: 'Sari & Co', email: 'sari@example.com' },
        steps: [
          step({ position: 1, step_id: 'm1', action: 'manual', summary: 'manual', description: 'Open the invoice list', expected: 'Invoices are listed', status: 'failed', actual_result: 'Empty page <blank>' }),
          step({ position: 2, step_id: 'm2', action: 'manual', summary: 'manual', description: 'Download the PDF', status: 'passed', actual_result: 'Downloaded' }),
        ],
      }),
      kase({
        position: 4,
        test_case_key: 'SHOP-T8',
        title: 'Delivery',
        execution: 'manual',
        status: 'blocked',
        steps: [step({ position: 1, step_id: 'b1', action: 'manual', summary: 'manual', description: 'Sign the delivery', status: 'blocked', actual_result: 'Printer offline' })],
      }),
      kase({
        position: 5,
        test_case_key: 'SHOP-T9',
        title: 'Payment',
        status: 'error',
        steps: [step({ position: 1, step_id: 'e1', summary: 'goto https://shop.example/', status: 'error', duration_ms: 15000, error_message: 'Runner crashed' })],
      }),
      kase({ position: 6, test_case_key: 'SHOP-T1', title: 'Login', status: 'skipped', steps: [step({ position: 1, step_id: 's1', action: 'fill', summary: 'fill', status: 'skipped', duration_ms: 0 })] }),
    ],
  } as Run
}

function parse(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0)
  return doc
}

describe('mock JUnit export', () => {
  beforeEach(() => {
    localStorage.clear()
    resetDb()
  })

  it('builds valid JUnit XML with counts, mapping and escaping', () => {
    const xml = runToJUnit(fixture())
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="QAtlas SHOP-R12" tests="6" failures="3" errors="1" skipped="1" time="12.345">')).toBe(true)
    const doc = parse(xml)
    const suite = doc.querySelector('testsuite')!
    expect(suite.getAttribute('name')).toBe('SHOP-F2 Checkout "happy" path')
    expect(suite.getAttribute('timestamp')).toBe('2026-11-04T02:30:15')
    expect(doc.querySelector('property[name="qatlas.browser"]')?.getAttribute('value')).toBe('firefox')

    const cases = [...doc.querySelectorAll('testcase')]
    expect(cases.map((c) => c.getAttribute('name'))).toEqual([
      'SHOP-T1 Login [#1]',
      'SHOP-T3 Cart <total>',
      'SHOP-T7 Invoice',
      'SHOP-T8 Delivery',
      'SHOP-T9 Payment',
      'SHOP-T1 Login [#6]',
    ])
    const failure = cases[1].querySelector('failure')!
    expect(failure.getAttribute('message')).toBe('Step 2: text "Total" contains "<Rp 10.000>" — Expected text to contain "<Rp 10.000>" & more')
    expect(failure.textContent).toContain('Actual: Rp 9.000 & "tax"')
    expect(cases[2].querySelector('system-out')?.textContent).toContain('Manual test case, executed by Sari & Co')
    expect(cases[3].querySelector('failure')?.getAttribute('type')).toBe('blocked')
    expect(cases[4].querySelector('error')?.getAttribute('message')).toBe('Step 1: goto https://shop.example/ — Runner crashed')
    expect(cases[5].querySelector('skipped')).not.toBeNull()
    expect(xml.includes('\u0000') || xml.includes('\u001b')).toBe(false)
    expect(xml).toContain('Cart &lt;total&gt;')
    expect(junitFilename('SHOP-R12')).toBe('SHOP-R12.junit.xml')
  })

  it('exports every final seeded run as well-formed XML', () => {
    const finals = db().runs.filter((r) => ['passed', 'failed', 'blocked', 'error', 'cancelled'].includes(r.status))
    expect(finals.length).toBeGreaterThan(10)
    for (const r of finals) {
      const run = toRun(r)
      const doc = parse(runToJUnit(run))
      const root = doc.documentElement
      expect(root.tagName).toBe('testsuites')
      expect(Number(root.getAttribute('tests'))).toBe(run.cases.length)
      expect(doc.querySelectorAll('testcase')).toHaveLength(run.cases.length)
    }
  })
})
