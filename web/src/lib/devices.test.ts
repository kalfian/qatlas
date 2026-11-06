/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { setLanguage } from '@/i18n'
import {
  DEFAULT_DEVICE,
  DEVICE_CATALOG,
  categoryForWidth,
  customDevice,
  customSizeErrors,
  deviceFromViewport,
  deviceLabel,
  devicesOf,
  devicesSummary,
  onlyOnLabel,
  onlyOnWords,
  presetDevice,
  resolveDeviceInput,
  restoreDevices,
  sortDevices,
  toDeviceInput,
  validateDeviceInputs,
} from './devices'
import webCatalog from './devices.json'

describe('device catalog', () => {
  it('web/src/lib/devices.json is identical to api/devices.json (scripts/sync-devices.mjs)', () => {
    // vitest runs with web/ as cwd (jsdom: import.meta.url is not a file: URL)
    const api = JSON.parse(readFileSync(resolve(process.cwd(), '../api/devices.json'), 'utf8'))
    expect(webCatalog).toEqual(api)
    expect(DEVICE_CATALOG).toEqual(api)
  })

  it('has the presets of docs/14 with unique ids and a desktop default', () => {
    const ids = DEVICE_CATALOG.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual(['desktop', 'laptop', 'desktop-fhd', 'ipad-pro-11', 'ipad-mini', 'galaxy-tab-s4', 'iphone-15', 'iphone-se', 'pixel-7', 'galaxy-s9plus'])
    expect(DEFAULT_DEVICE).toEqual({ id: 'desktop', label: 'Desktop', category: 'desktop', width: 1280, height: 720, device_scale_factor: 1, is_mobile: false, has_touch: false })
    // the run/project Device never carries the catalog-only playwright field
    expect(presetDevice('iphone-15')).not.toHaveProperty('playwright')
  })
})

describe('resolution rules (same as the backend)', () => {
  it('category from width: < 768 mobile, 768–1023 tablet, ≥ 1024 desktop', () => {
    expect([320, 767, 768, 1023, 1024, 3840].map(categoryForWidth)).toEqual(['mobile', 'mobile', 'tablet', 'tablet', 'desktop', 'desktop'])
  })

  it('custom device: DPR 1, not mobile, no touch, label "{w}×{h}" unless given', () => {
    expect(resolveDeviceInput({ id: 'custom', width: 390, height: 844 })).toEqual({
      id: 'custom', label: '390×844', category: 'mobile', width: 390, height: 844, device_scale_factor: 1, is_mobile: false, has_touch: false,
    })
    expect(resolveDeviceInput({ id: 'custom', width: 900, height: 1200, category: 'mobile', label: '  Foldable  ' })).toMatchObject({ category: 'mobile', label: 'Foldable' })
    expect(resolveDeviceInput({ id: 'iphone-15' })).toMatchObject({ category: 'mobile', width: 393, height: 659, device_scale_factor: 3, is_mobile: true, has_touch: true })
    expect(resolveDeviceInput({ id: 'nope' })).toBeUndefined()
  })

  it('legacy viewport → exact-size non-mobile preset, else custom', () => {
    expect(deviceFromViewport({ width: 1280, height: 720 }).id).toBe('desktop')
    expect(deviceFromViewport({ width: 1440, height: 900 }).id).toBe('laptop')
    expect(deviceFromViewport({ width: 1920, height: 1080 }).id).toBe('desktop-fhd')
    // same size as a mobile preset is still custom (is_mobile presets never match)
    expect(deviceFromViewport({ width: 393, height: 659 })).toMatchObject({ id: 'custom', category: 'mobile', is_mobile: false })
    expect(deviceFromViewport({ width: 390, height: 844 })).toMatchObject({ id: 'custom', label: '390×844' })
    expect(devicesOf({ viewport: { width: 1440, height: 900 } }).map((d) => d.id)).toEqual(['laptop'])
    expect(devicesOf({ devices: [presetDevice('pixel-7')!], viewport: { width: 1, height: 1 } }).map((d) => d.id)).toEqual(['pixel-7'])
  })

  it('toDeviceInput is minimal and round-trips', () => {
    expect(toDeviceInput(presetDevice('ipad-mini')!)).toEqual({ id: 'ipad-mini' })
    expect(toDeviceInput(customDevice({ width: 390, height: 844 }))).toEqual({ id: 'custom', width: 390, height: 844 })
    const odd = customDevice({ width: 900, height: 1200, category: 'mobile', label: 'Foldable' })
    expect(toDeviceInput(odd)).toEqual({ id: 'custom', width: 900, height: 1200, category: 'mobile', label: 'Foldable' })
    expect(resolveDeviceInput(toDeviceInput(odd))).toEqual(odd)
  })

  it('sorts desktop → tablet → mobile, presets in catalog order, customs after presets', () => {
    const list = [customDevice({ width: 400, height: 800 }), presetDevice('iphone-15')!, presetDevice('ipad-mini')!, presetDevice('laptop')!, presetDevice('desktop')!]
    expect(sortDevices(list).map((d) => d.label)).toEqual(['Desktop', 'Laptop', 'iPad Mini', 'iPhone 15', '400×800'])
  })
})

describe('validateDeviceInputs (422 paths of docs/14)', () => {
  it('accepts presets and custom sizes', () => {
    expect(validateDeviceInputs([{ id: 'desktop' }, { id: 'iphone-15' }, { id: 'custom', width: 390, height: 844 }])).toEqual([])
  })

  it('list errors: empty, more than 6', () => {
    expect(validateDeviceInputs([], { lng: 'en' })).toEqual([{ path: 'options.devices', message: 'Choose at least one device' }])
    const seven = ['desktop', 'laptop', 'desktop-fhd', 'ipad-mini', 'iphone-15', 'pixel-7', 'iphone-se'].map((id) => ({ id }))
    expect(validateDeviceInputs(seven, { lng: 'en', path: 'default_run_options.devices' })).toEqual([
      { path: 'default_run_options.devices', message: 'Choose at most 6 devices' },
    ])
  })

  it('item errors with indexed paths: unknown id, size range, category, label', () => {
    const errors = validateDeviceInputs(
      [
        { id: 'iphone-99' },
        { id: 'custom', width: 200, height: 5000 },
        { id: 'custom', width: 390, height: 844, category: 'phablet' as never, label: 'x'.repeat(41) },
      ],
      { lng: 'en' },
    )
    expect(errors).toEqual([
      { path: 'options.devices[0].id', message: 'Unknown device "iphone-99". Use one of: desktop, laptop, desktop-fhd, ipad-pro-11, ipad-mini, galaxy-tab-s4, iphone-15, iphone-se, pixel-7, galaxy-s9plus, or custom' },
      { path: 'options.devices[1].width', message: 'Must be between 320 and 3840' },
      { path: 'options.devices[1].height', message: 'Must be between 320 and 2160' },
      { path: 'options.devices[2].category', message: 'Use mobile, tablet or desktop' },
      { path: 'options.devices[2].label', message: 'Must be at most 40 characters' },
    ])
    expect(validateDeviceInputs([{ id: ' ' }, { id: 'custom' }, { id: 'iPhone-15' }], { lng: 'en' })).toEqual([
      { path: 'options.devices[0].id', message: 'Device id is required' },
      { path: 'options.devices[1].width', message: 'Width is required for a custom device' },
      { path: 'options.devices[1].height', message: 'Height is required for a custom device' },
    ])
  })

  it('duplicates: same preset id, or custom with the same size + category (label ignored)', () => {
    const errors = validateDeviceInputs(
      [{ id: 'desktop' }, { id: 'desktop' }, { id: 'custom', width: 390, height: 844 }, { id: 'custom', width: 390, height: 844, label: 'Same size, other label' }],
      { lng: 'en' },
    )
    expect(errors).toEqual([
      { path: 'options.devices[1]', message: 'Device Desktop · 1280×720 is already selected (devices[0])' },
      { path: 'options.devices[3]', message: 'Device Same size, other label · 390×844 is already selected (devices[2])' },
    ])
  })

  it('custom with the same size but another category is not a duplicate', () => {
    expect(validateDeviceInputs([{ id: 'custom', width: 800, height: 1000 }, { id: 'custom', width: 800, height: 1000, category: 'desktop' }])).toEqual([])
  })

  it('custom size typed into the picker', () => {
    expect(customSizeErrors('390', '844', [], 'en')).toEqual({})
    expect(customSizeErrors('', '844', [], 'en').width).toBe('Width must be a whole number between 320 and 3840')
    expect(customSizeErrors('390', '100', [], 'en').height).toBe('Height must be a whole number between 320 and 2160')
    expect(customSizeErrors('390', '844', [customDevice({ width: 390, height: 844 })], 'en').duplicate).toBe('390×844 is already in the list')
  })
})

describe('restoreDevices (last-used options in localStorage)', () => {
  it('stored devices win; an older stored viewport maps through the legacy rule', () => {
    expect(restoreDevices({ devices: [presetDevice('ipad-mini'), customDevice({ width: 390, height: 844 })] })?.map((d) => d.label)).toEqual(['iPad Mini', '390×844'])
    expect(restoreDevices({ viewport: { width: 1440, height: 900 } })?.map((d) => d.id)).toEqual(['laptop'])
    expect(restoreDevices({ viewport: { width: 390, height: 844 } })?.[0]).toMatchObject({ id: 'custom', category: 'mobile' })
  })

  it('invalid or missing data → null (caller falls back to the project default)', () => {
    expect(restoreDevices(null)).toBeNull()
    expect(restoreDevices({})).toBeNull()
    expect(restoreDevices({ devices: [{ id: 'gone-device' }] })).toBeNull()
    expect(restoreDevices({ devices: [{ id: 'gone-device' }], viewport: { width: 1280, height: 720 } })?.[0].id).toBe('desktop')
  })
})

describe('labels', () => {
  afterEach(() => setLanguage('en'))

  it('device label, summary and only_on badge', async () => {
    expect(deviceLabel(presetDevice('iphone-15')!)).toBe('iPhone 15 · 393×659')
    expect(deviceLabel(customDevice({ width: 390, height: 844 }))).toBe('390×844')
    expect(devicesSummary([DEFAULT_DEVICE])).toBe('Desktop · 1280×720')
    expect(devicesSummary([DEFAULT_DEVICE, presetDevice('iphone-15')!, presetDevice('pixel-7')!])).toBe('3 devices · 2 mobile')
    expect(devicesSummary([DEFAULT_DEVICE, presetDevice('ipad-mini')!, presetDevice('iphone-15')!])).toBe('3 devices · 1 tablet · 1 mobile')
    expect(onlyOnLabel(['mobile'])).toBe('Mobile only')
    expect(onlyOnLabel(['mobile', 'tablet'])).toBe('Tablet + mobile')
    expect(onlyOnWords(['mobile', 'desktop'])).toBe('desktop + mobile')
    expect(onlyOnLabel([])).toBeNull()
    expect(onlyOnLabel(undefined)).toBeNull()
    await setLanguage('id')
    expect(onlyOnLabel(['mobile'])).toBe('Hanya Mobile')
    expect(devicesSummary([DEFAULT_DEVICE, presetDevice('iphone-15')!])).toBe('2 device · 1 mobile')
  })
})
