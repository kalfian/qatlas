import type { Device, DeviceCategory, DeviceInput } from '@/api/types'
import catalog from './devices.json'

/**
 * Device catalog + resolution rules for responsive runs (docs/14-responsive-testing.md), without i18n so
 * the mock seed/db (bundled for Node by scripts/export-demo-seed.mjs) can use it. UI code imports
 * `@/lib/devices`, which re-exports this module plus validation and translated labels.
 * `devices.json` is a copy of `api/devices.json` (scripts/sync-devices.mjs); devices.test.ts fails when they drift.
 * The rules mirror the backend: custom → DPR 1, not mobile, no touch, category from width,
 * label "{w}×{h}"; a lone legacy `viewport` → exact-size non-mobile preset, else custom.
 */

/** Catalog entry: a resolved Device plus the Playwright descriptor name the runner uses (UI ignores it). */
export interface CatalogDevice extends Device {
  playwright: string | null
}

export const DEVICE_CATALOG: readonly CatalogDevice[] = catalog as CatalogDevice[]

/** Display order of groups (picker, summaries, default sort). */
export const DEVICE_CATEGORIES: readonly DeviceCategory[] = ['desktop', 'tablet', 'mobile']

export const MAX_DEVICES = 6
export const WIDTH_MIN = 320
export const WIDTH_MAX = 3840
export const HEIGHT_MIN = 320
export const HEIGHT_MAX = 2160
export const LABEL_MAX = 40
export const CUSTOM_ID = 'custom'

const BY_ID = new Map(DEVICE_CATALOG.map((d) => [d.id, d]))

export function presetById(id: string): CatalogDevice | undefined {
  return BY_ID.get(id)
}

/** < 768 mobile, 768–1023 tablet, ≥ 1024 desktop. */
export function categoryForWidth(width: number): DeviceCategory {
  if (width < 768) return 'mobile'
  if (width < 1024) return 'tablet'
  return 'desktop'
}

export const sizeLabel = (d: Pick<Device, 'width' | 'height'>) => `${d.width}×${d.height}`

/** Strips the catalog-only `playwright` field so a preset can be stored as a run/project Device. */
function toDevice(d: CatalogDevice): Device {
  return {
    id: d.id,
    label: d.label,
    category: d.category,
    width: d.width,
    height: d.height,
    device_scale_factor: d.device_scale_factor,
    is_mobile: d.is_mobile,
    has_touch: d.has_touch,
  }
}

export function presetDevice(id: string): Device | undefined {
  const p = presetById(id)
  return p ? toDevice(p) : undefined
}

export const DEFAULT_DEVICE: Device = presetDevice('desktop')!

export function customDevice(input: { width: number; height: number; category?: DeviceCategory; label?: string }): Device {
  const label = input.label?.trim()
  return {
    id: CUSTOM_ID,
    label: label || sizeLabel(input),
    category: input.category ?? categoryForWidth(input.width),
    width: input.width,
    height: input.height,
    device_scale_factor: 1,
    is_mobile: false,
    has_touch: false,
  }
}

/** Resolves one (already validated) input; unknown preset id → undefined. */
export function resolveDeviceInput(input: DeviceInput): Device | undefined {
  const id = String(input.id ?? '').trim().toLowerCase() // the backend accepts "iPhone-15"
  if (id === CUSTOM_ID) {
    if (typeof input.width !== 'number' || typeof input.height !== 'number') return undefined
    return customDevice({ width: input.width, height: input.height, category: input.category || undefined, label: input.label })
  }
  return presetDevice(id)
}

/** Legacy `viewport` (runs/projects stored before devices existed, or a lone `viewport` input). */
export function deviceFromViewport(v: { width: number; height: number }): Device {
  const hit = DEVICE_CATALOG.find((d) => !d.is_mobile && d.width === v.width && d.height === v.height)
  return hit ? toDevice(hit) : customDevice(v)
}

/**
 * Smallest input that resolves back to the same device: `{ id }` for presets; custom keeps
 * category/label only when they differ from the defaults the server derives.
 */
export function toDeviceInput(d: Device): DeviceInput {
  if (d.id !== CUSTOM_ID) return { id: d.id }
  const input: DeviceInput = { id: CUSTOM_ID, width: d.width, height: d.height }
  if (d.category !== categoryForWidth(d.width)) input.category = d.category
  if (d.label !== sizeLabel(d)) input.label = d.label
  return input
}

/** Identity for duplicate checks: preset id, or custom size + category (same rule as the backend). */
export function deviceIdentity(d: Pick<Device, 'id' | 'width' | 'height' | 'category'>): string {
  return d.id === CUSTOM_ID ? `custom:${d.width}x${d.height}:${d.category}` : d.id
}

/** "iPhone 15 · 393×659"; a custom device labelled with its own size shows the size once. */
export function deviceLabel(d: Pick<Device, 'label' | 'width' | 'height'>): string {
  const size = sizeLabel(d)
  return d.label === size ? size : `${d.label} · ${size}`
}

/** Stable display/report order: category (desktop → tablet → mobile), presets in catalog order, then customs by width desc. */
export function sortDevices<T extends Device>(list: readonly T[]): T[] {
  const rank = (d: Device) => {
    const cat = DEVICE_CATEGORIES.indexOf(d.category)
    const preset = DEVICE_CATALOG.findIndex((p) => p.id === d.id)
    return [cat, preset === -1 ? DEVICE_CATALOG.length : preset, -d.width, -d.height] as const
  }
  return [...list].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i]
    return 0
  })
}

export function countByCategory(list: readonly Pick<Device, 'category'>[]): Record<DeviceCategory, number> {
  const out: Record<DeviceCategory, number> = { desktop: 0, tablet: 0, mobile: 0 }
  for (const d of list) out[d.category] += 1
  return out
}

/** Devices of a run/project; data stored before devices existed falls back to its viewport. */
export function devicesOf(o: { devices?: Device[] | null; viewport?: { width: number; height: number } | null }): Device[] {
  if (o.devices?.length) return o.devices
  return [o.viewport ? deviceFromViewport(o.viewport) : DEFAULT_DEVICE]
}
