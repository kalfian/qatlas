import type { Run, RunCase, RunStep } from '@/api/types'

/**
 * JUnit XML of a run, for the mock `GET /runs/{runKey}/junit.xml`. Port of the Go builder
 * (backend/internal/runs/junit.go): same structure, status mapping, messages and limits, so the
 * mock UI downloads the same document the real backend would produce.
 *
 * passed → plain testcase · failed/blocked → <failure type=…> · error → <error> ·
 * skipped (or never reached) → <skipped/>.
 */

const MESSAGE_CHARS = 500
const TEXT_CHARS = 2000

export function junitFilename(runKey: string) {
  return `${runKey}.junit.xml`
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// Characters XML 1.0 can't carry (C0 controls except tab/newline/CR, lone surrogates, U+FFFE/FFFF, U+FFFD).
// eslint-disable-next-line no-control-regex
const INVALID = /[\u0000-\u0008\u000b\u000c\u000e-\u001f�￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/** Strips ANSI codes and invalid characters, trims and truncates to `max` code points. */
function clean(s: string, max: number): string {
  const out = s.replace(ANSI, '').replace(INVALID, '').trim()
  const chars = Array.from(out)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : out
}

function oneLine(s: string, max: number): string {
  return clean(clean(s, max * 4).split(/\s+/).filter(Boolean).join(' '), max)
}

const xmlText = (s: string) => clean(s, Infinity).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const xmlAttr = (s: string) =>
  xmlText(s).replace(/"/g, '&quot;').replace(/\n/g, '&#10;').replace(/\r/g, '&#13;').replace(/\t/g, '&#9;')

function seconds(ms: number | null | undefined): string {
  return ms == null || ms < 0 ? '0.000' : (ms / 1000).toFixed(3)
}

/** UTC without zone suffix (JUnit XSD timestamp pattern). */
function timestamp(run: Run): string {
  return new Date(run.started_at ?? run.queued_at).toISOString().slice(0, 19)
}

const isProblem = (status: string) => status === 'failed' || status === 'error' || status === 'blocked'

function stepLabel(c: RunCase, s: RunStep): string {
  let label = s.summary
  if (c.execution === 'manual' && s.description.trim()) label = s.description
  if (!label.trim()) label = s.action
  return clean(label, MESSAGE_CHARS)
}

function detailText(v: unknown): string {
  if (v == null) return ''
  return typeof v === 'string' ? v : JSON.stringify(v)
}

function expectedActual(s: RunStep): string[] {
  const d = (s.details && typeof s.details === 'object' ? s.details : {}) as Record<string, unknown>
  let expected = detailText(d.expected)
  let actual = detailText(d.actual)
  if (!expected && s.expected.trim()) expected = s.expected
  if (!actual && s.actual_result != null) actual = s.actual_result
  const lines: string[] = []
  if (expected) lines.push(`Expected: ${clean(expected, TEXT_CHARS)}`)
  if (actual) lines.push(`Actual: ${clean(actual, TEXT_CHARS)}`)
  const resp = d.response as { status?: unknown } | undefined
  if (resp && typeof resp === 'object' && typeof resp.status === 'number') lines.push(`Response status: ${resp.status}`)
  return lines
}

function problemOf(c: RunCase, run: Run): { message: string; text: string } {
  let message = ''
  const parts: string[] = []
  for (const s of c.steps) {
    if (!isProblem(s.status)) continue
    const lines = [`Step ${s.position} (${s.step_id}) ${s.status}: ${stepLabel(c, s)}`]
    const err = s.error_message ? clean(s.error_message, TEXT_CHARS) : ''
    if (s.error_message) lines.push(`Error: ${err}`)
    lines.push(...expectedActual(s))
    if (!message) {
      message = `Step ${s.position}: ${stepLabel(c, s)}`
      if (err) message += ` — ${err}`
      else if (c.execution === 'manual' && s.actual_result) message += ` — ${clean(s.actual_result, TEXT_CHARS)}`
    }
    parts.push(lines.join('\n'))
  }
  if (!message) {
    message = run.error_message ? clean(run.error_message, TEXT_CHARS) : `Test case ${c.status}`
    parts.push(message)
  }
  return { message, text: parts.join('\n\n') }
}

function caseOutput(c: RunCase): string {
  const lines: string[] = []
  if (c.execution === 'manual') {
    lines.push(`Manual test case${c.executed_by?.name ? `, executed by ${clean(c.executed_by.name, 200)}` : ''}`)
  }
  for (const s of c.steps) {
    lines.push(`${s.position}. [${s.status}] ${stepLabel(c, s)}${s.duration_ms != null ? ` (${s.duration_ms} ms)` : ''}`)
    if (c.execution === 'manual') {
      if (s.expected.trim()) lines.push(`   Expected: ${clean(s.expected, TEXT_CHARS)}`)
      if (s.actual_result) lines.push(`   Actual result: ${clean(s.actual_result, TEXT_CHARS)}`)
    }
    if (s.error_message && !isProblem(s.status)) lines.push(`   Note: ${clean(s.error_message, MESSAGE_CHARS)}`)
  }
  return lines.join('\n').trimEnd()
}

export function runToJUnit(run: Run): string {
  const counts = { tests: run.cases.length, failures: 0, errors: 0, skipped: 0 }
  const keyCount = new Map<string, number>()
  for (const c of run.cases) keyCount.set(c.test_case_key, (keyCount.get(c.test_case_key) ?? 0) + 1)

  const cases = run.cases.map((c) => {
    let name = `${c.test_case_key} ${c.title}`.trim()
    if ((keyCount.get(c.test_case_key) ?? 0) > 1) name += ` [#${c.position}]`
    const body: string[] = []
    if (c.status === 'failed' || c.status === 'blocked') {
      const p = problemOf(c, run)
      const msg = c.status === 'blocked' ? `Blocked: ${p.message}` : p.message
      body.push(`      <failure message="${xmlAttr(oneLine(msg, MESSAGE_CHARS))}" type="${c.status}">${xmlText(p.text)}</failure>`)
      counts.failures++
    } else if (c.status === 'error') {
      const p = problemOf(c, run)
      body.push(`      <error message="${xmlAttr(oneLine(p.message, MESSAGE_CHARS))}" type="error">${xmlText(p.text)}</error>`)
      counts.errors++
    } else if (c.status !== 'passed') {
      const msg = c.status !== 'skipped' ? `Not executed (run ${run.status})` : run.status === 'cancelled' ? 'Run cancelled' : ''
      body.push(msg ? `      <skipped message="${xmlAttr(msg)}"/>` : '      <skipped/>')
      counts.skipped++
    }
    const out = caseOutput(c)
    if (out) body.push(`      <system-out>${xmlText(out)}</system-out>`)
    const open = `    <testcase classname="${xmlAttr(run.project_key)}" name="${xmlAttr(name)}" time="${seconds(c.duration_ms)}"`
    return body.length ? `${open}>\n${body.join('\n')}\n    </testcase>` : `${open}/>`
  })

  const props: [string, string][] = [
    ['qatlas.run', run.key],
    ['qatlas.status', run.status],
    ['qatlas.kind', run.kind],
    ['qatlas.target', run.target.key],
    ['qatlas.trigger', run.trigger],
    ['qatlas.triggered_by', run.triggered_by.name],
  ]
  if (run.environment) props.push(['qatlas.environment', run.environment.name])
  if (run.cases.some((c) => c.execution === 'automated') && run.options.browser) props.push(['qatlas.browser', run.options.browser])

  const time = seconds(run.duration_ms)
  const attrs = `tests="${counts.tests}" failures="${counts.failures}" errors="${counts.errors}" skipped="${counts.skipped}" time="${time}"`
  const suiteName = `${run.target.key} ${run.target.title}`.trim()
  const systemErr = run.error_message ? clean(run.error_message, TEXT_CHARS) : ''
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${xmlAttr(`QAtlas ${run.key}`)}" ${attrs}>`,
    `  <testsuite name="${xmlAttr(suiteName)}" id="${xmlAttr(run.key)}" package="${xmlAttr(run.project_key)}" ${attrs} timestamp="${timestamp(run)}">`,
    '    <properties>',
    ...props.map(([n, v]) => `      <property name="${xmlAttr(n)}" value="${xmlAttr(v)}"/>`),
    '    </properties>',
    ...cases,
    ...(systemErr ? [`    <system-err>${xmlText(systemErr)}</system-err>`] : []),
    '  </testsuite>',
    '</testsuites>',
    '',
  ].join('\n')
}
