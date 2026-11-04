import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Clock,
  Hand,
  LoaderCircle,
  OctagonAlert,
  type LucideIcon,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { RunStatus, StepStatus } from '@/api/types'
import { tr } from '@/lib/i18n-labels'
import { cn } from '@/lib/utils'

export type AnyStatus = RunStatus | StepStatus

interface StatusMeta {
  label: string
  icon: LucideIcon
  fg: string
  bg: string
  spin?: boolean
}

type StatusStyle = Omit<StatusMeta, 'label'>

const STATUS_STYLE: Record<AnyStatus, StatusStyle> = {
  passed: { icon: CircleCheck, fg: 'text-status-passed', bg: 'bg-status-passed-bg' },
  failed: { icon: CircleX, fg: 'text-status-failed', bg: 'bg-status-failed-bg' },
  error: { icon: OctagonAlert, fg: 'text-status-error', bg: 'bg-status-error-bg' },
  blocked: { icon: Ban, fg: 'text-status-blocked', bg: 'bg-status-blocked-bg' },
  running: { icon: LoaderCircle, fg: 'text-status-running', bg: 'bg-status-running-bg', spin: true },
  queued: { icon: Clock, fg: 'text-status-queued', bg: 'bg-status-queued-bg' },
  pending: { icon: Clock, fg: 'text-status-queued', bg: 'bg-status-queued-bg' },
  awaiting_manual: { icon: Hand, fg: 'text-status-awaiting-manual', bg: 'bg-status-awaiting-manual-bg' },
  cancelled: { icon: CircleSlash, fg: 'text-status-cancelled', bg: 'bg-status-cancelled-bg' },
  skipped: { icon: CircleDashed, fg: 'text-status-skipped', bg: 'bg-status-skipped-bg' },
}

/**
 * Label lewat namespace `status` (tetap Inggris di semua bahasa, sama dengan output MCP/API).
 * `label` adalah getter → bentuk `StatusMeta` tidak berubah.
 */
export const STATUS_META: Record<AnyStatus, StatusMeta> = Object.fromEntries(
  (Object.keys(STATUS_STYLE) as AnyStatus[]).map((k) => [
    k,
    {
      ...STATUS_STYLE[k],
      get label() {
        return tr(`status:${k}`)
      },
    },
  ]),
) as Record<AnyStatus, StatusMeta>

export function StatusBadge({ status, className, compact }: { status: AnyStatus; className?: string; compact?: boolean }) {
  useTranslation('status') // re-render saat bahasa berganti
  const m = STATUS_META[status]
  const Icon = m.icon
  return (
    <span
      className={cn('inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs font-medium whitespace-nowrap', m.bg, m.fg, className)}
      data-status={status}
    >
      <Icon className={cn('size-3 shrink-0', m.spin && 'animate-spin')} aria-hidden />
      {compact ? <span className="sr-only">{m.label}</span> : m.label}
    </span>
  )
}

/** Ikon status saja (dengan label sr-only). */
export function StatusIcon({ status, className }: { status: AnyStatus; className?: string }) {
  useTranslation('status')
  const m = STATUS_META[status]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex', m.fg, className)} title={m.label}>
      <Icon className={cn('size-4', m.spin && 'animate-spin')} aria-hidden />
      <span className="sr-only">{m.label}</span>
    </span>
  )
}
