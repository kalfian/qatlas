import { Check, Copy, SignalHigh, SignalLow, SignalMedium, TriangleAlert, Hand } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import type { Execution, Priority, TestCaseStatus } from '@/api/types'
import { Button } from '@/components/ui/button'
import { i18n } from '@/i18n'
import { lazyLabels } from '@/lib/i18n-labels'
import { cn } from '@/lib/utils'

export function KeyBadge({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={cn('inline-flex h-5 items-center rounded-sm bg-secondary px-1.5 font-mono text-xs font-medium text-secondary-foreground', className)}>
      {children}
    </span>
  )
}

export function TagChip({ tag, onRemove }: { tag: string; onRemove?: () => void }) {
  const { t } = useTranslation()
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground">
      {tag}
      {onRemove && (
        <button type="button" onClick={onRemove} className="text-muted-foreground hover:text-foreground" aria-label={t('a11y.removeTag', { tag })}>
          ×
        </button>
      )}
    </span>
  )
}

/** Label priority (`common:priority.*`, tetap Inggris di kedua bahasa). */
export const PRIORITY_LABELS: Record<Priority, string> = lazyLabels(['critical', 'high', 'medium', 'low'] as const, (p) => `common:priority.${p}`)

export function PriorityLabel({ priority }: { priority: Priority }) {
  useTranslation()
  const Icon = priority === 'critical' ? TriangleAlert : priority === 'high' ? SignalHigh : priority === 'medium' ? SignalMedium : SignalLow
  const strong = priority === 'critical' || priority === 'high'
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs', strong ? 'font-medium text-foreground' : 'text-muted-foreground')}>
      <Icon className={cn('size-3.5', priority === 'critical' && 'text-status-failed')} aria-hidden />
      {PRIORITY_LABELS[priority]}
    </span>
  )
}

/** Label status test case (`common:testCaseStatus.*`). */
export const TC_STATUS_LABELS: Record<TestCaseStatus, string> = lazyLabels(['draft', 'ready', 'deprecated'] as const, (s) => `common:testCaseStatus.${s}`)

export function TestCaseStatusLabel({ status }: { status: TestCaseStatus }) {
  useTranslation()
  return (
    <span className={cn('text-xs', status === 'ready' ? 'text-foreground' : 'text-muted-foreground', status === 'deprecated' && 'line-through')}>
      {TC_STATUS_LABELS[status]}
    </span>
  )
}

export function ManualBadge({ execution, className }: { execution: Execution; className?: string }) {
  const { t } = useTranslation()
  if (execution !== 'manual') return null
  return (
    <span className={cn('inline-flex h-5 items-center gap-1 rounded-sm bg-status-awaiting-manual-bg px-1.5 text-xs font-medium text-status-awaiting-manual', className)}>
      <Hand className="size-3" aria-hidden /> {t('execution.manual')}
    </span>
  )
}

export function useCopy(timeout = 2000) {
  const [copied, setCopied] = React.useState(false)
  const copy = React.useCallback(
    async (text: string, message: string = i18n.t('common:toast.copied')) => {
      try {
        await navigator.clipboard.writeText(text)
      } catch {
        // fallback untuk konteks non-secure (akses via IP tanpa HTTPS)
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        ta.remove()
      }
      setCopied(true)
      toast.success(message)
      setTimeout(() => setCopied(false), timeout)
    },
    [timeout],
  )
  return { copied, copy }
}

export function CopyButton({ value, label, className, size = 'sm', variant = 'outline' }: {
  value: string
  label?: string
  className?: string
  size?: 'sm' | 'default'
  variant?: 'outline' | 'ghost' | 'default'
}) {
  const { t } = useTranslation()
  const { copied, copy } = useCopy()
  return (
    <Button type="button" size={size} variant={variant} className={className} onClick={() => copy(value)}>
      {copied ? <Check /> : <Copy />}
      {copied ? t('actions.copied') : (label ?? t('actions.copy'))}
    </Button>
  )
}

export function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return <code className={cn('rounded-sm bg-muted px-1 py-px font-mono text-[12px]', className)}>{children}</code>
}

/** Ringkasan step: bagian dalam backtick/kutip ditampilkan mono. */
export function StepSummaryText({ text, className }: { text: string; className?: string }) {
  const parts = text.split(/("[^"]*")/g)
  return (
    <span className={cn('min-w-0', className)}>
      {parts.map((p, i) =>
        p.startsWith('"') && p.endsWith('"') && p.length > 1 ? (
          <code key={i} className="font-mono text-[12px]">
            {p}
          </code>
        ) : (
          <React.Fragment key={i}>{renderSelectors(p)}</React.Fragment>
        ),
      )}
    </span>
  )
}

function renderSelectors(text: string): React.ReactNode {
  // tampilkan token yang terlihat seperti selector/url/variable dalam mono
  const re = /((?:role|label|text|testid|placeholder|xpath)=\S+(?:\[[^\]]*\])?|\{\{[^}]+\}\}\S*|[#.][\w-]+(?:\s[\w#.-]+)*|https?:\/\/\S+|\/[\w/-]+)/g
  const out: React.ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index))
    out.push(
      <code key={m.index} className="font-mono text-[12px]">
        {m[0]}
      </code>,
    )
    last = m.index! + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}
