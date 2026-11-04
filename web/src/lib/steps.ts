import type { Execution, FieldError, Step, StepAction } from '@/api/types'

/**
 * Katalog action Step DSL (docs/04-test-definition.md).
 * Dipakai oleh step editor (form dinamis), validasi, ringkasan human-readable, dan mock runner.
 * Phase 2: katalog ini menjadi sumber `step-dsl.schema.json`.
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

export const GROUP_LABELS: Record<ActionGroup, string> = {
  navigation: 'Navigasi',
  interaction: 'Interaksi',
  wait: 'Tunggu',
  data: 'Data & variable',
  assert_ui: 'Assertion UI',
  http: 'HTTP',
  assert_http: 'Assertion HTTP',
  common: 'Umum',
  manual: 'Manual',
}

const MATCH_OPTIONS = [
  { value: 'equals', label: 'sama dengan' },
  { value: 'contains', label: 'mengandung' },
  { value: 'regex', label: 'cocok regex' },
]

const sel: ParamDef = {
  name: 'selector',
  label: 'Selector',
  type: 'selector',
  required: true,
  placeholder: "role=button[name='Masuk']",
  help: 'Utamakan role=, label=, testid= daripada CSS.',
}
const val = (label = 'Nilai', required = true): ParamDef => ({ name: 'value', label, type: 'text', required })
const match: ParamDef = { name: 'match', label: 'Cara cocok', type: 'select', options: MATCH_OPTIONS }

const q = (s: unknown) => `"${String(s ?? '')}"`
const matchWord = (m?: string) => (m === 'equals' ? '=' : m === 'regex' ? '~' : '⊃')

export const ACTIONS: ActionDef[] = [
  // Navigasi
  { action: 'goto', label: 'Buka URL', group: 'navigation', kind: 'ui', description: 'Membuka halaman.',
    params: [{ name: 'url', label: 'URL', type: 'url', required: true, placeholder: '{{env.BASE_URL}}/login' }],
    summary: (s) => `Buka ${s.url ?? ''}` },
  // Interaksi
  { action: 'click', label: 'Klik', group: 'interaction', kind: 'ui', description: 'Klik elemen.', params: [sel],
    summary: (s) => `Klik ${s.selector ?? ''}` },
  { action: 'dblclick', label: 'Klik ganda', group: 'interaction', kind: 'ui', description: 'Double click elemen.', params: [sel],
    summary: (s) => `Klik ganda ${s.selector ?? ''}` },
  { action: 'hover', label: 'Hover', group: 'interaction', kind: 'ui', description: 'Arahkan kursor ke elemen.', params: [sel],
    summary: (s) => `Hover ${s.selector ?? ''}` },
  { action: 'fill', label: 'Isi input', group: 'interaction', kind: 'ui', description: 'Kosongkan lalu isi input.',
    params: [sel, val('Nilai')], summary: (s) => `Isi ${s.selector ?? ''} dengan ${q(s.value)}` },
  { action: 'type', label: 'Ketik', group: 'interaction', kind: 'ui', description: 'Ketik per karakter.',
    params: [sel, val('Teks'), { name: 'delay_ms', label: 'Jeda antar karakter (ms)', type: 'number' }],
    summary: (s) => `Ketik ${q(s.value)} di ${s.selector ?? ''}` },
  { action: 'press', label: 'Tekan tombol', group: 'interaction', kind: 'ui', description: 'Tekan tombol keyboard.',
    params: [{ name: 'key', label: 'Tombol', type: 'text', required: true, placeholder: 'Enter' }, { ...sel, required: false }],
    summary: (s) => `Tekan ${s.key ?? ''}${s.selector ? ` di ${s.selector}` : ''}` },
  { action: 'select_option', label: 'Pilih opsi', group: 'interaction', kind: 'ui', description: 'Pilih opsi pada <select>.',
    params: [sel, val('Value', false), { name: 'label', label: 'Label opsi', type: 'text' }],
    summary: (s) => `Pilih ${q(s.label ?? s.value)} di ${s.selector ?? ''}` },
  { action: 'check', label: 'Centang', group: 'interaction', kind: 'ui', description: 'Centang checkbox/radio.', params: [sel],
    summary: (s) => `Centang ${s.selector ?? ''}` },
  { action: 'uncheck', label: 'Hapus centang', group: 'interaction', kind: 'ui', description: 'Hapus centang checkbox.', params: [sel],
    summary: (s) => `Hapus centang ${s.selector ?? ''}` },
  // Tunggu
  { action: 'wait_for', label: 'Tunggu elemen', group: 'wait', kind: 'ui', description: 'Tunggu elemen mencapai state tertentu.',
    params: [sel, { name: 'state', label: 'State', type: 'select', options: [
      { value: 'visible', label: 'visible' }, { value: 'hidden', label: 'hidden' }, { value: 'attached', label: 'attached' }] }],
    summary: (s) => `Tunggu ${s.selector ?? ''} ${s.state ?? 'visible'}` },
  { action: 'wait', label: 'Jeda (ms)', group: 'wait', kind: 'common', description: 'Jeda tetap. Hindari bila bisa; maks 30000 ms.',
    params: [{ name: 'ms', label: 'Durasi (ms)', type: 'number', required: true }],
    summary: (s) => `Jeda ${s.ms ?? 0} ms` },
  // Data
  { action: 'screenshot', label: 'Screenshot', group: 'data', kind: 'ui', description: 'Ambil screenshot eksplisit.',
    params: [{ name: 'name', label: 'Nama', type: 'text' }, { name: 'full_page', label: 'Satu halaman penuh', type: 'boolean' }],
    summary: (s) => `Screenshot${s.name ? ` ${q(s.name)}` : ''}` },
  { action: 'extract_text', label: 'Ambil teks', group: 'data', kind: 'ui', description: 'Simpan teks elemen ke variable.',
    params: [sel, { name: 'save_as', label: 'Simpan sebagai', type: 'text', required: true, placeholder: 'order_id' }],
    summary: (s) => `Ambil teks ${s.selector ?? ''} → vars.${s.save_as ?? ''}` },
  { action: 'set_variable', label: 'Set variable', group: 'data', kind: 'common', description: 'Set nilai variable runtime.',
    params: [{ name: 'name', label: 'Nama', type: 'text', required: true }, val('Nilai')],
    summary: (s) => `vars.${s.name ?? ''} = ${q(s.value)}` },
  // Assertion UI
  { action: 'expect_visible', label: 'Harus terlihat', group: 'assert_ui', kind: 'ui', description: 'Elemen harus terlihat.', params: [sel],
    summary: (s) => `${s.selector ?? ''} terlihat` },
  { action: 'expect_hidden', label: 'Harus tersembunyi', group: 'assert_ui', kind: 'ui', description: 'Elemen harus tidak terlihat.', params: [sel],
    summary: (s) => `${s.selector ?? ''} tersembunyi` },
  { action: 'expect_text', label: 'Teks elemen', group: 'assert_ui', kind: 'ui', description: 'Cek teks elemen.',
    params: [sel, val('Teks'), match], summary: (s) => `Teks ${s.selector ?? ''} ${matchWord(s.match)} ${q(s.value)}` },
  { action: 'expect_value', label: 'Nilai input', group: 'assert_ui', kind: 'ui', description: 'Cek nilai input.',
    params: [sel, val('Nilai'), match], summary: (s) => `Nilai ${s.selector ?? ''} ${matchWord(s.match)} ${q(s.value)}` },
  { action: 'expect_url', label: 'URL halaman', group: 'assert_ui', kind: 'ui', description: 'Cek URL halaman.',
    params: [val('URL'), match], summary: (s) => `URL ${matchWord(s.match)} ${q(s.value)}` },
  { action: 'expect_title', label: 'Judul halaman', group: 'assert_ui', kind: 'ui', description: 'Cek <title> halaman.',
    params: [val('Judul'), match], summary: (s) => `Judul ${matchWord(s.match)} ${q(s.value)}` },
  { action: 'expect_count', label: 'Jumlah elemen', group: 'assert_ui', kind: 'ui', description: 'Cek jumlah elemen.',
    params: [sel, { name: 'op', label: 'Operator', type: 'select', options: [
      { value: 'eq', label: '=' }, { value: 'gte', label: '≥' }, { value: 'lte', label: '≤' }] }, { name: 'value', label: 'Jumlah', type: 'number', required: true }],
    summary: (s) => `Jumlah ${s.selector ?? ''} ${s.op === 'gte' ? '≥' : s.op === 'lte' ? '≤' : '='} ${s.value ?? ''}` },
  // HTTP
  { action: 'http_request', label: 'HTTP request', group: 'http', kind: 'http', description: 'Kirim request HTTP (Playwright APIRequestContext).',
    params: [
      { name: 'method', label: 'Method', type: 'select', required: true, options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map((m) => ({ value: m, label: m })) },
      { name: 'url', label: 'URL', type: 'url', required: true, placeholder: '{{env.API_URL}}/products' },
      { name: 'headers', label: 'Headers', type: 'keyvalue' },
      { name: 'query', label: 'Query', type: 'keyvalue' },
      { name: 'body_type', label: 'Tipe body', type: 'select', options: [
        { value: 'json', label: 'JSON' }, { value: 'text', label: 'Text' }, { value: 'form', label: 'Form' }] },
      { name: 'body', label: 'Body', type: 'textarea' },
      { name: 'save', label: 'Simpan ke variable (nama → JSONPath)', type: 'keyvalue', help: 'Contoh: token → $.data.token' },
    ],
    summary: (s) => `${s.method ?? 'GET'} ${s.url ?? ''}` },
  { action: 'expect_status', label: 'Status code', group: 'assert_http', kind: 'http', description: 'Cek status response terakhir.',
    params: [{ name: 'value', label: 'Status', type: 'number', required: true, placeholder: '200' }],
    summary: (s) => `Status = ${s.value ?? ''}` },
  { action: 'expect_json', label: 'Isi JSON', group: 'assert_http', kind: 'http', description: 'Cek nilai JSONPath di body response.',
    params: [
      { name: 'path', label: 'JSONPath', type: 'text', required: true, placeholder: '$.data.id' },
      { name: 'op', label: 'Operator', type: 'select', required: true, options: ['eq', 'neq', 'contains', 'exists', 'gt', 'lt', 'matches'].map((o) => ({ value: o, label: o })) },
      val('Nilai', false),
    ],
    summary: (s) => `${s.path ?? ''} ${s.op ?? 'eq'}${s.op === 'exists' ? '' : ` ${q(s.value)}`}` },
  { action: 'expect_header', label: 'Header', group: 'assert_http', kind: 'http', description: 'Cek header response.',
    params: [{ name: 'name', label: 'Nama header', type: 'text', required: true }, val('Nilai'), match],
    summary: (s) => `Header ${s.name ?? ''} ${matchWord(s.match)} ${q(s.value)}` },
  { action: 'expect_response_time', label: 'Waktu respons', group: 'assert_http', kind: 'http', description: 'Waktu respons maksimum.',
    params: [{ name: 'max_ms', label: 'Maks (ms)', type: 'number', required: true }],
    summary: (s) => `Waktu respons ≤ ${s.max_ms ?? ''} ms` },
  // Manual
  { action: 'manual', label: 'Langkah manual', group: 'manual', kind: 'manual', description: 'Instruksi untuk tester. Isi deskripsi & hasil yang diharapkan.',
    params: [], summary: (s) => s.description || 'Langkah manual' },
]

export const ACTION_MAP = Object.fromEntries(ACTIONS.map((a) => [a.action, a])) as Record<StepAction, ActionDef>

export function getAction(action: StepAction): ActionDef {
  return ACTION_MAP[action]
}

export function summarizeStep(step: Step): string {
  const def = ACTION_MAP[step.action]
  return def ? def.summary(step) : step.action
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

/** Validasi struktur + semantik (docs/04 §Validasi). Dipakai editor dan mock endpoint /validate. */
export function validateSteps(steps: Step[], execution: Execution = 'automated'): StepValidation {
  const errors: FieldError[] = []
  const warnings: FieldError[] = []
  const seen = new Set<string>()

  if (steps.length === 0) {
    warnings.push({ path: 'steps', message: 'Test case belum punya step' })
  }

  steps.forEach((step, i) => {
    const p = `steps[${i}]`
    if (!step.id) errors.push({ path: `${p}.id`, message: 'ID step wajib diisi' })
    else if (seen.has(step.id)) errors.push({ path: `${p}.id`, message: `ID step "${step.id}" duplikat` })
    seen.add(step.id)

    const def = ACTION_MAP[step.action]
    if (!def) {
      errors.push({ path: `${p}.action`, message: `Action "${step.action}" tidak dikenal` })
      return
    }
    if (execution === 'manual' && step.action !== 'manual') {
      errors.push({ path: `${p}.action`, message: 'Test case manual hanya boleh berisi langkah manual' })
    }
    if (execution === 'automated' && step.action === 'manual') {
      errors.push({ path: `${p}.action`, message: 'Langkah manual tidak boleh ada di test case automated' })
    }
    if (step.action === 'manual' && isEmpty(step.description)) {
      errors.push({ path: `${p}.description`, message: 'Instruksi langkah manual wajib diisi' })
    }
    for (const param of def.params) {
      if (param.required && isEmpty(step[param.name])) {
        errors.push({ path: `${p}.${param.name}`, message: `${param.label} wajib diisi` })
      }
    }
    if (step.action === 'wait') {
      const ms = Number(step.ms ?? 0)
      if (ms > 30000) errors.push({ path: `${p}.ms`, message: 'Jeda maksimum 30000 ms' })
      else warnings.push({ path: `${p}.action`, message: 'Jeda tetap membuat test lambat & rapuh; pertimbangkan "Tunggu elemen"' })
    }
    if (step.action === 'expect_text' && step.match === 'regex' && typeof step.value === 'string') {
      try {
        new RegExp(step.value)
      } catch {
        errors.push({ path: `${p}.value`, message: 'Regex tidak valid' })
      }
    }
    const httpAssert = def.group === 'assert_http'
    if (httpAssert && !steps.slice(0, i).some((s) => s.action === 'http_request')) {
      errors.push({ path: `${p}.action`, message: 'Assertion HTTP butuh step "HTTP request" sebelumnya' })
    }
    if (typeof step.selector === 'string' && /^\s*\/\//.test(step.selector)) {
      warnings.push({ path: `${p}.selector`, message: 'XPath rapuh; gunakan role=, label= atau testid=' })
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
