import type { FieldError, GoogleAuthSettings, GoogleAuthSettingsInput } from '@/api/types'

/**
 * Logika Admin → Google sign-in tanpa React: pre-check file JSON OAuth client, domain, draft ↔ API,
 * dan pemetaan error 422. Pesan dikembalikan sebagai kode; komponen menerjemahkannya (namespace `googleAuth`).
 *
 * Isi file (termasuk client_secret) hanya disimpan di memori untuk dikirim saat Simpan; tidak pernah dirender.
 */

/** File client Google ~0.5 kB; batas ini hanya menolak file yang jelas salah sebelum dibaca. */
export const MAX_CLIENT_JSON_BYTES = 64 * 1024

export type ClientJsonError =
  | 'empty'
  | 'tooLarge'
  | 'notJson'
  | 'desktop'
  | 'serviceAccount'
  | 'notOAuthClient'
  | 'missingClientId'
  | 'missingSecret'

export interface ClientJsonInfo {
  clientId: string
  projectId: string | null
  redirectUris: string[]
  javascriptOrigins: string[]
}

export type ClientJsonCheck = { ok: true; info: ClientJsonInfo } | { ok: false; error: ClientJsonError }

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : [])
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * Pre-check file dari Google Cloud Console → Credentials → OAuth client → Download JSON.
 * Hanya client tipe *Web application* (`{"web": {...}}`) yang bisa dipakai untuk redirect ke QAtlas.
 */
export function checkClientJson(text: string): ClientJsonCheck {
  if (!text.trim()) return { ok: false, error: 'empty' }
  if (new Blob([text]).size > MAX_CLIENT_JSON_BYTES) return { ok: false, error: 'tooLarge' }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, error: 'notJson' }
  }
  if (!isObject(parsed)) return { ok: false, error: 'notOAuthClient' }
  if (parsed.type === 'service_account') return { ok: false, error: 'serviceAccount' }
  if (!isObject(parsed.web)) return { ok: false, error: isObject(parsed.installed) ? 'desktop' : 'notOAuthClient' }
  const web = parsed.web
  const clientId = str(web.client_id)
  if (!clientId) return { ok: false, error: 'missingClientId' }
  if (!str(web.client_secret)) return { ok: false, error: 'missingSecret' }
  return {
    ok: true,
    info: {
      clientId,
      projectId: str(web.project_id),
      redirectUris: strList(web.redirect_uris),
      javascriptOrigins: strList(web.javascript_origins),
    },
  }
}

/** Google membandingkan redirect URI persis (skema, host, port, path); hanya slash di ujung yang dimaafkan di sini. */
export function sameUri(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\/+$/, '')
  return norm(a) === norm(b)
}

/** Client ID panjang → `123456789012-abcd…` untuk ringkasan satu baris (ID lengkap ada di Status). */
export function shortClientId(id: string): string {
  const head = id.replace(/\.apps\.googleusercontent\.com$/, '')
  return head.length <= 18 ? head : `${head.slice(0, 17)}…`
}

/** Titik potong baris yang wajar untuk client ID: sebelum `.apps.googleusercontent.com`. */
export function splitClientId(id: string): [string, string] {
  const i = id.indexOf('.apps.')
  return i > 0 ? [id.slice(0, i), id.slice(i)] : [id, '']
}

/* ------------------------------------------------------------------ domains */

export type DomainError = 'email' | 'invalid'

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** `@Tokoku.ID ` → `tokoku.id`. */
export function normalizeDomain(raw: string): string {
  return raw.trim().toLowerCase().replace(/^@+/, '').replace(/\.+$/, '')
}

export function validateDomain(raw: string): DomainError | undefined {
  const v = normalizeDomain(raw)
  if (v.includes('@')) return 'email'
  if (!DOMAIN_RE.test(v)) return 'invalid'
  return undefined
}

/** Pisahkan isi input/tempelan (koma, spasi, titik koma, baris baru) menjadi kandidat domain. */
export function splitDomains(raw: string): string[] {
  return raw.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)
}

/* ------------------------------------------------------------------ draft */

export interface StagedFile {
  name: string
  /** Isi mentah yang dikirim sebagai `client_json`. Jangan dirender. */
  text: string
  info: ClientJsonInfo
}

export interface GoogleDraft {
  enabled: boolean
  domains: string[]
  /** File baru yang sudah lolos pre-check; null = pakai kredensial tersimpan. */
  file: StagedFile | null
  /** Kredensial sudah ada dan admin membuka "Ganti dengan file JSON baru". */
  replacing: boolean
}

export function draftFromSettings(s: GoogleAuthSettings): GoogleDraft {
  return { enabled: s.enabled, domains: [...s.allowed_domains], file: null, replacing: false }
}

/** Kredensial wajib diunggah bila belum ada di server (contract: `client_json` wajib pertama kali). */
export function credentialsRequired(s: GoogleAuthSettings): boolean {
  return !s.client_secret_set
}

export type DraftError = 'credentialsRequired'

export function validateDraft(d: GoogleDraft, s: GoogleAuthSettings): { credentials?: DraftError } {
  if (credentialsRequired(s) && !d.file) return { credentials: 'credentialsRequired' }
  return {}
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export function isDirty(d: GoogleDraft, s: GoogleAuthSettings): boolean {
  return d.enabled !== s.enabled || !sameList(d.domains, s.allowed_domains) || d.file !== null
}

/** Body PUT. `client_json` dihilangkan bila tidak ada file baru → server memakai kredensial tersimpan. */
export function toInput(d: GoogleDraft): GoogleAuthSettingsInput {
  const input: GoogleAuthSettingsInput = { enabled: d.enabled, allowed_domains: d.domains }
  if (d.file) input.client_json = d.file.text
  return input
}

/**
 * Peta `details` dari 422: `client_json` → kredensial, `allowed_domains[i]` → chip ke-i,
 * `allowed_domains` (tanpa indeks) → field domain. Path lain dikembalikan di `other` agar tetap tampil.
 */
export function mapServerDetails(details: FieldError[]): {
  credentials?: string
  domains: Record<number, string>
  domainsField?: string
  other: FieldError[]
} {
  const out: ReturnType<typeof mapServerDetails> = { domains: {}, other: [] }
  for (const d of details) {
    if (d.path === 'client_json' || d.path.startsWith('client_json.')) {
      out.credentials ??= d.message
      continue
    }
    const idx = /^allowed_domains\[(\d+)\]$/.exec(d.path)
    if (idx) {
      out.domains[Number(idx[1])] ??= d.message
      continue
    }
    if (d.path === 'allowed_domains') {
      out.domainsField ??= d.message
      continue
    }
    out.other.push(d)
  }
  return out
}

/** Konfigurasi tersimpan berubah dari luar (admin lain, env)? Dipakai untuk menyinkronkan draft yang belum diedit. */
export function configSignature(s: GoogleAuthSettings): string {
  return JSON.stringify([s.enabled, s.source, s.env_override, s.client_id, s.client_secret_set, s.allowed_domains, s.updated_at])
}
