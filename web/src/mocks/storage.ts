import type { FieldError, StorageSettings, StorageSettingsInput, StorageTestResult } from '@/api/types'
import { db, ENV_STORAGE, nowIso, storageState, userRef, type DbStorage } from './db'

/**
 * Simulasi Admin → Storage (mock saja). Aturan:
 * - endpoint mengandung `fail` → cek connect gagal (host tidak ditemukan)
 * - secret `wrong` → cek bucket gagal (AccessDenied / signature salah)
 * - bucket mengandung `missing` → NoSuchBucket
 * - bucket mengandung `quota` → pemindahan artifact berhenti di ~60% (kuota penuh)
 * Pemindahan berjalan berdasarkan waktu sejak dimulai, dihitung ulang tiap GET (tahan reload).
 */

type Backend = 'local' | 's3'
type Check = StorageTestResult['checks'][number]

const QUEUED_MS = 700

function artifactsOn(backend: Backend) {
  return db().artifacts.filter((a) => !a.expired && (a.storage ?? 'local') === backend)
}

function effectiveConfig(st: DbStorage) {
  if (st.env_override) return { backend: ENV_STORAGE.backend, s3: { ...ENV_STORAGE.s3, secret_set: true, secret_updated_at: null } }
  const { secret, ...s3 } = st.s3
  return { backend: st.backend, s3: { ...s3, secret_set: secret !== null } }
}

/** Majukan migrasi sesuai waktu: pindahkan artifact bertahap dan selesaikan/gagalkan bila waktunya. */
export function tickMigration(now = Date.now()) {
  const m = storageState().migration
  if (!m || m.status === 'done' || m.status === 'failed') return
  const elapsed = now - Date.parse(m.started_at)
  if (elapsed < QUEUED_MS) return
  m.status = 'running'
  const duration = Math.min(6000, Math.max(3000, m.total * 25))
  const frac = Math.min(1, (elapsed - QUEUED_MS) / duration)
  let target = Math.floor(frac * m.total)
  if (m.fail_at !== null && target >= m.fail_at) target = m.fail_at
  if (target > m.moved) {
    const batch = artifactsOn(m.from).slice(0, target - m.moved)
    for (const a of batch) a.storage = m.to
    m.moved += batch.length
    m.copied = m.moved
  }
  if (m.fail_at !== null && m.moved >= m.fail_at) {
    m.status = 'failed'
    m.failed = 1
    m.error = `s3: QuotaExceeded: bucket ${storageState().s3.bucket} has reached its quota (put ${m.from}→${m.to} aborted)`
    m.finished_at = nowIso()
  } else if (frac >= 1) {
    m.status = 'done'
    m.finished_at = nowIso()
  }
}

export function toStorageSettings(): StorageSettings {
  tickMigration()
  const st = storageState()
  const cfg = effectiveConfig(st)
  const local = artifactsOn('local')
  const s3 = artifactsOn('s3')
  const sum = (xs: { size_bytes: number }[]) => xs.reduce((n, a) => n + a.size_bytes, 0)
  const m = st.migration
  return {
    active_backend: cfg.backend,
    source: st.env_override ? 'env' : st.source,
    env_override: st.env_override,
    s3: cfg.s3,
    artifacts: { local: local.length, s3: s3.length, bytes_local: sum(local), bytes_s3: sum(s3) },
    migration: m
      ? { status: m.status, from: m.from, to: m.to, total: m.total, copied: m.copied, failed: m.failed, started_at: m.started_at, finished_at: m.finished_at, error: m.error }
      : null,
    updated_at: st.env_override ? null : st.updated_at,
    updated_by: st.env_override || !st.updated_by ? null : userRef(st.updated_by),
  }
}

/** Validasi bentuk input (sebelum probe). */
export function validateStorageInput(input: StorageSettingsInput, hasStoredSecret: boolean): FieldError[] {
  if (input.backend !== 'local' && input.backend !== 's3') return [{ path: 'backend', message: 'Must be local or s3' }]
  if (input.backend === 'local') return []
  const s3 = input.s3
  if (!s3) return [{ path: 's3', message: 'S3 settings are required for backend s3' }]
  const errors: FieldError[] = []
  let url: URL | null = null
  try {
    url = new URL(s3.endpoint ?? '')
  } catch {
    errors.push({ path: 's3.endpoint', message: 'Must be an absolute http(s) URL' })
  }
  if (url && (url.pathname !== '/' || url.search)) errors.push({ path: 's3.endpoint', message: 'Must not contain a path; the bucket is configured separately' })
  if (!s3.bucket?.trim()) errors.push({ path: 's3.bucket', message: 'Required' })
  if (!s3.access_key_id?.trim()) errors.push({ path: 's3.access_key_id', message: 'Required' })
  if (!s3.secret_access_key && !hasStoredSecret) errors.push({ path: 's3.secret_access_key', message: 'Required the first time' })
  return errors
}

function rand(min: number, max: number) {
  return Math.round(min + Math.random() * (max - min))
}

/** Probe tanpa menyimpan. Secret yang dihilangkan = yang tersimpan. */
export function probeStorage(input: StorageSettingsInput, storedSecret: string | null): StorageTestResult {
  if (input.backend === 'local') {
    const checks: Check[] = [
      { name: 'write', ok: true, message: 'Wrote artifacts/.qatlas-probe-7c1e (24 B)' },
      { name: 'read', ok: true, message: 'Read 24 B back, content matches' },
      { name: 'delete', ok: true, message: 'Probe file removed' },
    ]
    return { ok: true, message: 'Local disk is writable', latency_ms: rand(2, 6), checks }
  }
  const s3 = input.s3!
  const host = (() => {
    try {
      return new URL(s3.endpoint).host
    } catch {
      return s3.endpoint
    }
  })()
  const secret = s3.secret_access_key ?? storedSecret
  const checks: Check[] = []
  const latency = rand(90, 220)
  const stop = (message: string): StorageTestResult => ({ ok: false, message, latency_ms: latency, checks })

  if (s3.endpoint.includes('fail')) {
    checks.push({ name: 'connect', ok: false, message: `dial tcp: lookup ${host}: no such host` })
    return stop(`Couldn't reach ${host}`)
  }
  checks.push({ name: 'connect', ok: true, message: `${host} answered over ${s3.endpoint.startsWith('https') ? 'TLS' : 'HTTP'}` })
  if (!secret) {
    checks.push({ name: 'bucket', ok: false, message: 'No secret access key: enter one' })
    return stop('Secret access key is missing')
  }
  if (secret === 'wrong') {
    checks.push({ name: 'bucket', ok: false, message: 'AccessDenied: Forbidden: Invalid signature (check the secret access key)' })
    return stop('The bucket refused the credentials')
  }
  if (s3.bucket.includes('missing')) {
    checks.push({ name: 'bucket', ok: false, message: `NoSuchBucket: Bucket not found: ${s3.bucket}` })
    return stop(`Bucket ${s3.bucket} does not exist`)
  }
  const key = `${s3.prefix ?? ''}.qatlas-probe-${Math.random().toString(16).slice(2, 6)}`
  checks.push(
    { name: 'bucket', ok: true, message: `${s3.bucket} exists (${s3.force_path_style === false ? 'virtual-hosted' : 'path-style'})` },
    { name: 'write', ok: true, message: `PUT ${key} (24 B)` },
    { name: 'read', ok: true, message: 'GET returned 24 B, ETag matches' },
    { name: 'delete', ok: true, message: `DELETE ${key}` },
  )
  return { ok: true, message: 'All checks passed', latency_ms: latency, checks }
}

/** Detail 422 untuk probe yang gagal: hasil cek + field yang paling mungkin salah. */
export function probeFailureDetails(result: StorageTestResult): FieldError[] {
  const details: FieldError[] = result.checks.filter((c) => !c.ok).map((c) => ({ path: `checks.${c.name}`, message: c.message }))
  const failed = result.checks.find((c) => !c.ok)
  if (failed?.name === 'connect') details.push({ path: 's3.endpoint', message: 'Host not found' })
  if (failed?.message.startsWith('AccessDenied')) details.push({ path: 's3.secret_access_key', message: 'Rejected by the bucket (invalid signature)' })
  if (failed?.message.startsWith('NoSuchBucket')) details.push({ path: 's3.bucket', message: 'Bucket does not exist' })
  return details
}

export function saveStorage(input: StorageSettingsInput, userId: string) {
  const st = storageState()
  st.backend = input.backend
  if (input.backend === 's3' && input.s3) {
    const s3 = input.s3
    st.s3 = {
      endpoint: s3.endpoint.replace(/\/+$/, ''),
      region: s3.region || 'us-east-1',
      bucket: s3.bucket,
      access_key_id: s3.access_key_id,
      prefix: s3.prefix ?? '',
      force_path_style: s3.force_path_style ?? true,
      secret: s3.secret_access_key ?? st.s3.secret,
      secret_updated_at: s3.secret_access_key ? nowIso() : st.s3.secret_updated_at,
    }
  }
  st.source = 'database'
  st.updated_at = nowIso()
  st.updated_by = userId
}

/** Mulai menyalin artifact dari backend lain ke backend aktif. null = sudah ada yang berjalan. */
export function startMigration(deleteSource: boolean): boolean {
  tickMigration()
  const st = storageState()
  if (st.migration && (st.migration.status === 'queued' || st.migration.status === 'running')) return false
  const to = effectiveConfig(st).backend
  const from: Backend = to === 'local' ? 's3' : 'local'
  const total = artifactsOn(from).length
  const quota = to === 's3' && effectiveConfig(st).s3.bucket.includes('quota')
  st.migration = {
    status: total === 0 ? 'done' : 'queued',
    from,
    to,
    total,
    copied: 0,
    failed: 0,
    moved: 0,
    started_at: nowIso(),
    finished_at: total === 0 ? nowIso() : null,
    error: null,
    delete_source: deleteSource,
    fail_at: quota ? Math.max(1, Math.floor(total * 0.6)) : null,
  }
  return true
}

/** Dev toolbar: simulasi QATLAS_STORAGE di environment server. */
export function setStorageEnvOverride(on: boolean) {
  storageState().env_override = on
}
