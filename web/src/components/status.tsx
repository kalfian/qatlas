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
import type { RunStatus, StepStatus } from '@/api/types'
import { cn } from '@/lib/utils'

export type AnyStatus = RunStatus | StepStatus

interface StatusMeta {
  label: string
  icon: LucideIcon
  fg: string
  bg: string
  spin?: boolean
}

export const STATUS_META: Record<AnyStatus, StatusMeta> = {
  passed: { label: 'Passed', icon: CircleCheck, fg: 'text-status-passed', bg: 'bg-status-passed-bg' },
  failed: { label: 'Failed', icon: CircleX, fg: 'text-status-failed', bg: 'bg-status-failed-bg' },
  error: { label: 'Error', icon: OctagonAlert, fg: 'text-status-error', bg: 'bg-status-error-bg' },
  blocked: { label: 'Blocked', icon: Ban, fg: 'text-status-blocked', bg: 'bg-status-blocked-bg' },
  running: { label: 'Running', icon: LoaderCircle, fg: 'text-status-running', bg: 'bg-status-running-bg', spin: true },
  queued: { label: 'Queued', icon: Clock, fg: 'text-status-queued', bg: 'bg-status-queued-bg' },
  pending: { label: 'Pending', icon: Clock, fg: 'text-status-queued', bg: 'bg-status-queued-bg' },
  awaiting_manual: { label: 'Awaiting manual', icon: Hand, fg: 'text-status-awaiting-manual', bg: 'bg-status-awaiting-manual-bg' },
  cancelled: { label: 'Cancelled', icon: CircleSlash, fg: 'text-status-cancelled', bg: 'bg-status-cancelled-bg' },
  skipped: { label: 'Skipped', icon: CircleDashed, fg: 'text-status-skipped', bg: 'bg-status-skipped-bg' },
}

export function StatusBadge({ status, className, compact }: { status: AnyStatus; className?: string; compact?: boolean }) {
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
  const m = STATUS_META[status]
  const Icon = m.icon
  return (
    <span className={cn('inline-flex', m.fg, className)} title={m.label}>
      <Icon className={cn('size-4', m.spin && 'animate-spin')} aria-hidden />
      <span className="sr-only">{m.label}</span>
    </span>
  )
}
