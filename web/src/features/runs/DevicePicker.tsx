import { ChevronDown, Info, Plus, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { Device, RunOptions } from '@/api/types'
import { DeviceIcon } from '@/components/devices'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  CUSTOM_ID,
  DEVICE_CATALOG,
  DEVICE_CATEGORIES,
  MAX_DEVICES,
  categoryForWidth,
  categoryLabel,
  categoryWord,
  customDevice,
  customSizeErrors,
  deviceIdentity,
  deviceLabel,
  devicesSummary,
  presetDevice,
  sizeLabel,
  sortDevices,
} from '@/lib/devices'
import { cn } from '@/lib/utils'

/**
 * Multi-device picker for the Run dialog and Settings → Run defaults (docs/14-responsive-testing.md):
 * a select-like trigger with the summary ("3 devices · 2 mobile"), removable chips for the selection,
 * and a popover with presets grouped Desktop / Tablet / Mobile plus a custom width×height row.
 * 1–6 devices; the list is kept in report-column order (desktop → tablet → mobile, catalog order).
 */
export function DevicePicker({
  id,
  labelId,
  value,
  onChange,
  browser,
  error,
  className,
}: {
  /** id of the trigger button (for the field's <Label htmlFor>). */
  id: string
  /** id of the field's visible label: the trigger is named "<label> <summary>". */
  labelId: string
  value: Device[]
  onChange: (devices: Device[]) => void
  browser?: RunOptions['browser']
  /** Server/validation message shown under the field. */
  error?: string
  className?: string
}) {
  const { t } = useTranslation('devices')
  const [open, setOpen] = React.useState(false)
  const chipsRef = React.useRef<HTMLUListElement>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const atMax = value.length >= MAX_DEVICES
  const selectedKeys = new Set(value.map(deviceIdentity))
  const summary = devicesSummary(value)
  const firefoxMobile = browser === 'firefox' && value.some((d) => d.is_mobile)
  const errorId = `${id}-error`
  const noteId = `${id}-firefox`

  const set = (next: Device[]) => onChange(sortDevices(next))
  const toggle = (d: Device, on: boolean) => {
    const key = deviceIdentity(d)
    if (on) {
      if (!selectedKeys.has(key) && !atMax) set([...value, d])
    } else if (value.length > 1) {
      set(value.filter((x) => deviceIdentity(x) !== key))
    }
  }
  const remove = (d: Device, index: number) => {
    toggle(d, false)
    // keep keyboard focus in the chip list: next chip's remove button, else the trigger
    requestAnimationFrame(() => {
      const buttons = chipsRef.current?.querySelectorAll<HTMLButtonElement>('button')
      const target = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)]
      ;(target ?? triggerRef.current)?.focus()
    })
  }

  return (
    <div className={cn('grid gap-2', className)}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            ref={triggerRef}
            id={id}
            type="button"
            aria-labelledby={`${labelId} ${id}-summary`}
            aria-describedby={[error ? errorId : null, firefoxMobile ? noteId : null].filter(Boolean).join(' ') || undefined}
            aria-invalid={error ? true : undefined}
            className="flex h-8 w-full items-center gap-2 rounded-md border border-input bg-background px-2.5 text-left text-sm transition-colors duration-150 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:outline-none aria-invalid:border-destructive max-sm:h-11"
          >
            <span className="flex shrink-0 items-center gap-0.5 text-muted-foreground" aria-hidden>
              {DEVICE_CATEGORIES.filter((c) => value.some((d) => d.category === c)).map((c) => (
                <DeviceIcon key={c} category={c} />
              ))}
            </span>
            <span id={`${id}-summary`} className="min-w-0 flex-1 truncate">
              {summary}
            </span>
            <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </PopoverTrigger>
        <PopoverContent
          className="flex max-h-[min(36rem,var(--radix-popover-content-available-height))] w-[min(22rem,calc(100vw-2rem))] flex-col p-0"
          aria-label={t('picker.label')}
          collisionPadding={16}
          onOpenAutoFocus={(e) => {
            // focus the first checked box rather than the popover itself
            e.preventDefault()
            const el = (e.currentTarget as HTMLElement | null)?.querySelector<HTMLElement>('[role="checkbox"][data-state="checked"]')
            el?.focus()
          }}
        >
          <PickerBody value={value} atMax={atMax} selectedKeys={selectedKeys} onToggle={toggle} onAdd={(d) => set([...value, d])} idPrefix={id} />
          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border px-3 py-2">
            <span className="min-w-0 truncate text-xs text-muted-foreground tabular" aria-live="polite">
              {summary}
            </span>
            <Button type="button" size="sm" variant="outline" className="max-sm:h-11" onClick={() => setOpen(false)}>
              {t('picker.done')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {value.length > 1 && (
        <ul ref={chipsRef} aria-label={t('picker.selected')} className="flex flex-wrap gap-1.5">
          {value.map((d, i) => (
            <li key={deviceIdentity(d)} className="inline-flex h-6 max-w-full items-center gap-1 rounded-sm bg-secondary pr-0.5 pl-1.5 text-xs text-secondary-foreground max-sm:h-8">
              <DeviceIcon category={d.category} className="size-3 text-muted-foreground" />
              <span className="truncate">{deviceLabel(d)}</span>
              <button
                type="button"
                onClick={() => remove(d, i)}
                aria-label={t('picker.remove', { label: deviceLabel(d) })}
                className="ml-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-sm:size-7"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && (
        <p id={errorId} className="text-xs text-destructive">
          {error}
        </p>
      )}
      {firefoxMobile && (
        <p id={noteId} className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <Info className="mt-px size-3.5 shrink-0" aria-hidden />
          {t('picker.firefoxNote')}
        </p>
      )}
    </div>
  )
}

function PickerBody({
  value,
  atMax,
  selectedKeys,
  onToggle,
  onAdd,
  idPrefix,
}: {
  value: Device[]
  atMax: boolean
  selectedKeys: Set<string>
  onToggle: (d: Device, on: boolean) => void
  onAdd: (d: Device) => void
  idPrefix: string
}) {
  const { t } = useTranslation('devices')
  const customs = value.filter((d) => d.id === CUSTOM_ID)
  return (
    <div className="grid min-h-0 gap-3 overflow-y-auto overscroll-contain p-2">
      <p className="px-1 pt-1 text-xs text-muted-foreground">{t('picker.hint', { max: String(MAX_DEVICES) })}</p>
      {DEVICE_CATEGORIES.map((cat) => {
        const items = [...DEVICE_CATALOG.filter((d) => d.category === cat).map((d) => presetDevice(d.id)!), ...customs.filter((d) => d.category === cat)]
        const headingId = `${idPrefix}-group-${cat}`
        return (
          <div key={cat} role="group" aria-labelledby={headingId} className="grid gap-0.5">
            <p id={headingId} className="flex items-center gap-1.5 px-1 pb-0.5 text-xs font-medium text-muted-foreground">
              <DeviceIcon category={cat} />
              {categoryLabel(cat)}
            </p>
            {items.map((d) => {
              const key = deviceIdentity(d)
              const checked = selectedKeys.has(key)
              const lastOne = checked && value.length === 1
              const blocked = !checked && atMax
              const rowId = `${idPrefix}-opt-${key.replace(/[^\w-]/g, '-')}`
              return (
                <label
                  key={key}
                  htmlFor={rowId}
                  className={cn(
                    'flex h-7 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm transition-colors duration-150 hover:bg-accent max-sm:h-11',
                    (lastOne || blocked) && 'cursor-not-allowed hover:bg-transparent',
                  )}
                  title={lastOne ? t('picker.lastOne') : blocked ? t('picker.limitReached', { max: String(MAX_DEVICES) }) : undefined}
                >
                  {/* aria-disabled (not disabled): stays focusable, the reason is in the label's title / status line */}
                  <Checkbox
                    id={rowId}
                    aria-label={`${d.id === CUSTOM_ID ? t('picker.custom') : d.label} ${sizeLabel(d)}`}
                    checked={checked}
                    aria-disabled={lastOne || blocked || undefined}
                    className="aria-disabled:opacity-50"
                    onCheckedChange={(v) => onToggle(d, v === true)}
                  />
                  <span className={cn('min-w-0 flex-1 truncate', blocked && 'text-muted-foreground')}>{d.id === CUSTOM_ID ? t('picker.custom') : d.label}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular">{sizeLabel(d)}</span>
                </label>
              )
            })}
          </div>
        )
      })}
      {atMax && (
        <p role="status" className="px-1 text-xs text-muted-foreground">
          {t('picker.limitReached', { max: String(MAX_DEVICES) })}
        </p>
      )}
      <CustomRow idPrefix={idPrefix} existing={value} disabled={atMax} onAdd={onAdd} />
    </div>
  )
}

function CustomRow({ idPrefix, existing, disabled, onAdd }: { idPrefix: string; existing: Device[]; disabled: boolean; onAdd: (d: Device) => void }) {
  const { t } = useTranslation('devices')
  const [w, setW] = React.useState('')
  const [h, setH] = React.useState('')
  const [touched, setTouched] = React.useState(false)
  const [announce, setAnnounce] = React.useState('')
  const wRef = React.useRef<HTMLInputElement>(null)
  const errs = customSizeErrors(w, h, existing)
  const show = touched && (w !== '' || h !== '')
  const widthErr = show ? errs.width : undefined
  const heightErr = show ? errs.height : undefined
  const msg = widthErr ?? heightErr ?? (show ? errs.duplicate : undefined)
  const valid = !errs.width && !errs.height && !errs.duplicate
  const hintId = `${idPrefix}-custom-hint`
  const category = !errs.width ? categoryForWidth(Number(w)) : null

  const add = () => {
    setTouched(true)
    if (!valid || disabled) {
      if (errs.width) wRef.current?.focus()
      return
    }
    const d = customDevice({ width: Number(w), height: Number(h) })
    onAdd(d)
    setAnnounce(t('picker.added', { label: deviceLabel(d) }))
    setW('')
    setH('')
    setTouched(false)
  }

  return (
    <div role="group" aria-labelledby={`${idPrefix}-custom-label`} className="grid gap-1.5 border-t border-border px-1 pt-3">
      <p id={`${idPrefix}-custom-label`} className="text-xs font-medium text-muted-foreground">
        {t('picker.custom')}
      </p>
      <div
        className="flex items-center gap-1.5"
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            // Enter adds the size instead of submitting the surrounding form
            e.preventDefault()
            add()
          }
        }}
      >
        <Input
          ref={wRef}
          aria-label={t('picker.widthAria')}
          placeholder={t('picker.width')}
          inputMode="numeric"
          disabled={disabled}
          aria-invalid={widthErr ? true : undefined}
          aria-describedby={hintId}
          className="w-20 font-mono text-[12px] max-sm:h-11"
          value={w}
          onChange={(e) => setW(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <span className="text-muted-foreground" aria-hidden>
          ×
        </span>
        <Input
          aria-label={t('picker.heightAria')}
          placeholder={t('picker.height')}
          inputMode="numeric"
          disabled={disabled}
          aria-invalid={heightErr ? true : undefined}
          aria-describedby={hintId}
          className="w-20 font-mono text-[12px] max-sm:h-11"
          value={h}
          onChange={(e) => setH(e.target.value.replace(/\D/g, '').slice(0, 4))}
        />
        <Button type="button" size="sm" variant="secondary" className="ml-auto max-sm:h-11" disabled={disabled} aria-label={t('picker.addAria')} onClick={add}>
          <Plus /> {t('picker.add')}
        </Button>
      </div>
      <p id={hintId} className={cn('text-xs', msg ? 'text-destructive' : 'text-muted-foreground')}>
        {msg ?? (category ? t('picker.countsAs', { category: categoryWord(category) }) : ' ')}
      </p>
      <span className="sr-only" role="status">
        {announce}
      </span>
    </div>
  )
}
