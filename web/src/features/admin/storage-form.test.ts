import { describe, expect, it } from 'vitest'
import type { StorageSettings } from '@/api/types'
import {
  draftFromSettings,
  firstError,
  inputSignature,
  isDirty,
  mapServerDetails,
  orderedChecks,
  toInput,
  validateDraft,
  validateEndpoint,
  type StorageDraft,
} from './storage-form'

const LOCAL_DEFAULT: StorageSettings = {
  active_backend: 'local',
  source: 'default',
  env_override: false,
  s3: { endpoint: '', region: '', bucket: '', access_key_id: '', prefix: '', force_path_style: false, secret_set: false, secret_updated_at: null },
  artifacts: { local: 12, s3: 0, bytes_local: 1024, bytes_s3: 0 },
  migration: null,
  updated_at: null,
  updated_by: null,
}

const GARAGE: StorageSettings = {
  ...LOCAL_DEFAULT,
  active_backend: 's3',
  source: 'database',
  s3: {
    endpoint: 'https://garage.kalfian.work',
    region: 'garage',
    bucket: 'qatlas-artifacts',
    access_key_id: 'GK31c2f218a2e44f485b94239e',
    prefix: '',
    force_path_style: true,
    secret_set: true,
    secret_updated_at: '2026-11-01T08:00:00Z',
  },
}

function s3Draft(patch: Partial<StorageDraft> = {}): StorageDraft {
  return { ...draftFromSettings(GARAGE), ...patch }
}

describe('validateEndpoint', () => {
  it('menerima origin http(s), dengan atau tanpa port / slash akhir', () => {
    expect(validateEndpoint('https://garage.kalfian.work')).toBeUndefined()
    expect(validateEndpoint('https://garage.kalfian.work/')).toBeUndefined()
    expect(validateEndpoint('http://10.0.0.5:3900')).toBeUndefined()
  })
  it('menolak kosong, tanpa skema, skema lain, dan URL ber-path/query', () => {
    expect(validateEndpoint('  ')).toBe('required')
    expect(validateEndpoint('garage.kalfian.work')).toBe('missingScheme')
    expect(validateEndpoint('ftp://garage.kalfian.work')).toBe('protocol')
    expect(validateEndpoint('https://garage.kalfian.work/qatlas-artifacts')).toBe('hasPath')
    expect(validateEndpoint('https://garage.kalfian.work?x=1')).toBe('hasPath')
    expect(validateEndpoint('https://')).toBe('invalidUrl')
  })
})

describe('validateDraft', () => {
  it('backend local tidak punya field wajib', () => {
    expect(validateDraft({ ...draftFromSettings(LOCAL_DEFAULT), endpoint: 'x' }, false)).toEqual({})
  })
  it('S3 pertama kali: semua field wajib termasuk secret, urut sesuai layar', () => {
    const d: StorageDraft = { ...draftFromSettings(LOCAL_DEFAULT), backend: 's3', region: '' }
    const e = validateDraft(d, false)
    expect(e).toEqual({ endpoint: 'required', region: 'required', bucket: 'required', accessKeyId: 'required', secret: 'required' })
    expect(firstError(e)).toBe('endpoint')
  })
  it('secret tersimpan tidak perlu diketik ulang, kecuali sedang diganti', () => {
    expect(validateDraft(s3Draft(), true)).toEqual({})
    expect(validateDraft(s3Draft({ replacingSecret: true }), true)).toEqual({ secret: 'required' })
    expect(validateDraft(s3Draft({ replacingSecret: true, secret: 'baru' }), true)).toEqual({})
  })
  it('nama bucket dan prefix mengikuti aturan S3', () => {
    expect(validateDraft(s3Draft({ bucket: 'Qatlas_Artifacts' }), true).bucket).toBe('bucketFormat')
    expect(validateDraft(s3Draft({ bucket: 'ab' }), true).bucket).toBe('bucketFormat')
    expect(validateDraft(s3Draft({ bucket: 'a..b' }), true).bucket).toBe('bucketFormat')
    expect(validateDraft(s3Draft({ prefix: '/qatlas' }), true).prefix).toBe('prefixSlash')
    expect(validateDraft(s3Draft({ prefix: 'qatlas/prod/' }), true).prefix).toBeUndefined()
  })
})

describe('toInput', () => {
  it('local hanya mengirim backend', () => {
    expect(toInput(draftFromSettings(LOCAL_DEFAULT), false)).toEqual({ backend: 'local' })
  })
  it('menghilangkan secret bila tidak diganti (server memakai yang tersimpan)', () => {
    const input = toInput(s3Draft({ endpoint: 'https://garage.kalfian.work/ ', secret: 'tidak-terkirim' }), true)
    expect(input.s3).toEqual({
      endpoint: 'https://garage.kalfian.work',
      region: 'garage',
      bucket: 'qatlas-artifacts',
      access_key_id: 'GK31c2f218a2e44f485b94239e',
      prefix: '',
      force_path_style: true,
    })
  })
  it('mengirim secret saat pertama kali atau saat diganti', () => {
    expect(toInput(s3Draft({ secret: 's3cr3t' }), false).s3?.secret_access_key).toBe('s3cr3t')
    expect(toInput(s3Draft({ replacingSecret: true, secret: 'baru' }), true).s3?.secret_access_key).toBe('baru')
  })
  it('signature berubah bila input berubah', () => {
    expect(inputSignature(toInput(s3Draft(), true))).not.toBe(inputSignature(toInput(s3Draft({ bucket: 'lain' }), true)))
  })
})

describe('draftFromSettings / isDirty', () => {
  it('default pertama kali: region us-east-1 dan path-style aktif', () => {
    const d = draftFromSettings(LOCAL_DEFAULT)
    expect(d.region).toBe('us-east-1')
    expect(d.forcePathStyle).toBe(true)
    expect(isDirty(d, LOCAL_DEFAULT)).toBe(false)
  })
  it('ganti backend = dirty; mengisi S3 lalu kembali ke local = tidak dirty', () => {
    const d = draftFromSettings(LOCAL_DEFAULT)
    expect(isDirty({ ...d, backend: 's3' }, LOCAL_DEFAULT)).toBe(true)
    expect(isDirty({ ...d, endpoint: 'https://x.example' }, LOCAL_DEFAULT)).toBe(false)
  })
  it('membuka "ganti secret" tanpa mengetik bukan perubahan; slash akhir diabaikan', () => {
    expect(isDirty(s3Draft({ replacingSecret: true }), GARAGE)).toBe(false)
    expect(isDirty(s3Draft({ replacingSecret: true, secret: 'x' }), GARAGE)).toBe(true)
    expect(isDirty(s3Draft({ endpoint: 'https://garage.kalfian.work/' }), GARAGE)).toBe(false)
    expect(isDirty(s3Draft({ forcePathStyle: false }), GARAGE)).toBe(true)
  })
})

describe('mapServerDetails', () => {
  it('memisahkan error field, hasil cek, dan sisanya', () => {
    const out = mapServerDetails([
      { path: 'checks.bucket', message: 'AccessDenied' },
      { path: 's3.secret_access_key', message: 'Rejected' },
      { path: 'access_key_id', message: 'Unknown key' },
      { path: 'backend', message: 'Invalid' },
    ])
    expect(out.checks).toEqual({ bucket: 'AccessDenied' })
    expect(out.fields).toEqual({ secret: 'Rejected', accessKeyId: 'Unknown key' })
    expect(out.other).toEqual([{ path: 'backend', message: 'Invalid' }])
  })
})

describe('orderedChecks', () => {
  it('S3: lima cek dalam urutan probe, yang tidak dijalankan = null', () => {
    const rows = orderedChecks([{ name: 'bucket', ok: false, message: 'x' }, { name: 'connect', ok: true, message: 'ok' }], 's3')
    expect(rows.map((r) => r.name)).toEqual(['connect', 'bucket', 'write', 'read', 'delete'])
    expect(rows[2].check).toBeNull()
  })
  it('local: tanpa connect/bucket kecuali server mengirimnya', () => {
    expect(orderedChecks([{ name: 'write', ok: true, message: '' }], 'local').map((r) => r.name)).toEqual(['write', 'read', 'delete'])
  })
})
