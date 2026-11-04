import type { Execution, FieldError, Step, StepAction } from '@/api/types'
import type { Language } from '@/i18n'
import { lazyLabels, tr, translatorFor, type Translate } from '@/lib/i18n-labels'

/**
 * Katalog action Step DSL (docs/04-test-definition.md).
 * Dipakai oleh step editor (form dinamis), validasi, ringkasan human-readable, dan mock runner.
 * Phase 2: katalog ini menjadi sumber `step-dsl.schema.json`.
 *
 * i18n: semua copy ada di namespace `steps`. Bentuk API tetap (label/description/help/placeholder = string)
 * karena dibaca lewat getter yang memanggil i18n.t → selalu bahasa aktif. `summarizeStep` dan
 * `validateSteps` menerima `{ lng }` opsional untuk memaksa bahasa (mock API = English).
 */

export type ParamType = 'text' | 'selector' | 'url' | 'number' | 'select' | 'textarea' | 'keyvalue' | 'boolean' | 'int-list'

export interface ParamDef {
  name: keyof Step & string
  label: string
  type: ParamType
  required?: boolean
  placeholder?: string
  help?: string
  options?: { value: string; label: string }[]
}

export type ActionGroup = 'navigation' | 'interaction' | 'wait' | 'data' | 'assert_ui' | 'http' | 'assert_http' | 'common' | 'manual'
export type ActionKind = 'ui' | 'http' | 'common' | 'manual'

export interface ActionDef {
  action: StepAction
  label: string
  group: ActionGroup
  kind: ActionKind
  description: string
  params: ParamDef[]
  summary: (s: Step) => string
}

const GROUPS: readonly ActionGroup[] = ['navigation', 'interaction', 'wait', 'data', 'assert_ui', 'http', 'assert_http', 'common', 'manual']

/** Label grup (diterjemahkan saat dibaca — mengikuti bahasa aktif). */
export const GROUP_LABELS: Record<ActionGroup, string> = lazyLabels(GROUPS, (g) => `steps:groups.${g}`)

/* ------------------------------------------------------------------ param factory
 * Label/placeholder/help adalah getter yang memanggil i18n.t, jadi `param.label` tetap string
 * tetapi selalu dalam bahasa aktif. Kunci label disimpan terpisah agar validasi bisa
 * menerjemahkan ke bahasa tertentu (mock API = English).
 */

const PARAM_LABEL_KEY = new WeakMap<ParamDef, string>()

interface ParamExtra {
  required?: boolean
  /** Placeholder literal (contoh kode, sama di semua bahasa). */
  placeholder?: string
  /** Placeholder yang diterjemahkan: kunci di `steps:placeholders.*`. */
  placeholderKey?: string
  /** Kunci di `steps:help.*`. */
  helpKey?: string
  options?: { value: string; label: string }[]
}

function param(name: ParamDef['name'], labelKey: string, type: ParamType, extra: ParamExtra = {}): ParamDef {
  const def = {
    name,
    type,
    get label() {
      return tr(`steps:params.${labelKey}`)
    },
  } as ParamDef
  if (extra.required) def.required = true
  if (extra.placeholder !== undefined) def.placeholder = extra.placeholder
  if (extra.placeholderKey) Object.defineProperty(def, 'placeholder', { enumerable: true, get: () => tr(`steps:placeholders.${extra.placeholderKey}`) })
  if (extra.helpKey) Object.defineProperty(def, 'help', { enumerable: true, get: () => tr(`steps:help.${extra.helpKey}`) })
  if (extra.options) def.options = extra.options
  PARAM_LABEL_KEY.set(def, labelKey)
  return def
}

/** Opsi select dengan label terjemahan. */
const translatedOption = (value: string, key: string) => ({
  value,
  get label() {
    return tr(key)
  },
})
const literalOptions = (values: string[]) => values.map((v) => ({ value: v, label: v }))

const MATCH_OPTIONS = (['equals', 'contains', 'regex'] as const).map((m) => translatedOption(m, `steps:match.${m}`))

const sel = (required = true) => param('selector', 'selector', 'selector', { required, placeholderKey: 'selector', helpKey: 'selector' })
const val = (labelKey = 'value', required = true) => param('value', labelKey, 'text', { required })
const match = () => param('match', 'operator', 'select', { options: MATCH_OPTIONS })

const q = (s: unknown) => `"${String(s ?? '')}"`
const matchWord = (m?: string) => (m === 'equals' ? '=' : m === 'regex' ? '~' : '⊃')
const countOp = (op?: string) => (op === 'gte' ? '≥' : op === 'lte' ? '≤' : '=')

/* ------------------------------------------------------------------ action factory */

type SummaryImpl = (s: Step, t: Translate) => string
const SUMMARY_IMPL = new Map<StepAction, SummaryImpl>()

function action(a: StepAction, group: ActionGroup, kind: ActionKind, params: ParamDef[], summary: SummaryImpl): ActionDef {
  SUMMARY_IMPL.set(a, summary)
  return {
    action: a,
    group,
    kind,
    params,
    get label() {
      return tr(`steps:actions.${a}.label`)
    },
    get description() {
      return tr(`steps:actions.${a}.description`)
    },
    summary: (s) => summary(s, tr),
  }
}

/** Ringkasan standar `steps:actions.<a>.summary` dengan nilai interpolasi. */
const sum =
  (a: StepAction, values: (s: Step) => Record<string, unknown>): SummaryImpl =>
  (s, t) =>
    t(`steps:actions.${a}.summary`, values(s))
const onSel = (s: Step) => ({ selector: s.selector ?? '' })

export const ACTIONS: ActionDef[] = [
  // Navigasi
  action('goto', 'navigation', 'ui', [param('url', 'url', 'url', { required: true, placeholder: '{{env.BASE_URL}}/login' })], sum('goto', (s) => ({ url: s.url ?? '' }))),
  // Interaksi
  action('click', 'interaction', 'ui', [sel()], sum('click', onSel)),
  action('dblclick', 'interaction', 'ui', [sel()], sum('dblclick', onSel)),
  action('hover', 'interaction', 'ui', [sel()], sum('hover', onSel)),
  action('fill', 'interaction', 'ui', [sel(), val('value')], sum('fill', (s) => ({ selector: s.selector ?? '', value: q(s.value) }))),
  action('type', 'interaction', 'ui', [sel(), val('text'), param('delay_ms', 'delayMs', 'number')],
    sum('type', (s) => ({ selector: s.selector ?? '', value: q(s.value) }))),
  action('press', 'interaction', 'ui', [param('key', 'key', 'text', { required: true, placeholderKey: 'key' }), sel(false)],
    (s, t) => (s.selector ? t('steps:actions.press.summaryOn', { key: s.key ?? '', selector: s.selector }) : t('steps:actions.press.summary', { key: s.key ?? '' }))),
  action('select_option', 'interaction', 'ui', [sel(), val('value', false), param('label', 'optionLabel', 'text')],
    sum('select_option', (s) => ({ selector: s.selector ?? '', value: q(s.label ?? s.value) }))),
  action('check', 'interaction', 'ui', [sel()], sum('check', onSel)),
  action('uncheck', 'interaction', 'ui', [sel()], sum('uncheck', onSel)),
  // Tunggu
  action('wait_for', 'wait', 'ui', [sel(), param('state', 'state', 'select', { options: literalOptions(['visible', 'hidden', 'attached']) })],
    sum('wait_for', (s) => ({ selector: s.selector ?? '', state: s.state ?? 'visible' }))),
  action('wait', 'wait', 'common', [param('ms', 'durationMs', 'number', { required: true })], sum('wait', (s) => ({ ms: s.ms ?? 0 }))),
  // Data
  action('screenshot', 'data', 'ui', [param('name', 'name', 'text'), param('full_page', 'fullPage', 'boolean')],
    (s, t) => (s.name ? t('steps:actions.screenshot.summaryNamed', { name: q(s.name) }) : t('steps:actions.screenshot.summary'))),
  action('extract_text', 'data', 'ui', [sel(), param('save_as', 'saveAs', 'text', { required: true, placeholder: 'order_id' })],
    sum('extract_text', (s) => ({ selector: s.selector ?? '', saveAs: s.save_as ?? '' }))),
  action('set_variable', 'data', 'common', [param('name', 'name', 'text', { required: true }), val('value')], (s) => `vars.${s.name ?? ''} = ${q(s.value)}`),
  // Assertion UI
  action('expect_visible', 'assert_ui', 'ui', [sel()], sum('expect_visible', onSel)),
  action('expect_hidden', 'assert_ui', 'ui', [sel()], sum('expect_hidden', onSel)),
  action('expect_text', 'assert_ui', 'ui', [sel(), val('text'), match()],
    sum('expect_text', (s) => ({ selector: s.selector ?? '', op: matchWord(s.match), value: q(s.value) }))),
  action('expect_value', 'assert_ui', 'ui', [sel(), val('value'), match()],
    sum('expect_value', (s) => ({ selector: s.selector ?? '', op: matchWord(s.match), value: q(s.value) }))),
  action('expect_url', 'assert_ui', 'ui', [val('url'), match()], sum('expect_url', (s) => ({ op: matchWord(s.match), value: q(s.value) }))),
  action('expect_title', 'assert_ui', 'ui', [val('title'), match()], sum('expect_title', (s) => ({ op: matchWord(s.match), value: q(s.value) }))),
  action('expect_count', 'assert_ui', 'ui',
    [sel(), param('op', 'operator', 'select', { options: [{ value: 'eq', label: '=' }, { value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }] }),
      param('value', 'count', 'number', { required: true })],
    sum('expect_count', (s) => ({ selector: s.selector ?? '', op: countOp(s.op), value: s.value ?? '' }))),
  // HTTP
  action('http_request', 'http', 'http',
    [
      param('method', 'method', 'select', { required: true, options: literalOptions(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) }),
      param('url', 'url', 'url', { required: true, placeholder: '{{env.API_URL}}/products' }),
      param('headers', 'headers', 'keyvalue'),
      param('query', 'query', 'keyvalue'),
      param('body_type', 'bodyType', 'select', { options: (['json', 'text', 'form'] as const).map((b) => translatedOption(b, `steps:bodyTypes.${b}`)) }),
      param('body', 'body', 'textarea'),
      param('save', 'saveVars', 'keyvalue', { helpKey: 'saveVars' }),
    ],
    (s) => `${s.method ?? 'GET'} ${s.url ?? ''}`),
  action('expect_status', 'assert_http', 'http', [param('value', 'status', 'number', { required: true, placeholder: '200' })], (s) => `Status = ${s.value ?? ''}`),
  action('expect_json', 'assert_http', 'http',
    [
      param('path', 'jsonPath', 'text', { required: true, placeholder: '$.data.id' }),
      param('op', 'operator', 'select', { required: true, options: literalOptions(['eq', 'neq', 'contains', 'exists', 'gt', 'lt', 'matches']) }),
      val('value', false),
    ],
    (s) => `${s.path ?? ''} ${s.op ?? 'eq'}${s.op === 'exists' ? '' : ` ${q(s.value)}`}`),
  action('expect_header', 'assert_http', 'http', [param('name', 'headerName', 'text', { required: true }), val('value'), match()],
    (s) => `Header ${s.name ?? ''} ${matchWord(s.match)} ${q(s.value)}`),
  action('expect_response_time', 'assert_http', 'http', [param('max_ms', 'maxMs', 'number', { required: true })],
    sum('expect_response_time', (s) => ({ ms: s.max_ms ?? '' }))),
  // Manual
  action('manual', 'manual', 'manual', [], (s, t) => s.description || t('steps:actions.manual.summary')),
]

export const ACTION_MAP = Object.fromEntries(ACTIONS.map((a) => [a.action, a])) as Record<StepAction, ActionDef>

export function getAction(action: StepAction): ActionDef {
  return ACTION_MAP[action]
}

export interface I18nOptions {
  /** Paksa bahasa tertentu; default = bahasa aktif UI. */
  lng?: Language
}

export function summarizeStep(step: Step, opts?: I18nOptions): string {
  const impl = SUMMARY_IMPL.get(step.action)
  return impl ? impl(step, translatorFor(opts?.lng)) : step.action
}

export function isUiStep(step: Step): boolean {
  return ACTION_MAP[step.action]?.kind === 'ui'
}

export function newStep(action: StepAction, id: string): Step {
  const step: Step = { id, action }
  if (action === 'http_request') {
    step.method = 'GET'
    step.body_type = 'json'
  }
  if (action === 'expect_text' || action === 'expect_value' || action === 'expect_url' || action === 'expect_title' || action === 'expect_header') {
    step.match = 'contains'
  }
  if (action === 'expect_count') step.op = 'eq'
  if (action === 'expect_json') step.op = 'eq'
  if (action === 'wait_for') step.state = 'visible'
  return step
}

function isEmpty(v: unknown): boolean {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

export interface StepValidation {
  errors: FieldError[]
  warnings: FieldError[]
}

/** Validasi struktur + semantik (docs/04 §Validasi). Dipakai editor (bahasa aktif) dan mock endpoint /validate (`{ lng: 'en' }`). */
export function validateSteps(steps: Step[], execution: Execution = 'automated', opts?: I18nOptions): StepValidation {
  const t = translatorFor(opts?.lng)
  const errors: FieldError[] = []
  const warnings: FieldError[] = []
  const seen = new Set<string>()

  if (steps.length === 0) {
    warnings.push({ path: 'steps', message: t('steps:validation.noSteps') })
  }

  steps.forEach((step, i) => {
    const p = `steps[${i}]`
    if (!step.id) errors.push({ path: `${p}.id`, message: t('steps:validation.idRequired') })
    else if (seen.has(step.id)) errors.push({ path: `${p}.id`, message: t('steps:validation.idDuplicate', { id: step.id }) })
    seen.add(step.id)

    const def = ACTION_MAP[step.action]
    if (!def) {
      errors.push({ path: `${p}.action`, message: t('steps:validation.unknownAction', { action: step.action }) })
      return
    }
    if (execution === 'manual' && step.action !== 'manual') {
      errors.push({ path: `${p}.action`, message: t('steps:validation.manualOnly') })
    }
    if (execution === 'automated' && step.action === 'manual') {
      errors.push({ path: `${p}.action`, message: t('steps:validation.noManualInAutomated') })
    }
    if (step.action === 'manual' && isEmpty(step.description)) {
      errors.push({ path: `${p}.description`, message: t('steps:validation.manualInstructionRequired') })
    }
    for (const param of def.params) {
      if (param.required && isEmpty(step[param.name])) {
        const label = t(`steps:params.${PARAM_LABEL_KEY.get(param) ?? param.name}`)
        errors.push({ path: `${p}.${param.name}`, message: t('steps:validation.paramRequired', { label }) })
      }
    }
    if (step.action === 'wait') {
      const ms = Number(step.ms ?? 0)
      if (ms > 30000) errors.push({ path: `${p}.ms`, message: t('steps:validation.waitMax') })
      else warnings.push({ path: `${p}.action`, message: t('steps:validation.waitWarning', { waitFor: t('steps:actions.wait_for.label') }) })
    }
    if (step.action === 'expect_text' && step.match === 'regex' && typeof step.value === 'string') {
      try {
        new RegExp(step.value)
      } catch {
        errors.push({ path: `${p}.value`, message: t('steps:validation.invalidRegex') })
      }
    }
    const httpAssert = def.group === 'assert_http'
    if (httpAssert && !steps.slice(0, i).some((s) => s.action === 'http_request')) {
      errors.push({ path: `${p}.action`, message: t('steps:validation.httpAssertNeedsRequest', { httpRequest: t('steps:actions.http_request.label') }) })
    }
    if (typeof step.selector === 'string' && /^\s*\/\//.test(step.selector)) {
      warnings.push({ path: `${p}.selector`, message: t('steps:validation.xpath') })
    }
  })

  return { errors, warnings }
}

/** Index error per step berdasarkan path `steps[i].field`. */
export function errorsByStep(errors: FieldError[]): Map<number, FieldError[]> {
  const map = new Map<number, FieldError[]>()
  for (const e of errors) {
    const m = /^steps\[(\d+)\]/.exec(e.path)
    if (!m) continue
    const idx = Number(m[1])
    map.set(idx, [...(map.get(idx) ?? []), e])
  }
  return map
}
