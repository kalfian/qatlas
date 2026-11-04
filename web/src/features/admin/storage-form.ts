import type { FieldError, StorageBackend, StorageCheck, StorageSettings, StorageSettingsInput } from '@/api/types'

/**
 * Logika form Admin → Storage tanpa React: draft ↔ API, validasi, dirty check, dan pemetaan error 422.
 * Pesan validasi dikembalikan sebagai kode; komponen menerjemahkannya (namespace `storage`).
 */

export type CheckName = StorageCheck['name']
export const CHECK_ORDER: readonly CheckName[] = ['connect', 'bucket', 'write', 'read', 'delete']
export const DEFAULT_REGION = 'us-east-1'

export interface StorageDraft {
  backend: StorageBackend
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  prefix: string
  forcePathStyle: boolean
  /** Hanya nilai yang sedang diketik; nilai tersimpan tidak pernah dikirim balik oleh server. */
  secret: string
  /** Secret sudah ada dan admin membuka input "Ganti secret". */
  replacingSecret: boolean
}

export type DraftField = 'endpoint' | 'region' | 'bucket' | 'accessKeyId' | 'secret' | 'prefix'
/** Urutan field di layar, dipakai untuk memfokus error pertama. */
export const FIELD_ORDER: readonly DraftField[] = ['endpoint', 'region', 'bucket', 'accessKeyId', 'secret', 'prefix']

export type ValidationCode =
  | 'required'
  | 'missingScheme'
  | 'invalidUrl'
  | 'protocol'
  | 'hasPath'
  | 'bucketFormat'
  | 'prefixSlash'

export type DraftErrors = Partial<Record<DraftField, ValidationCode>>

export function draftFromSettings(s: StorageSettings): StorageDraft {
  const configured = s.s3.endpoint !== ''
  return {
    backend: s.active_backend,
    endpoint: s.s3.endpoint,
    region: s.s3.region || DEFAULT_REGION,
    bucket: s.s3.bucket,
    accessKeyId: s.s3.access_key_id,
    prefix: s.s3.prefix,
    // belum pernah dikonfigurasi → default contract (true); Garage/MinIO/SeaweedFS butuh path-style
    forcePathStyle: configured ? s.s3.force_path_style : true,
    secret: '',
    replacingSecret: false,
  }
}

/** Secret wajib dikirim bila belum ada di server, atau admin sedang menggantinya. */
export function secretRequired(d: StorageDraft, secretSet: boolean): boolean {
  return !secretSet || d.replacingSecret
}

export function normalizeEndpoint(v: string): string {
  return v.trim().replace(/\/+$/, '')
}

export function normalizePrefix(v: string): string {
  return v.trim()
}

/** Endpoint = origin saja (skema + host + port opsional), tanpa path/query. */
export function validateEndpoint(raw: string): ValidationCode | undefined {
  const v = raw.trim()
  if (!v) return 'required'
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return 'missingScheme'
  let url: URL
  try {
    url = new URL(v)
  } catch {
    return 'invalidUrl'
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'protocol'
  if (!url.hostname) return 'invalidUrl'
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return 'hasPath'
  return undefined
}

/** Aturan nama bucket S3 (3–63 karakter, huruf kecil/angka/titik/strip, diawali & diakhiri huruf/angka). */
const BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/

export function validateDraft(d: StorageDraft, secretSet: boolean): DraftErrors {
  if (d.backend !== 's3') return {}
  const e: DraftErrors = {}
  const endpoint = validateEndpoint(d.endpoint)
  if (endpoint) e.endpoint = endpoint
  if (!d.region.trim()) e.region = 'required'
  const bucket = d.bucket.trim()
  if (!bucket) e.bucket = 'required'
  else if (!BUCKET_RE.test(bucket) || bucket.includes('..')) e.bucket = 'bucketFormat'
  if (!d.accessKeyId.trim()) e.accessKeyId = 'required'
  if (secretRequired(d, secretSet) && !d.secret) e.secret = 'required'
  if (normalizePrefix(d.prefix).startsWith('/')) e.prefix = 'prefixSlash'
  return e
}

export function firstError(errors: Partial<Record<DraftField, unknown>>): DraftField | undefined {
  return FIELD_ORDER.find((f) => errors[f])
}

/** Body PUT/test. Secret dihilangkan bila tidak sedang diisi → server memakai yang tersimpan. */
export function toInput(d: StorageDraft, secretSet: boolean): StorageSettingsInput {
  if (d.backend === 'local') return { backend: 'local' }
  const s3: NonNullable<StorageSettingsInput['s3']> = {
    endpoint: normalizeEndpoint(d.endpoint),
    region: d.region.trim(),
    bucket: d.bucket.trim(),
    access_key_id: d.accessKeyId.trim(),
    prefix: normalizePrefix(d.prefix),
    force_path_style: d.forcePathStyle,
  }
  if (secretRequired(d, secretSet) && d.secret) s3.secret_access_key = d.secret
  return { backend: 's3', s3 }
}

/** Ada perubahan dibanding konfigurasi tersimpan? (Membuka "Ganti secret" tanpa mengetik bukan perubahan.) */
export function isDirty(d: StorageDraft, s: StorageSettings): boolean {
  if (d.backend !== s.active_backend) return true
  if (d.backend === 'local') return false
  const base = draftFromSettings(s)
  return (
    normalizeEndpoint(d.endpoint) !== normalizeEndpoint(base.endpoint) ||
    d.region.trim() !== base.region.trim() ||
    d.bucket.trim() !== base.bucket.trim() ||
    d.accessKeyId.trim() !== base.accessKeyId.trim() ||
    normalizePrefix(d.prefix) !== normalizePrefix(base.prefix) ||
    d.forcePathStyle !== base.forcePathStyle ||
    d.secret !== ''
  )
}

/** Tanda tangan input yang diuji; hasil test basi bila draft berubah setelahnya. */
export function inputSignature(input: StorageSettingsInput): string {
  return JSON.stringify(input)
}

const FIELD_PATHS: Record<string, DraftField> = {
  endpoint: 'endpoint',
  region: 'region',
  bucket: 'bucket',
  access_key_id: 'accessKeyId',
  secret_access_key: 'secret',
  prefix: 'prefix',
}

/**
 * Peta `details` dari 422 PUT: `s3.<field>` → error field, `checks.<name>` → hasil cek yang gagal.
 * Path lain dikembalikan di `other` agar tetap tampil.
 */
export function mapServerDetails(details: FieldError[]): {
  fields: Partial<Record<DraftField, string>>
  checks: Partial<Record<CheckName, string>>
  other: FieldError[]
} {
  const fields: Partial<Record<DraftField, string>> = {}
  const checks: Partial<Record<CheckName, string>> = {}
  const other: FieldError[] = []
  for (const d of details) {
    const check = /^checks\.(connect|bucket|write|read|delete)$/.exec(d.path)
    if (check) {
      const name = check[1] as CheckName
      checks[name] ??= d.message
      continue
    }
    const field = FIELD_PATHS[d.path.replace(/^s3\./, '')]
    if (field) {
      fields[field] ??= d.message
      continue
    }
    other.push(d)
  }
  return { fields, checks, other }
}

/** Urutkan hasil cek sesuai alur probe; cek yang tidak dijalankan (probe berhenti lebih awal) = null. */
export function orderedChecks(checks: StorageCheck[], backend: StorageBackend): { name: CheckName; check: StorageCheck | null }[] {
  const byName = new Map(checks.map((c) => [c.name, c]))
  // Disk lokal tidak punya endpoint/bucket: tampilkan hanya cek yang relevan kecuali server mengirimnya.
  const names = backend === 'local' ? CHECK_ORDER.filter((n) => byName.has(n) || (n !== 'connect' && n !== 'bucket')) : CHECK_ORDER
  return names.map((name) => ({ name, check: byName.get(name) ?? null }))
}

/** Host endpoint untuk ringkasan status (tanpa skema). */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).host
  } catch {
    return endpoint
  }
}
