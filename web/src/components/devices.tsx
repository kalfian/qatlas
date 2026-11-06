import { Monitor, Smartphone, Tablet, type LucideIcon } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Device, DeviceCategory } from '@/api/types'
import { CUSTOM_ID, sizeLabel } from '@/lib/devices'
import { cn } from '@/lib/utils'

export const CATEGORY_ICON: Record<DeviceCategory, LucideIcon> = {
  desktop: Monitor,
  tablet: Tablet,
  mobile: Smartphone,
}

export function DeviceIcon({ category, className }: { category: DeviceCategory; className?: string }) {
  const Icon = CATEGORY_ICON[category]
  return <Icon className={cn('size-3.5 shrink-0', className)} aria-hidden />
}

/** Neutral chip "▯ iPhone 15 393×659" (device = data, not status: no colour). */
export function DeviceChip({ device, className }: { device: Device; className?: string }) {
  const { t } = useTranslation('devices')
  const size = sizeLabel(device)
  const title =
    device.id === CUSTOM_ID
      ? t('chip.customTitle')
      : t('chip.presetTitle', { label: device.label, dpr: String(device.device_scale_factor), touch: device.has_touch ? t('chip.touch') : '' })
  return (
    <span
      className={cn('inline-flex h-5 max-w-full min-w-0 items-center gap-1 rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground', className)}
      title={title}
      data-device={device.id}
    >
      <DeviceIcon category={device.category} className="size-3 text-muted-foreground" />
      {device.label !== size && <span className="truncate font-medium">{device.label}</span>}
      <span className={cn('font-mono text-[11px] tabular', device.label !== size && 'text-muted-foreground')}>
        <span className="sr-only"> · </span>
        {size}
      </span>
    </span>
  )
}
