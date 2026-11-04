import {
  ArrowLeftRight,
  Ban,
  Braces,
  Camera,
  CircleCheck,
  Eye,
  EyeOff,
  FileCheck,
  Gauge,
  Globe,
  Hand,
  Hash,
  Heading,
  Hourglass,
  Keyboard,
  Link,
  ListChecks,
  MousePointer2,
  MousePointerClick,
  ScanText,
  Square,
  SquareCheck,
  TextCursor,
  TextCursorInput,
  Timer,
  Type,
  Variable,
  type LucideIcon,
} from 'lucide-react'
import { differenceInSeconds, parseISO } from 'date-fns'
import type { Execution, Folder, Priority, Step, StepAction, TestCase, TestCaseInput, TestCaseStatus } from '@/api/types'
import { i18n } from '@/i18n'
import { ACTION_MAP, summarizeStep } from '@/lib/steps'
import { uid } from '@/lib/utils'

/* ------------------------------------------------------------------ folders */

export interface FolderNode {
  folder: Folder
  children: FolderNode[]
  depth: number
  /** Jumlah test case termasuk subfolder (filter folder di API juga menyertakan turunan). */
  total: number
}

export function buildFolderTree(folders: Folder[]) {
  const byId = new Map<string, FolderNode>()
  for (const f of folders) byId.set(f.id, { folder: f, children: [], depth: 0, total: 0 })
  const roots: FolderNode[] = []
  for (const f of folders) {
    const node = byId.get(f.id)!
    const parent = f.parent_id ? byId.get(f.parent_id) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }
  const sort = (arr: FolderNode[]) => arr.sort((a, b) => a.folder.position - b.folder.position || a.folder.name.localeCompare(b.folder.name, 'id'))
  const walk = (n: FolderNode, depth: number): number => {
    n.depth = depth
    sort(n.children)
    n.total = n.folder.test_case_count + n.children.reduce((s, c) => s + walk(c, depth + 1), 0)
    return n.total
  }
  sort(roots)
  roots.forEach((r) => walk(r, 0))
  return { roots, byId }
}

/** Urutan depth-first; jika `expanded` diberikan, anak folder yang tertutup dilewati. */
export function flattenTree(roots: FolderNode[], expanded?: Set<string>): FolderNode[] {
  const out: FolderNode[] = []
  const visit = (n: FolderNode) => {
    out.push(n)
    if (!expanded || expanded.has(n.folder.id)) n.children.forEach(visit)
  }
  roots.forEach(visit)
  return out
}

export function folderPath(byId: Map<string, FolderNode>, id: string | null | undefined): string {
  const parts: string[] = []
  let cur = id ? byId.get(id) : undefined
  while (cur) {
    parts.unshift(cur.folder.name)
    cur = cur.folder.parent_id ? byId.get(cur.folder.parent_id) : undefined
  }
  return parts.join(' / ')
}

export function countDescendantFolders(node: FolderNode): number {
  return node.children.reduce((s, c) => s + 1 + countDescendantFolders(c), 0)
}

/* ------------------------------------------------------------------ draft */

export interface Draft {
  title: string
  description: string
  preconditions: string
  priority: Priority
  status: TestCaseStatus
  execution: Execution
  tags: string[]
  variables: Record<string, string>
  folder_id: string | null
  steps: Step[]
}

export function draftFromCase(tc: TestCase): Draft {
  return {
    title: tc.title,
    description: tc.description ?? '',
    preconditions: tc.preconditions ?? '',
    priority: tc.priority,
    status: tc.status,
    execution: tc.execution,
    tags: [...tc.tags],
    variables: { ...tc.variables },
    folder_id: tc.folder_id,
    steps: structuredClone(tc.steps),
  }
}

export function draftFromInput(input: TestCaseInput, base: Draft): Draft {
  return {
    title: input.title ?? '',
    description: input.description ?? '',
    preconditions: input.preconditions ?? '',
    priority: input.priority ?? base.priority,
    status: input.status ?? base.status,
    execution: input.execution ?? base.execution,
    tags: [...(input.tags ?? [])],
    variables: { ...(input.variables ?? {}) },
    folder_id: base.folder_id,
    steps: structuredClone(input.steps ?? []),
  }
}

export function emptyDraft(execution: Execution, folderId: string | null): Draft {
  return {
    title: '',
    description: '',
    preconditions: '',
    priority: 'medium',
    status: 'draft',
    execution,
    tags: [],
    variables: {},
    folder_id: folderId,
    steps: [],
  }
}

export function draftToInput(d: Draft): TestCaseInput {
  return {
    folder_id: d.folder_id,
    title: d.title.trim(),
    description: d.description,
    preconditions: d.preconditions,
    priority: d.priority,
    status: d.status,
    execution: d.execution,
    tags: d.tags,
    variables: d.variables,
    steps: d.steps,
  }
}

/** JSON.stringify dengan key terurut dan tanpa nilai undefined: dasar deteksi "belum disimpan". */
export function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(
        Object.keys(val)
          .sort()
          .filter((k) => (val as Record<string, unknown>)[k] !== undefined)
          .map((k) => [k, (val as Record<string, unknown>)[k]]),
      )
    }
    return val
  })
}

export function sameDraft(a: Draft, b: Draft): boolean {
  return stableStringify(a) === stableStringify(b)
}

export function newStepId(steps: Step[]): string {
  const ids = new Set(steps.map((s) => s.id))
  let id = uid('s').slice(0, 7)
  while (ids.has(id)) id = uid('s').slice(0, 7)
  return id
}

/** Set satu field step; nilai kosong menghapus key agar JSON tetap bersih. */
export function setStepField(step: Step, name: string, value: unknown): Step {
  const next = { ...step } as Record<string, unknown>
  const empty =
    value === undefined ||
    value === null ||
    (typeof value === 'string' && value === '') ||
    (typeof value === 'number' && Number.isNaN(value)) ||
    (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0)
  if (empty) delete next[name]
  else next[name] = value
  return next as unknown as Step
}

/** Ubah step automated → manual: ringkasan jadi instruksi, expected tetap. */
export function toManualSteps(steps: Step[]): Step[] {
  return steps.map((s) => {
    const m: Step = { id: s.id, action: 'manual', description: s.description?.trim() || summarizeStep(s) }
    if (s.expected) m.expected = s.expected
    if (s.enabled === false) m.enabled = false
    return m
  })
}

/** Langkah manual → teks bernomor (disalin ke deskripsi saat beralih ke automated). */
export function manualStepsAsText(steps: Step[]): string {
  return steps
    .map((s, i) => `${i + 1}. ${s.description ?? ''}${s.expected ? `\n   Expected: ${s.expected}` : ''}`)
    .join('\n')
}

/* ------------------------------------------------------------------ action presentation */

export const ACTION_ICONS: Record<StepAction, LucideIcon> = {
  goto: Globe,
  click: MousePointerClick,
  dblclick: MousePointerClick,
  hover: MousePointer2,
  fill: TextCursorInput,
  type: Keyboard,
  press: Keyboard,
  select_option: ListChecks,
  check: SquareCheck,
  uncheck: Square,
  wait_for: Hourglass,
  wait: Timer,
  screenshot: Camera,
  extract_text: ScanText,
  set_variable: Variable,
  expect_visible: Eye,
  expect_hidden: EyeOff,
  expect_text: Type,
  expect_value: TextCursor,
  expect_url: Link,
  expect_title: Heading,
  expect_count: Hash,
  http_request: ArrowLeftRight,
  expect_status: CircleCheck,
  expect_json: Braces,
  expect_header: FileCheck,
  expect_response_time: Gauge,
  manual: Hand,
}

export function actionIcon(action: StepAction): LucideIcon {
  return ACTION_ICONS[action] ?? Ban
}

/** Alias pencarian (Indonesia + istilah umum) untuk palette action. */
export const ACTION_ALIASES: Partial<Record<StepAction, string[]>> = {
  goto: ['buka', 'navigasi', 'kunjungi', 'url', 'halaman', 'open', 'visit'],
  click: ['klik', 'tekan', 'pencet', 'tombol', 'tap'],
  dblclick: ['klik ganda', 'double', 'dua kali'],
  hover: ['arahkan', 'kursor', 'mouse'],
  fill: ['isi', 'input', 'form', 'masukkan', 'tulis'],
  type: ['ketik', 'tulis', 'keyboard'],
  press: ['tekan', 'tombol', 'enter', 'keyboard', 'key'],
  select_option: ['pilih', 'dropdown', 'opsi', 'select'],
  check: ['centang', 'checkbox', 'radio'],
  uncheck: ['hapus centang', 'checkbox'],
  wait_for: ['tunggu', 'muncul', 'hilang', 'elemen'],
  wait: ['tunggu', 'jeda', 'sleep', 'delay', 'diam'],
  screenshot: ['tangkapan layar', 'foto', 'gambar'],
  extract_text: ['ambil', 'simpan', 'teks', 'baca'],
  set_variable: ['variabel', 'variable', 'simpan', 'set'],
  expect_visible: ['harus', 'terlihat', 'tampil', 'cek', 'pastikan', 'assert'],
  expect_hidden: ['harus', 'tersembunyi', 'hilang', 'cek', 'assert'],
  expect_text: ['harus', 'teks', 'cek', 'pastikan', 'assert'],
  expect_value: ['harus', 'nilai', 'input', 'cek', 'assert'],
  expect_url: ['harus', 'url', 'alamat', 'cek', 'assert'],
  expect_title: ['harus', 'judul', 'title', 'cek', 'assert'],
  expect_count: ['harus', 'jumlah', 'hitung', 'cek', 'assert'],
  http_request: ['api', 'request', 'kirim', 'get', 'post', 'rest', 'endpoint'],
  expect_status: ['status', 'kode', 'api', 'cek', 'assert'],
  expect_json: ['json', 'body', 'respons', 'api', 'cek', 'jsonpath'],
  expect_header: ['header', 'respons', 'api', 'cek'],
  expect_response_time: ['waktu', 'cepat', 'lambat', 'latency', 'performa'],
}

/* ------------------------------------------------------------------ JSON view */

/** Bentuk dokumen di mode JSON (folder tidak ikut karena berupa ID internal). */
export function draftToJsonDoc(d: Draft) {
  return {
    title: d.title,
    description: d.description,
    preconditions: d.preconditions,
    priority: d.priority,
    status: d.status,
    execution: d.execution,
    tags: d.tags,
    variables: d.variables,
    steps: d.steps,
  }
}

export interface JsonIssue {
  path: string
  message: string
  /** offset karakter di teks (untuk lompat & gutter) */
  offset: number
  line: number
}

const PRIORITIES = ['low', 'medium', 'high', 'critical']
const STATUSES = ['draft', 'ready', 'deprecated']
const EXECUTIONS = ['automated', 'manual']

/**
 * Parse teks JSON jadi Draft. `blocking` = sintaks/struktur yang tidak bisa direpresentasikan di form
 * (kembali ke Form diblokir). Error semantik step (field wajib dsb.) tetap lewat validateSteps.
 */
export function parseJsonDoc(text: string, base: Draft): { draft?: Draft; blocking: JsonIssue[] } {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const offset = syntaxOffset(msg, text)
    return { blocking: [{ path: 'JSON', message: i18n.t('testcases:json.invalidSyntax', { message: msg }), offset, line: lineOf(text, offset) }] }
  }
  const issues: { path: string; message: string }[] = []
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
  if (!isObj(raw)) {
    return { blocking: [{ path: '', message: i18n.t('testcases:json.notObject'), offset: 0, line: 1 }] }
  }
  const o = raw
  if (typeof o.title !== 'string') issues.push({ path: 'title', message: i18n.t('testcases:json.mustBeText', { field: 'title' }) })
  for (const k of ['description', 'preconditions'] as const) {
    if (o[k] !== undefined && typeof o[k] !== 'string') issues.push({ path: k, message: i18n.t('testcases:json.mustBeText', { field: k }) })
  }
  if (!PRIORITIES.includes(o.priority as string)) issues.push({ path: 'priority', message: i18n.t('testcases:json.mustBeOneOf', { field: 'priority', options: PRIORITIES.join(', ') }) })
  if (!STATUSES.includes(o.status as string)) issues.push({ path: 'status', message: i18n.t('testcases:json.mustBeOneOf', { field: 'status', options: STATUSES.join(', ') }) })
  if (!EXECUTIONS.includes(o.execution as string)) issues.push({ path: 'execution', message: i18n.t('testcases:json.mustBeOneOf', { field: 'execution', options: EXECUTIONS.join(', ') }) })
  if (o.tags !== undefined && !(Array.isArray(o.tags) && o.tags.every((t) => typeof t === 'string'))) {
    issues.push({ path: 'tags', message: i18n.t('testcases:json.tagsArray') })
  }
  if (o.variables !== undefined && !(isObj(o.variables) && Object.values(o.variables).every((v) => typeof v === 'string'))) {
    issues.push({ path: 'variables', message: i18n.t('testcases:json.variablesObject') })
  }
  if (!Array.isArray(o.steps)) {
    issues.push({ path: 'steps', message: i18n.t('testcases:json.stepsArray') })
  } else {
    o.steps.forEach((s, i) => {
      if (!isObj(s)) issues.push({ path: `steps[${i}]`, message: i18n.t('testcases:json.stepObject') })
      else {
        if (typeof s.id !== 'string') issues.push({ path: `steps[${i}].id`, message: i18n.t('testcases:json.mustBeText', { field: 'id' }) })
        if (typeof s.action !== 'string') issues.push({ path: `steps[${i}].action`, message: i18n.t('testcases:json.actionRequired') })
        else if (!ACTION_MAP[s.action as StepAction]) issues.push({ path: `steps[${i}].action`, message: i18n.t('testcases:json.unknownAction', { action: String(s.action) }) })
      }
    })
  }
  if (issues.length) return { blocking: locateIssues(text, issues) }
  return { draft: draftFromInput(o as unknown as TestCaseInput, base), blocking: [] }
}

export function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) line++
  return line
}

function syntaxOffset(msg: string, text: string): number {
  const pos = /position (\d+)/.exec(msg)
  if (pos) return Math.min(Number(pos[1]), text.length)
  const lc = /line (\d+) column (\d+)/.exec(msg)
  if (lc) {
    const lines = text.split('\n')
    const l = Math.min(Number(lc[1]), lines.length) - 1
    return lines.slice(0, l).reduce((s, x) => s + x.length + 1, 0) + Number(lc[2]) - 1
  }
  return text.length
}

/** Tambahkan offset/baris ke daftar error berdasarkan path (`steps[3].selector`). */
export function locateIssues(text: string, list: { path: string; message: string }[]): JsonIssue[] {
  let map: Map<string, number>
  try {
    map = locateJsonPaths(text)
  } catch {
    map = new Map()
  }
  return list.map((e) => {
    let p = e.path
    let offset = map.get(p)
    while (offset === undefined && p) {
      p = p.replace(/(\.[^.[\]]+|\[\d+\])$/, '')
      if (p === e.path) break
      offset = map.get(p)
    }
    const off = offset ?? 0
    return { ...e, offset: off, line: lineOf(text, off) }
  })
}

/** Peta path → offset karakter untuk JSON yang valid (key untuk properti, awal elemen untuk array). */
export function locateJsonPaths(text: string): Map<string, number> {
  const map = new Map<string, number>()
  let i = 0
  const ws = () => {
    while (i < text.length && /\s/.test(text[i])) i++
  }
  const readString = (): string => {
    const start = i
    i++
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') i++
      i++
    }
    i++
    return JSON.parse(text.slice(start, i)) as string
  }
  const value = (path: string) => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') {
        i++
        return
      }
      while (i < text.length) {
        ws()
        const keyAt = i
        const k = readString()
        const p = path ? `${path}.${k}` : k
        map.set(p, keyAt)
        ws()
        i++ // :
        value(p)
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        i++ // }
        return
      }
    } else if (c === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      let idx = 0
      while (i < text.length) {
        ws()
        const p = `${path}[${idx}]`
        map.set(p, i)
        value(p)
        ws()
        idx++
        if (text[i] === ',') {
          i++
          continue
        }
        i++ // ]
        return
      }
    } else if (c === '"') {
      readString()
    } else {
      while (i < text.length && !/[,}\]\s]/.test(text[i])) i++
    }
  }
  value('')
  return map
}

/* ------------------------------------------------------------------ revision diff */

export interface FieldChange {
  name: string
  before: unknown
  after: unknown
}

export type StepDiff =
  | { kind: 'same' | 'moved'; id: string; step: Step; from: number; to: number }
  | { kind: 'changed'; id: string; step: Step; before: Step; from: number; to: number; fields: FieldChange[] }
  | { kind: 'added'; id: string; step: Step; to: number }
  | { kind: 'removed'; id: string; step: Step; from: number }

function fieldChanges(a: Record<string, unknown>, b: Record<string, unknown>): FieldChange[] {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== 'id')
  return keys
    .filter((k) => stableStringify(a[k]) !== stableStringify(b[k]))
    .map((k) => ({ name: k, before: a[k], after: b[k] }))
}

/** Diff step berdasarkan `id` stabil: before = revisi lama, after = versi sekarang. */
export function diffSteps(before: Step[], after: Step[]): StepDiff[] {
  const oldIdx = new Map(before.map((s, i) => [s.id, i]))
  const newIds = new Set(after.map((s) => s.id))
  const out: StepDiff[] = []
  after.forEach((s, to) => {
    const from = oldIdx.get(s.id)
    if (from === undefined) {
      out.push({ kind: 'added', id: s.id, step: s, to })
      return
    }
    const prev = before[from]
    const fields = fieldChanges(prev as unknown as Record<string, unknown>, s as unknown as Record<string, unknown>)
    if (fields.length) out.push({ kind: 'changed', id: s.id, step: s, before: prev, from, to, fields })
    else out.push({ kind: from === to ? 'same' : 'moved', id: s.id, step: s, from, to })
  })
  // sisipkan step yang dihapus setelah tetangga lamanya
  before.forEach((s, from) => {
    if (newIds.has(s.id)) return
    let insertAt = 0
    for (let j = from - 1; j >= 0; j--) {
      const k = out.findIndex((d) => d.id === before[j].id)
      if (k >= 0) {
        insertAt = k + 1
        break
      }
    }
    out.splice(insertAt, 0, { kind: 'removed', id: s.id, step: s, from })
  })
  return out
}

const META_FIELDS = ['title', 'description', 'preconditions', 'priority', 'status', 'execution', 'tags', 'variables'] as const

export function diffMeta(before: TestCaseInput, after: Draft): { label: string; before: string; after: string }[] {
  const b = before as unknown as Record<string, unknown>
  const a = after as unknown as Record<string, unknown>
  const show = (v: unknown) => (v === undefined || v === '' ? '—' : typeof v === 'string' ? v : stableStringify(v))
  return META_FIELDS
    .filter((k) => stableStringify(b[k] ?? (k === 'tags' ? [] : k === 'variables' ? {} : '')) !== stableStringify(a[k] ?? ''))
    .map((k) => ({ label: i18n.t(`testcases:fields.${k}`), before: show(b[k]), after: show(a[k]) }))
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
export const MOD_LABEL = isMac ? '⌘' : 'Ctrl'

/** True bila fokus ada di field teks (shortcut satu huruf tidak boleh aktif). */
export function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable) return true
  const tag = t.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (t as HTMLInputElement).type
    return !['checkbox', 'radio', 'button', 'submit', 'reset'].includes(type)
  }
  return !!t.closest('.cm-editor')
}


/** Waktu relatif ringkas untuk kolom padat ("7h" / "7j"); waktu lengkap ada di `title`. */
export function shortRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const sec = Math.abs(differenceInSeconds(Date.now(), parseISO(iso)))
  if (sec < 45) return i18n.t('testcases:time.justNow')
  if (sec < 60) return i18n.t('testcases:time.seconds', { count: sec })
  const min = Math.round(sec / 60)
  if (min < 60) return i18n.t('testcases:time.minutes', { count: min })
  const hours = Math.round(sec / 3600)
  if (hours < 24) return i18n.t('testcases:time.hours', { count: hours })
  const days = Math.round(sec / 86400)
  if (days < 30) return i18n.t('testcases:time.days', { count: days })
  const months = Math.round(days / 30)
  if (months < 12) return i18n.t('testcases:time.months', { count: months })
  return i18n.t('testcases:time.years', { count: Math.round(days / 365) })
}
