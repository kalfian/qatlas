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
