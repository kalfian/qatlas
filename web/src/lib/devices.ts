import type { Device, DeviceCategory, DeviceInput, FieldError } from '@/api/types'
import type { Language } from '@/i18n'
import { tr, translatorFor } from '@/lib/i18n-labels'
import {
  CUSTOM_ID,
  DEVICE_CATALOG,
  DEVICE_CATEGORIES,
  HEIGHT_MAX,
  HEIGHT_MIN,
  LABEL_MAX,
  MAX_DEVICES,
  WIDTH_MAX,
  WIDTH_MIN,
  countByCategory,
  customDevice,
  deviceFromViewport,
  deviceIdentity,
  deviceLabel,
  presetById,
  resolveDeviceInput,
  toDeviceInput,
} from './device-catalog'

/** Device catalog + rules (./device-catalog) plus validation and labels in the active language. */
export * from './device-catalog'

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)

/* ------------------------------------------------------------------ validation */

export interface DeviceValidationOptions {
  /** Path prefix of the list, e.g. `options.devices` (run) or `default_run_options.devices` (project). */
  path?: string
  /** Force a language (mock API answers in English like the Go backend). */
  lng?: Language
}

/**
 * Validates `DeviceInput[]` exactly like backend/internal/devices.Resolve (same paths and English messages):
 * `{path}` (not a list / empty / > 6), `{path}[i].id` (missing/unknown), `{path}[i].width|height|category|label`,
 * `{path}[i]` (duplicate of an earlier entry). Returns [] when valid.
 */
export function validateDeviceInputs(value: unknown, opts: DeviceValidationOptions = {}): FieldError[] {
  const t = translatorFor(opts.lng)
  const path = opts.path ?? 'options.devices'
  if (!Array.isArray(value)) return [{ path, message: t('devices:validation.notList') }]
  if (value.length === 0) return [{ path, message: t('devices:validation.empty') }]
  if (value.length > MAX_DEVICES) return [{ path, message: t('devices:validation.tooMany', { max: MAX_DEVICES }) }]
  const errors: FieldError[] = []
  const seen = new Map<string, number>()
  const range = (min: number, max: number) => t('devices:validation.range', { min, max })
  value.forEach((raw, i) => {
    const p = `${path}[${i}]`
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : ''
    let device: Device
    let key: string
    if (!id) {
      errors.push({ path: `${p}.id`, message: t('devices:validation.idRequired') })
      return
    } else if (id === CUSTOM_ID) {
      const before = errors.length
      if (input.width === undefined || input.width === null) errors.push({ path: `${p}.width`, message: t('devices:validation.widthRequired') })
      else if (!isInt(input.width) || input.width < WIDTH_MIN || input.width > WIDTH_MAX) errors.push({ path: `${p}.width`, message: range(WIDTH_MIN, WIDTH_MAX) })
      if (input.height === undefined || input.height === null) errors.push({ path: `${p}.height`, message: t('devices:validation.heightRequired') })
      else if (!isInt(input.height) || input.height < HEIGHT_MIN || input.height > HEIGHT_MAX) errors.push({ path: `${p}.height`, message: range(HEIGHT_MIN, HEIGHT_MAX) })
      const category = typeof input.category === 'string' ? input.category.trim() : input.category
      if (category !== undefined && category !== null && category !== '' && !(DEVICE_CATEGORIES as readonly unknown[]).includes(category))
        errors.push({ path: `${p}.category`, message: t('devices:validation.category') })
      if (input.label !== undefined && input.label !== null && (typeof input.label !== 'string' || [...input.label.trim()].length > LABEL_MAX))
        errors.push({ path: `${p}.label`, message: t('devices:validation.label', { max: LABEL_MAX }) })
      if (errors.length > before) return
      device = customDevice({ width: input.width as number, height: input.height as number, category: (category || undefined) as DeviceCategory | undefined, label: input.label as string | undefined })
      key = deviceIdentity(device)
    } else {
      const preset = presetById(id)
      if (!preset) {
        errors.push({ path: `${p}.id`, message: t('devices:validation.unknownId', { id: String(input.id), ids: DEVICE_CATALOG.map((d) => d.id).join(', ') }) })
        return
      }
      device = preset
      key = id
    }
    const first = seen.get(key)
    if (first !== undefined) {
      errors.push({ path: p, message: t('devices:validation.duplicate', { label: deviceLabel(device), index: first }) })
      return
    }
    seen.set(key, i)
  })
  return errors
}

/**
 * Client-side check of a custom size typed into the picker (strings while typing). Returns per-field
 * messages in the active language; empty object = valid.
 */
export function customSizeErrors(width: string, height: string, existing: readonly Device[], lng?: Language): { width?: string; height?: string; duplicate?: string } {
  const t = translatorFor(lng)
  const out: { width?: string; height?: string; duplicate?: string } = {}
  const w = Number(width)
  const h = Number(height)
  if (!width.trim() || !Number.isInteger(w) || w < WIDTH_MIN || w > WIDTH_MAX) out.width = t('devices:validation.width', { min: WIDTH_MIN, max: WIDTH_MAX })
  if (!height.trim() || !Number.isInteger(h) || h < HEIGHT_MIN || h > HEIGHT_MAX) out.height = t('devices:validation.height', { min: HEIGHT_MIN, max: HEIGHT_MAX })
  if (!out.width && !out.height) {
    const key = deviceIdentity(customDevice({ width: w, height: h }))
    if (existing.some((d) => deviceIdentity(d) === key)) out.duplicate = t('devices:validation.alreadyAdded', { label: `${w}×${h}` })
  }
  return out
}

/**
 * Restores devices from a stored options blob (localStorage "last used"): valid `devices` win, else a
 * stored `viewport` maps through the legacy rule, else null (caller falls back to the project default).
 */
export function restoreDevices(stored: { devices?: unknown; viewport?: unknown } | null | undefined): Device[] | null {
  if (!stored) return null
  if (Array.isArray(stored.devices) && stored.devices.length) {
    const inputs = stored.devices.map((d) => (d && typeof d === 'object' ? toDeviceInput(d as Device) : d))
    if (validateDeviceInputs(inputs).length === 0) return inputs.map((i) => resolveDeviceInput(i as DeviceInput)!)
  }
  const v = stored.viewport as { width?: unknown; height?: unknown } | undefined
  if (v && isInt(v.width) && isInt(v.height)) return [deviceFromViewport({ width: v.width, height: v.height })]
  return null
}

/* ------------------------------------------------------------------ labels (active language) */

export const categoryLabel = (c: DeviceCategory) => tr(`devices:category.${c}`)
export const categoryWord = (c: DeviceCategory) => tr(`devices:categoryWord.${c}`)

/** `only_on` in display order (desktop → tablet → mobile), ignoring unknown values. */
export const orderedCategories = (list: readonly DeviceCategory[] | null | undefined): DeviceCategory[] => DEVICE_CATEGORIES.filter((c) => list?.includes(c))

/** Lower-case words for sentences: "tablet + mobile". */
export const onlyOnWords = (list: readonly DeviceCategory[] | null | undefined): string => orderedCategories(list).map(categoryWord).join(tr('devices:onlyOn.join'))

/** Badge for a step's `only_on`: "Mobile only", "Tablet + mobile". Empty/absent → null (runs everywhere). */
export function onlyOnLabel(list: readonly DeviceCategory[] | null | undefined): string | null {
  if (!list?.length) return null
  const ordered = orderedCategories(list)
  if (ordered.length === 0) return null
  if (ordered.length === 1) return tr('devices:onlyOn.badgeOne', { category: categoryLabel(ordered[0]) })
  const [first, ...rest] = ordered
  return tr('devices:onlyOn.badgeMany', { list: [categoryLabel(first), ...rest.map(categoryWord)].join(tr('devices:onlyOn.join')) })
}

/** One device → its label ("iPhone 15 · 393×659"); several → "3 devices · 1 tablet · 2 mobile". */
export function devicesSummary(list: readonly Device[]): string {
  if (list.length === 1) return deviceLabel(list[0])
  const counts = countByCategory(list)
  const parts = [tr('devices:summary.count', { count: list.length })]
  for (const c of ['tablet', 'mobile'] as const)
    if (counts[c]) parts.push(tr('devices:summary.ofCategory', { count: counts[c], category: categoryWord(c) }))
  return parts.join(' · ')
}
