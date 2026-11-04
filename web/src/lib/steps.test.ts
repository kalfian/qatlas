import { afterEach, describe, expect, it } from 'vitest'
import type { Step } from '@/api/types'
import { setLanguage, type Language } from '@/i18n'
import { ACTIONS, GROUP_LABELS, errorsByStep, newStep, summarizeStep, validateSteps } from './steps'

describe('validateSteps', () => {
  it('menerima test case automated yang valid', () => {
    const steps: Step[] = [
      { id: 'a', action: 'goto', url: '{{env.BASE_URL}}/login' },
      { id: 'b', action: 'click', selector: "role=button[name='Masuk']" },
      { id: 'c', action: 'expect_url', value: '/akun', match: 'contains' },
    ]
    expect(validateSteps(steps, 'automated').errors).toEqual([])
  })

  it('menolak param wajib kosong, id duplikat, dan wait > 30 detik', () => {
    const steps: Step[] = [
      { id: 'a', action: 'click' },
      { id: 'a', action: 'wait', ms: 45000 },
    ]
    const { errors } = validateSteps(steps, 'automated')
    expect(errors.map((e) => e.path)).toEqual(expect.arrayContaining(['steps[0].selector', 'steps[1].id', 'steps[1].ms']))
  })

  it('assertion HTTP butuh http_request sebelumnya', () => {
    const { errors } = validateSteps([{ id: 'a', action: 'expect_status', value: 200 }], 'automated')
    expect(errors[0].path).toBe('steps[0].action')
  })

  it('memisahkan langkah manual dan automated', () => {
    expect(validateSteps([{ id: 'a', action: 'manual', description: 'Cek SMS' }], 'automated').errors).toHaveLength(1)
    expect(validateSteps([{ id: 'a', action: 'goto', url: 'x' }], 'manual').errors).toHaveLength(1)
    expect(validateSteps([{ id: 'a', action: 'manual' }], 'manual').errors[0].path).toBe('steps[0].description')
  })

  it('regex tidak valid ditolak', () => {
    const { errors } = validateSteps([{ id: 'a', action: 'expect_text', selector: '#x', value: '([', match: 'regex' }], 'automated')
    expect(errors.some((e) => e.path === 'steps[0].value')).toBe(true)
  })

  it('errorsByStep mengelompokkan per index', () => {
    const map = errorsByStep([
      { path: 'steps[2].selector', message: 'x' },
      { path: 'steps[2].value', message: 'y' },
      { path: 'title', message: 'z' },
    ])
    expect(map.get(2)).toHaveLength(2)
    expect(map.size).toBe(1)
  })
})

describe('summarizeStep & newStep', () => {
  it('membuat ringkasan human-readable', () => {
    expect(summarizeStep({ id: 'a', action: 'fill', selector: 'label=Email', value: 'qa@x.id' })).toBe('Fill label=Email with "qa@x.id"')
    expect(summarizeStep({ id: 'a', action: 'http_request', method: 'POST', url: '/orders' })).toBe('POST /orders')
  })

  it('memberi default yang masuk akal', () => {
    expect(newStep('http_request', 'x')).toMatchObject({ method: 'GET', body_type: 'json' })
    expect(newStep('expect_text', 'x')).toMatchObject({ match: 'contains' })
  })
})

describe('i18n katalog step', () => {
  afterEach(() => setLanguage('en'))

  const LANGS: Language[] = ['en', 'id']
  // Kunci yang tidak ada akan dikembalikan apa adanya oleh i18next (mis. "actions.goto.label").
  const unresolved = (v: string | undefined) => v !== undefined && /^(steps:)?[a-z_]+\.[\w.]+$/.test(v)

  it.each(LANGS)('semua label, deskripsi, param, dan ringkasan ter-resolve (%s)', async (lng) => {
    await setLanguage(lng)
    for (const g of Object.values(GROUP_LABELS)) expect(unresolved(g)).toBe(false)
    for (const a of ACTIONS) {
      expect(unresolved(a.label), `${a.action}.label`).toBe(false)
      expect(unresolved(a.description), `${a.action}.description`).toBe(false)
      for (const p of a.params) {
        expect(unresolved(p.label), `${a.action}.${p.name}.label`).toBe(false)
        expect(unresolved(p.help), `${a.action}.${p.name}.help`).toBe(false)
        expect(unresolved(p.placeholder), `${a.action}.${p.name}.placeholder`).toBe(false)
        for (const o of p.options ?? []) expect(unresolved(o.label), `${a.action}.${p.name}.option`).toBe(false)
      }
      const s = summarizeStep({ id: 'x', action: a.action, selector: '#a', value: 'v', name: 'n' })
      expect(unresolved(s), `${a.action}.summary`).toBe(false)
    }
  })

  it('label mengikuti bahasa aktif tanpa mengubah bentuk API', async () => {
    const click = ACTIONS.find((a) => a.action === 'click')!
    expect(click.label).toBe('Click')
    expect(GROUP_LABELS.interaction).toBe('Interaction')
    await setLanguage('id')
    expect(click.label).toBe('Klik')
    expect(GROUP_LABELS.interaction).toBe('Interaksi')
    expect(summarizeStep({ id: 'a', action: 'fill', selector: 'label=Email', value: 'qa@x.id' })).toBe('Isi label=Email dengan "qa@x.id"')
    expect(validateSteps([{ id: 'a', action: 'click' }], 'automated').errors[0].message).toBe('Selector wajib diisi')
  })

  it('opsi lng memaksa bahasa (dipakai mock API → English)', async () => {
    await setLanguage('id')
    expect(validateSteps([{ id: 'a', action: 'fill', selector: '#x' }], 'automated', { lng: 'en' }).errors[0].message).toBe('Value is required')
    expect(summarizeStep({ id: 'a', action: 'click', selector: '#x' }, { lng: 'en' })).toBe('Click #x')
  })
})

describe('http_request: save_regex, regex_decode & polling', () => {
  afterEach(() => setLanguage('en'))
  const req = (extra: Partial<Step>): Step => ({ id: 'a', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/search', ...extra })

  it('ringkasan menambah " (poll ≤Ns)" saat polling', async () => {
    const url = '{{env.MAILPIT_URL}}/api/v1/search?query=to:{{vars.email}}'
    expect(summarizeStep(req({ url, poll_timeout_ms: 15000 }))).toBe(`GET ${url} (poll ≤15s)`)
    expect(summarizeStep(req({ url, poll_timeout_ms: 1500 }))).toBe(`GET ${url} (poll ≤1.5s)`)
    expect(summarizeStep(req({ url, poll_timeout_ms: 0 }))).toBe(`GET ${url}`)
    expect(summarizeStep(req({ url }))).toBe(`GET ${url}`)
    await setLanguage('id')
    expect(summarizeStep(req({ url, poll_timeout_ms: 15000 }))).toBe(`GET ${url} (polling ≤15 dtk)`)
    expect(summarizeStep(req({ url, poll_timeout_ms: 15000 }), { lng: 'en' })).toBe(`GET ${url} (poll ≤15s)`)
  })

  it('param baru ada di katalog dengan tipe yang benar; polling dikelompokkan', () => {
    const def = ACTIONS.find((a) => a.action === 'http_request')!
    const byName = Object.fromEntries(def.params.map((p) => [p.name, p]))
    expect(byName.save_regex.type).toBe('keyvalue')
    expect(byName.regex_decode.type).toBe('select')
    expect(byName.regex_decode.options?.map((o) => o.value)).toEqual(['none', 'quoted_printable', 'html', 'auto'])
    expect([byName.poll_timeout_ms.type, byName.poll_interval_ms.type, byName.poll_until.type]).toEqual(['number', 'number', 'text'])
    expect(def.params.filter((p) => p.section === 'polling').map((p) => p.name)).toEqual(['poll_timeout_ms', 'poll_interval_ms', 'poll_until'])
    const names = def.params.map((p) => p.name)
    expect(names.indexOf('save_regex')).toBe(names.indexOf('save') + 1)
  })

  it('menerima konfigurasi polling & regex yang valid', () => {
    const steps = [
      req({ save: { id: '$.messages[0].ID' }, poll_timeout_ms: 15000, poll_interval_ms: 500, poll_until: '$.messages[0]' }),
      req({ id: 'b', save_regex: { otp: 'code: (\\d{6})', link: '/href="([^"]+)"/i' }, regex_decode: 'auto', poll_timeout_ms: 0 }),
    ]
    const r = validateSteps(steps, 'automated', { lng: 'en' })
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })

  it('menolak nilai di luar batas dengan path & pesan yang sama dengan backend', () => {
    const { errors } = validateSteps(
      [
        req({ poll_timeout_ms: 130000, poll_interval_ms: 100, regex_decode: 'base64' as Step['regex_decode'], save_regex: { z: '([', a: '', m: 'x'.repeat(1001) } }),
        req({ id: 'b', poll_timeout_ms: -1 }),
      ],
      'automated',
      { lng: 'en' },
    )
    expect(errors).toEqual([
      { path: 'steps[0].poll_timeout_ms', message: 'Polling timeout must be between 0 and 120000 ms' },
      { path: 'steps[0].poll_interval_ms', message: 'Polling interval must be at least 200 ms' },
      { path: 'steps[0].regex_decode', message: 'Regex decode must be one of: none, quoted_printable, html, auto' },
      { path: 'steps[0].save_regex', message: 'Regex for "a" is required' },
      { path: 'steps[0].save_regex', message: 'Regex for "m" is too long (max 1000 characters)' },
      { path: 'steps[0].save_regex', message: 'Invalid regex for "z"' },
      { path: 'steps[1].poll_timeout_ms', message: 'Polling timeout must be between 0 and 120000 ms' },
    ])
  })
})

describe('fn.* di step', () => {
  const fill = (value: string): Step => ({ id: 'a', action: 'fill', selector: 'label=Code', value })
  const run = (steps: Step[]) => validateSteps(steps, 'automated', { lng: 'en' })

  it('fn.totp dengan ref atau seed literal valid', () => {
    for (const v of [
      '{{fn.totp secret.OTP_SEED}}',
      '{{ fn.totp env.OTP }}',
      '{{fn.totp vars.otp_seed digits=8 period=60 algorithm=sha256}}',
      '{{fn.totp JBSWY3DPEHPK3PXP}}',
      'pre {{fn.uuid}} {{fn.random_int 1 9}} {{fn.totp secret.X algorithm=SHA512}}',
    ]) {
      const r = run([fill(v)])
      expect(r.errors, v).toEqual([])
      expect(r.warnings, v).toEqual([])
    }
  })

  it('argumen fn.totp yang salah adalah error; fn tak dikenal hanya warning', () => {
    const r = run([
      fill('{{fn.totp}}'),
      { ...fill('{{fn.totp 1234}}'), id: 'b' },
      { ...fill('{{fn.totp secret.X digits=9}}'), id: 'c' },
      { ...fill('{{fn.totp JBSW Y3DP}}'), id: 'd' },
      { id: 'e', action: 'http_request', method: 'POST', url: '{{env.API}}/x?{{fn.nope}}', headers: { 'X-Otp': '{{fn.totp secret.X foo=1}}', 'X-Dup': '{{fn.nope}}' } },
    ])
    expect(r.errors).toEqual([
      { path: 'steps[0].value', message: 'fn.totp needs a seed: secret.NAME, env.NAME, vars.name or a base32 literal' },
      { path: 'steps[1].value', message: 'fn.totp seed must be secret.NAME, env.NAME, vars.name or a base32 literal' },
      { path: 'steps[2].value', message: 'fn.totp: invalid option "digits" (digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512)' },
      { path: 'steps[3].value', message: 'fn.totp: invalid option "…" (digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512)' },
      { path: 'steps[4].headers', message: 'fn.totp: invalid option "foo" (digits=6..8, period=10..300, algorithm=SHA1|SHA256|SHA512)' },
    ])
    expect(r.warnings).toEqual([
      { path: 'steps[4].headers', message: 'Unknown function "fn.nope"' },
      { path: 'steps[4].url', message: 'Unknown function "fn.nope"' },
    ])
  })

  it('description/expected tidak dicek (teks manusia)', () => {
    expect(run([{ ...fill('x'), description: '{{fn.nope}}', expected: '{{fn.totp}}' }]).errors).toEqual([])
  })
})
