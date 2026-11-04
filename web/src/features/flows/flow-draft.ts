import type { Flow, FlowInput, FlowItem } from '@/api/types'
import { uid } from '@/lib/utils'

/** Ringkasan test case yang ikut di item flow (bentuk sama dengan FlowItem.test_case). */
export type FlowCaseRef = FlowItem['test_case']

export interface DraftItem {
  /** id lokal, stabil selama sesi edit (dipakai dnd-kit & key React). */
  uid: string
  test_case: FlowCaseRef
  continue_on_failure: boolean
  enabled: boolean
}

export interface DraftVariable {
  uid: string
  key: string
  value: string
}

export interface FlowDraft {
  name: string
  description: string
  tags: string[]
  shared_session: boolean
  stop_on_failure: boolean
  variables: DraftVariable[]
  items: DraftItem[]
}

export function emptyDraft(): FlowDraft {
  return { name: '', description: '', tags: [], shared_session: false, stop_on_failure: true, variables: [], items: [] }
}

export function draftFromFlow(f: Flow): FlowDraft {
  return {
    name: f.name,
    description: f.description,
    tags: [...f.tags],
    shared_session: f.shared_session,
    stop_on_failure: f.stop_on_failure,
    variables: Object.entries(f.variables).map(([key, value]) => ({ uid: uid('v'), key, value })),
    items: f.items.map((i) => ({ uid: uid('i'), test_case: i.test_case, continue_on_failure: i.continue_on_failure, enabled: i.enabled })),
  }
}

export function newDraftItem(tc: FlowCaseRef): DraftItem {
  return { uid: uid('i'), test_case: tc, continue_on_failure: false, enabled: true }
}

export function newDraftVariable(): DraftVariable {
  return { uid: uid('v'), key: '', value: '' }
}

/** Baris variable yang key dan value-nya kosong diabaikan (baris baru yang belum diisi). */
function filledVariables(d: FlowDraft) {
  return d.variables.filter((v) => v.key.trim() !== '' || v.value !== '')
}

export function draftToInput(d: FlowDraft): FlowInput {
  return {
    name: d.name.trim(),
    description: d.description.trim(),
    tags: d.tags,
    shared_session: d.shared_session,
    stop_on_failure: d.stop_on_failure,
    variables: Object.fromEntries(filledVariables(d).map((v) => [v.key.trim(), v.value])),
    items: d.items.map((i) => ({ test_case_id: i.test_case.id, continue_on_failure: i.continue_on_failure, enabled: i.enabled })),
  }
}

/** Bentuk pembanding untuk indikator "belum disimpan" (urutan variable ikut dihitung). */
export function draftSignature(d: FlowDraft): string {
  const input = draftToInput(d)
  return JSON.stringify({ ...input, variables: filledVariables(d).map((v) => [v.key.trim(), v.value]) })
}

/* ------------------------------------------------------------------ validasi (cermin dari API) */

export interface DraftIssues {
  name?: string
  /** Pesan level daftar (flow kosong). */
  items?: string
  /** Error per item, berdasarkan uid. Memblokir simpan. */
  itemErrors: Record<string, string>
  /** Peringatan per item (draft/deprecated). Tidak memblokir. */
  itemWarnings: Record<string, string>
  /** Error per baris variable, berdasarkan uid. */
  variableErrors: Record<string, string>
  /** Jumlah error yang memblokir simpan. */
  blocking: number
}

const VAR_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateDraft(d: FlowDraft): DraftIssues {
  const issues: DraftIssues = { itemErrors: {}, itemWarnings: {}, variableErrors: {}, blocking: 0 }
  if (!d.name.trim()) issues.name = 'Nama flow wajib diisi.'
  if (d.items.length === 0) issues.items = 'Flow minimal berisi 1 test case.'
  for (const it of d.items) {
    if (d.shared_session && it.test_case.execution === 'manual') {
      issues.itemErrors[it.uid] = 'Test case manual tidak boleh ada di flow dengan shared session. Matikan Shared session atau hapus item ini.'
    }
    if (it.test_case.status === 'draft') issues.itemWarnings[it.uid] = 'Masih Draft, mungkin belum stabil untuk dijalankan.'
    if (it.test_case.status === 'deprecated') issues.itemWarnings[it.uid] = 'Sudah Deprecated, pertimbangkan untuk menggantinya.'
  }
  const seen = new Set<string>()
  for (const v of filledVariables(d)) {
    const k = v.key.trim()
    if (!k) issues.variableErrors[v.uid] = 'Nama variable wajib diisi.'
    else if (!VAR_KEY.test(k)) issues.variableErrors[v.uid] = 'Pakai huruf, angka, dan _ saja, tidak diawali angka.'
    else if (seen.has(k)) issues.variableErrors[v.uid] = `Nama "${k}" sudah dipakai.`
    seen.add(k)
  }
  issues.blocking =
    (issues.name ? 1 : 0) + (issues.items ? 1 : 0) + Object.keys(issues.itemErrors).length + Object.keys(issues.variableErrors).length
  return issues
}

/** `items[3]` → 3 */
export function itemIndexFromPath(path: string): number | null {
  const m = /^items\[(\d+)\]/.exec(path)
  return m ? Number(m[1]) : null
}
