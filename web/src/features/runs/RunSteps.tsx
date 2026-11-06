import { ChevronRight, Paperclip } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { Device, DeviceCategory, Run, RunCase, RunStep } from '@/api/types'
import { DeviceChip, DeviceIcon } from '@/components/devices'
import { KeyBadge, ManualBadge, StepSummaryText } from '@/components/misc'
import { StatusBadge, StatusIcon } from '@/components/status'
import { categoryWord, deviceLabel, onlyOnWords, sizeLabel } from '@/lib/devices'
import { formatBytes, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FileTile, Thumb } from './media'
import { attachmentItems, casesByDevice, isFailStep, isImage, notRunOn, runDevices, type MediaItem } from './runUtils'

/* ------------------------------------------------------------------ open state */

export function defaultCaseOpen(run: Run, c: RunCase): boolean {
  if (run.cases.length === 1) return true
  if (c.status === 'running') return true
  if (c.status === 'failed' || c.status === 'error' || c.status === 'blocked') return true
  if (run.status === 'awaiting_manual' && run.resume_position === c.position) return true
  return false
}

export const defaultStepOpen = (s: RunStep) => isFailStep(s.status) || s.status === 'blocked'

function hasDetail(s: RunStep) {
  return !!(s.error_message || s.details || s.description || s.expected)
}

/* ------------------------------------------------------------------ list */

export interface CaseListProps {
  run: Run
  caseOpen: Record<string, boolean>
  stepOpen: Record<string, boolean>
  onToggleCase: (id: string, open: boolean) => void
  onToggleStep: (id: string, open: boolean) => void
  shotIndex: Map<string, number>
  screenshots: MediaItem[]
  onOpenScreenshot: (index: number) => void
  onOpenMedia: (items: MediaItem[], index: number) => void
  /** Konten pengganti untuk case manual yang sedang dikerjakan. */
  manualSlot?: { caseId: string; node: React.ReactNode }
}

export function CaseList(p: CaseListProps) {
  const devices = runDevices(p.run)
  if (devices.length <= 1)
    return (
      <div className="divide-y divide-border rounded-md border border-border bg-card">
        {p.run.cases.map((c) => (
          <CaseSection key={c.id} c={c} device={devices[0]} {...p} />
        ))}
      </div>
    )
  // multi-device: one block per device, cases numbered in flow order within the device
  return (
    // flex columns, not grid: grid items keep min-width:auto and wide step details would stretch the page
    <div className="flex min-w-0 flex-col gap-6">
      {casesByDevice(p.run).map((list, di) => (
        <DeviceGroup key={di} device={devices[di]} index={di} cases={list} {...p} />
      ))}
    </div>
  )
}

function DeviceGroup({ device, index, cases, ...p }: CaseListProps & { device: Device; index: number; cases: RunCase[] }) {
  const { t } = useTranslation('runs')
  const headingId = `device-group-${index}`
  const failed = cases.filter((c) => c.status === 'failed' || c.status === 'error').length
  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-2">
      <h2 id={headingId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span className="inline-flex items-center gap-1.5 self-center font-semibold">
          <DeviceIcon category={device.category} className="size-4 text-muted-foreground" />
          <span className="sr-only">{t('steps.deviceGroup', { device: deviceLabel(device) })}</span>
          <span aria-hidden>{device.label === sizeLabel(device) ? sizeLabel(device) : device.label}</span>
        </span>
        {device.label !== sizeLabel(device) && (
          <span className="font-mono text-xs text-muted-foreground tabular" aria-hidden>
            {sizeLabel(device)}
          </span>
        )}
        <span className="text-xs text-muted-foreground tabular">
          {t('steps.deviceCases', { count: cases.length })}
          {failed > 0 && (
            <>
              {' · '}
              <span className="font-medium text-status-failed">{t('list.failedCount', { count: failed })}</span>
            </>
          )}
        </span>
      </h2>
      <div className="divide-y divide-border rounded-md border border-border bg-card">
        {cases.map((c, k) => (
          <CaseSection key={c.id} c={c} device={device} displayNo={k + 1} showDevice {...p} />
        ))}
      </div>
    </section>
  )
}

function CaseSection({
  c,
  device,
  displayNo,
  showDevice,
  run,
  caseOpen,
  onToggleCase,
  manualSlot,
  ...rest
}: CaseListProps & { c: RunCase; device: Device; displayNo?: number; showDevice?: boolean }) {
  const open = caseOpen[c.id] ?? defaultCaseOpen(run, c)
  const bodyId = `case-body-${c.id}`
  const isSlot = manualSlot?.caseId === c.id
  const caseAttachments = c.attachments.filter((a) => !a.run_step_id)
  const { t } = useTranslation('runs')
  const stepLabel = t('steps.progress', {
    done: String(c.steps.filter((s) => s.status !== 'pending' && s.status !== 'running').length),
    count: c.steps.length,
  })

  return (
    <section aria-labelledby={`case-title-${c.id}`} id={`case-${c.id}`} className="scroll-mt-16">
      <h3 id={`case-title-${c.id}`}>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => onToggleCase(c.id, !open)}
          className="flex min-h-10 w-full flex-wrap items-center gap-x-2.5 gap-y-1 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-sm:min-h-11"
        >
          <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')} aria-hidden />
          <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular">{displayNo ?? c.position}</span>
          <KeyBadge>{c.test_case_key}</KeyBadge>
          <span className="min-w-0 flex-1 basis-40 text-sm font-medium sm:truncate">{c.title}</span>
          <span className="flex flex-wrap items-center gap-2.5 max-sm:w-full max-sm:pl-[3.25rem]">
            {showDevice && <DeviceChip device={device} className="max-sm:order-last" />}
            <ManualBadge execution={c.execution} />
            <span className="text-xs whitespace-nowrap text-muted-foreground tabular sm:w-20 sm:text-right">{stepLabel}</span>
            <StatusBadge status={isSlot ? 'awaiting_manual' : c.status} />
            <span className="text-xs text-muted-foreground tabular sm:w-14 sm:text-right">
              {isSlot ? '—' : c.status === 'running' ? '…' : formatDuration(c.duration_ms)}
            </span>
          </span>
        </button>
      </h3>
      {open && (
        <div id={bodyId} className="border-t border-border">
          {isSlot ? (
            manualSlot.node
          ) : (
            <>
              {c.execution === 'manual' && c.executed_by && (
                <p className="px-3 pt-2 text-xs text-muted-foreground">
                  {t('steps.executedBy')} <span className="font-medium text-foreground">{c.executed_by.name}</span>
                </p>
              )}
              <ol className="py-1">
                {c.steps.map((s) =>
                  c.execution === 'manual' ? (
                    <ManualStepReport key={s.id} c={c} s={s} onOpenMedia={rest.onOpenMedia} />
                  ) : (
                    <StepRow key={s.id} s={s} category={device.category} {...rest} />
                  ),
                )}
              </ol>
              {caseAttachments.length > 0 && (
                <div className="border-t border-border px-3 py-2">
                  <AttachmentStrip c={c} list={caseAttachments} onOpenMedia={rest.onOpenMedia} label={t('steps.caseAttachments')} />
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}

/* ------------------------------------------------------------------ step automated */

function StepRow({
  s,
  stepOpen,
  onToggleStep,
  shotIndex,
  screenshots,
  onOpenScreenshot,
  category,
}: Omit<CaseListProps, 'run' | 'caseOpen' | 'onToggleCase' | 'manualSlot' | 'onOpenMedia'> & { s: RunStep; category: DeviceCategory }) {
  const { t } = useTranslation(['runs', 'devices'])
  const notApplicable = notRunOn(s, category)
  const expandable = hasDetail(s)
  const open = expandable && (stepOpen[s.id] ?? defaultStepOpen(s))
  const fail = isFailStep(s.status)
  const idx = s.screenshot ? shotIndex.get(s.screenshot.id) : undefined
  const shot = idx != null ? screenshots[idx] : undefined
  const detailId = `step-detail-${s.id}`
  const showLargeShot = open && fail && !!shot

  const head = (
    <>
      <StatusIcon status={s.status} className="mt-0.5 shrink-0" />
      <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{s.position}</span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
        <span className="shrink-0 font-mono text-xs text-muted-foreground sm:w-28 sm:truncate">{s.action}</span>
        <StepSummaryText text={s.summary} className={cn('text-sm break-words', s.status === 'skipped' && 'text-muted-foreground')} />
        {notApplicable && (
          <span
            className="inline-flex h-5 shrink-0 items-center gap-1 self-start rounded-sm bg-secondary px-1.5 text-xs text-muted-foreground"
            title={t('steps.notRunOnTitle', { list: onlyOnWords(s.only_on) })}
          >
            <DeviceIcon category={category} className="size-3" />
            {t('steps.notRunOn', { category: categoryWord(category) })}
          </span>
        )}
      </span>
    </>
  )

  return (
    <li
      id={`step-${s.id}`}
      aria-current={s.status === 'running' ? 'step' : undefined}
      className={cn('scroll-mt-28', fail && 'bg-status-failed-bg/40')}
    >
      <div className="flex items-start gap-2 px-3 py-1.5">
        {expandable ? (
          <button
            type="button"
            aria-expanded={open}
            aria-controls={detailId}
            onClick={() => onToggleStep(s.id, !open)}
            className="-my-0.5 flex min-w-0 flex-1 items-start gap-2 rounded-sm py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11"
          >
            <ChevronRight
              className={cn('mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none', open && 'rotate-90')}
              aria-hidden
            />
            {head}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-start gap-2">
            <span className="w-4 shrink-0" aria-hidden />
            {head}
          </div>
        )}
        {s.screenshot && !showLargeShot && (shot ? <Thumb item={shot} onOpen={() => onOpenScreenshot(idx!)} className="-my-1" /> : null)}
        <span className="mt-0.5 w-14 shrink-0 text-right text-xs text-muted-foreground tabular">
          {s.status === 'running' ? '…' : s.status === 'skipped' || s.status === 'pending' ? '—' : formatDuration(s.duration_ms)}
        </span>
      </div>
      {open && (
        <div id={detailId}>
          <StepDetail s={s} shot={showLargeShot ? shot : undefined} onOpenShot={() => idx != null && onOpenScreenshot(idx)} />
        </div>
      )}
    </li>
  )
}

interface HttpDetails {
  request: { method?: string; url?: string; headers?: Record<string, string>; body?: unknown }
  response?: { status?: number; time_ms?: number; body?: unknown }
}

function StepDetail({ s, shot, onOpenShot }: { s: RunStep; shot?: MediaItem; onOpenShot: () => void }) {
  const d = s.details
  const ea = d && 'expected' in d && 'actual' in d ? { expected: String(d.expected ?? ''), actual: String(d.actual ?? '') } : null
  const http = d && 'request' in d ? (d as unknown as HttpDetails) : null
  const offenders = d && Array.isArray((d as { offenders?: unknown }).offenders) ? ((d as { offenders: unknown[] }).offenders.map(String)) : null
  const fail = isFailStep(s.status)
  const { t } = useTranslation('runs')

  return (
    <div
      className={cn(
        'mr-3 mb-3 ml-3 grid gap-3 border-l-2 pl-3 sm:ml-[3.75rem]',
        fail ? 'border-status-failed' : 'border-border',
        shot && 'lg:grid-cols-[minmax(0,1fr)_auto]',
      )}
    >
      <div className="grid min-w-0 content-start gap-3">
        {ea && (
          <div className="grid gap-2 sm:grid-cols-2">
            <ValueBox label={t('steps.expected')} value={ea.expected} />
            <ValueBox label={t('steps.actual')} value={ea.actual} tone={fail ? 'failed' : undefined} />
          </div>
        )}
        {offenders && offenders.length > 0 && <Offenders list={offenders} expected={ea?.expected} />}
        {s.error_message && (
          <pre className="font-mono text-xs leading-5 break-words whitespace-pre-wrap text-status-failed">{s.error_message}</pre>
        )}
        {http && <HttpDetail http={http} />}
        {(s.description || s.expected) && (
          <dl className="grid gap-1 text-xs">
            {s.description && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">{t('steps.description')}</dt>
                <dd className="min-w-0">{s.description}</dd>
              </div>
            )}
            {s.expected && (
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-muted-foreground">{t('steps.expected')}</dt>
                <dd className="min-w-0">{s.expected}</dd>
              </div>
            )}
          </dl>
        )}
      </div>
      {shot && <Thumb item={shot} size="lg" onOpen={onOpenShot} />}
    </div>
  )
}

/**
 * `expect_no_horizontal_scroll` offenders: "tag#id.class (right edge 452px)" → selector + edge, plus how far
 * past the viewport ("+59") when the expected text carries the viewport width ("content width ≤ 393px").
 */
function Offenders({ list, expected }: { list: string[]; expected?: string }) {
  const { t } = useTranslation('runs')
  const client = Number(/≤\s*(\d+)\s*px/.exec(expected ?? '')?.[1] ?? NaN)
  return (
    <div className="grid min-w-0 gap-1">
      <span className="text-xs font-medium text-muted-foreground">{t('steps.overflow')}</span>
      <ol className="grid min-w-0 divide-y divide-border rounded-sm border border-border bg-background">
        {list.map((raw, i) => {
          const m = /^(.*) \(right edge (\d+)px\)$/.exec(raw)
          const edge = m ? Number(m[2]) : null
          return (
            <li key={i} className="flex min-w-0 items-baseline gap-3 px-2 py-1 font-mono text-xs">
              <span className="min-w-0 flex-1 break-all">{m ? m[1] : raw}</span>
              {edge != null && (
                <span className="shrink-0 text-muted-foreground tabular">
                  {edge}px
                  {Number.isFinite(client) && edge > client && <span className="ml-1.5 font-medium text-status-failed">+{edge - client}</span>}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

function ValueBox({ label, value, tone }: { label: string; value: string; tone?: 'failed' }) {
  return (
    <div className="grid min-w-0 content-start gap-1">
      <span className={cn('text-xs font-medium', tone === 'failed' ? 'text-status-failed' : 'text-muted-foreground')}>{label}</span>
      <pre className="min-h-8 rounded-sm border border-border bg-background px-2 py-1.5 font-mono text-xs break-all whitespace-pre-wrap">{value || '—'}</pre>
    </div>
  )
}

function HttpDetail({ http }: { http: HttpDetails }) {
  const { request, response } = http
  const st = response?.status
  const { t } = useTranslation('runs')
  return (
    <div className="grid gap-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs">
        <span className="font-semibold">{request.method ?? 'GET'}</span>
        <span className="break-all">{request.url}</span>
        {st != null && (
          <span className={cn('font-medium', st >= 400 ? 'text-status-failed' : 'text-status-passed')}>
            → {st}
          </span>
        )}
        {response?.time_ms != null && <span className="text-muted-foreground">{response.time_ms} ms</span>}
      </p>
      {request.body !== undefined && <JsonBlock label={t('steps.requestBody')} value={request.body} />}
      {response?.body !== undefined && <JsonBlock label={t('steps.responseBody')} value={response.body} defaultOpen />}
    </div>
  )
}

function JsonBlock({ label, value, defaultOpen }: { label: string; value: unknown; defaultOpen?: boolean }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <details open={defaultOpen} className="group rounded-sm border border-border">
      <summary className="flex h-7 cursor-pointer list-none items-center gap-1.5 px-2 text-xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-3.5 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
        {label}
      </summary>
      <pre className="max-h-72 overflow-auto border-t border-border bg-muted px-2 py-1.5 font-mono text-xs leading-5">{text}</pre>
    </details>
  )
}

/* ------------------------------------------------------------------ step manual (report) */

function ManualStepReport({ c, s, onOpenMedia }: { c: RunCase; s: RunStep; onOpenMedia: CaseListProps['onOpenMedia'] }) {
  const atts = c.attachments.filter((a) => a.run_step_id === s.id)
  const bad = s.status === 'failed' || s.status === 'blocked'
  const { t } = useTranslation('runs')
  return (
    <li id={`step-${s.id}`} className={cn('flex scroll-mt-28 items-start gap-2 px-3 py-2', bad && 'bg-status-failed-bg/40')}>
      <span className="w-4 shrink-0" aria-hidden />
      <StatusIcon status={s.status} className="mt-0.5 shrink-0" />
      <span className="mt-0.5 w-5 shrink-0 text-right text-xs text-muted-foreground tabular">{s.position}</span>
      <div className="grid min-w-0 flex-1 gap-1">
        <p className="text-sm break-words">{s.description || s.summary}</p>
        {s.expected && (
          <p className="text-xs text-muted-foreground">
            <span className="font-medium">{t('steps.expectedColon')}</span> {s.expected}
          </p>
        )}
        {s.actual_result && (
          <p className={cn('text-xs break-words whitespace-pre-wrap', bad ? 'text-status-failed' : 'text-foreground')}>
            <span className="font-medium">{t('steps.actualColon')}</span> {s.actual_result}
          </p>
        )}
        {atts.length > 0 && <AttachmentStrip c={c} list={atts} onOpenMedia={onOpenMedia} />}
      </div>
    </li>
  )
}

export function AttachmentStrip({ c, list, onOpenMedia, label }: { c: RunCase; list: RunCase['attachments']; onOpenMedia: CaseListProps['onOpenMedia']; label?: string }) {
  const images = attachmentItems(c, list)
  const { t } = useTranslation('runs')
  return (
    <div className="grid gap-1.5">
      {label && (
        <p className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
          <Paperclip className="size-3.5" aria-hidden /> {label}
        </p>
      )}
      <ul className="flex flex-wrap gap-2" aria-label={label ?? t('steps.attachments')}>
        {list.map((a) => {
          const i = images.findIndex((m) => m.id === a.id)
          return (
            <li key={a.id}>
              {isImage(a) ? (
                <Thumb item={images[i]} onOpen={() => onOpenMedia(images, i)} className="h-12 w-20" />
              ) : (
                <FileTile name={a.name} url={a.url} mime={a.mime} sizeLabel={formatBytes(a.size_bytes)} />
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
