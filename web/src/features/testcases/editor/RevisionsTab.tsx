import { FileClock, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRevision, useRevisions } from '@/api/queries'
import type { Step, TestCaseInput } from '@/api/types'
import { StepSummaryText } from '@/components/misc'
import { EmptyState, ErrorState } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { summarizeStep } from '@/lib/steps'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { actionIcon, diffMeta, diffSteps, stableStringify, type Draft, type StepDiff } from '../lib'

export function RevisionsTab({
  caseKey,
  draft,
  currentRevision,
  dirty,
  readOnly,
  onRestore,
}: {
  caseKey: string
  draft: Draft
  currentRevision: number
  dirty: boolean
  readOnly: boolean
  onRestore: (snapshot: TestCaseInput, rev: number) => void
}) {
  const list = useRevisions(caseKey)
  const [picked, setPicked] = React.useState<number | null>(null)
  const revs = list.data?.data ?? []
  const selected = picked ?? revs[0]?.revision ?? null
  const rev = useRevision(caseKey, selected)
  const [view, setView] = React.useState<'diff' | 'snapshot'>('diff')
  const { t } = useTranslation('testcases')

  if (list.isError) return <ErrorState error={list.error} onRetry={() => list.refetch()} />
  if (list.isPending) return <Skeleton className="h-64" />
  if (!revs.length) return <EmptyState icon={FileClock} title={t('revisions.empty')} />

  const against = dirty ? t('revisions.againstDraft') : t('revisions.againstCurrent', { revision: String(currentRevision) })

  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <nav aria-label={t('revisions.listLabel')} className="lg:sticky lg:top-40 lg:self-start">
        <ol className="flex flex-col overflow-hidden rounded-md border border-border">
          {revs.map((r) => {
            const active = r.revision === selected
            return (
              <li key={r.revision} className="border-b border-border last:border-0">
                <button
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  onClick={() => setPicked(r.revision)}
                  className={cn(
                    'flex w-full flex-col gap-0.5 px-3 py-2 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset',
                    active && 'bg-accent hover:bg-accent',
                  )}
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="font-medium tabular">{t('revisions.revisionN', { revision: String(r.revision) })}</span>
                    {r.revision === currentRevision && <span className="rounded-sm bg-secondary px-1.5 text-xs text-muted-foreground">{t('revisions.current')}</span>}
                  </span>
                  <span className="line-clamp-2 text-xs text-foreground/80">{r.change_note || t('revisions.noNote')}</span>
                  <span className="text-xs text-muted-foreground">
                    {r.author.name} · <time dateTime={r.created_at} title={formatDateTime(r.created_at)}>{formatRelative(r.created_at)}</time>
                  </span>
                </button>
              </li>
            )
          })}
        </ol>
      </nav>

      <section aria-label={selected ? t('revisions.revisionN', { revision: String(selected) }) : t('editor.tabs.revisions')} className="flex min-w-0 flex-col gap-4">
        {rev.isError ? (
          <ErrorState error={rev.error} onRetry={() => rev.refetch()} />
        ) : !rev.data ? (
          <Skeleton className="h-64" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="min-w-0">
                <h2 className="text-lg font-semibold">{t('revisions.revisionN', { revision: String(rev.data.revision) })}</h2>
                <p className="text-xs text-muted-foreground">
                  {rev.data.author.name} · {formatDateTime(rev.data.created_at)} · {rev.data.change_note || t('revisions.noNote')}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Segmented
                  ariaLabel={t('revisions.viewLabel')}
                  value={view}
                  onChange={setView}
                  options={[
                    { value: 'diff', label: t('revisions.diff') },
                    { value: 'snapshot', label: t('revisions.snapshot') },
                  ]}
                />
                {!readOnly && (
                  <Button
                    variant="outline"
                    disabled={stableStringify(rev.data.snapshot.steps) === stableStringify(draft.steps) && diffMeta(rev.data.snapshot, draft).length === 0}
                    onClick={() => onRestore(rev.data.snapshot, rev.data.revision)}
                  >
                    <RotateCcw /> {t('revisions.restore')}
                  </Button>
                )}
              </div>
            </div>
            {view === 'diff' ? <DiffView snapshot={rev.data.snapshot} draft={draft} against={against} /> : <SnapshotView snapshot={rev.data.snapshot} />}
          </>
        )}
      </section>
    </div>
  )
}

function DiffView({ snapshot, draft, against }: { snapshot: TestCaseInput; draft: Draft; against: string }) {
  const meta = diffMeta(snapshot, draft)
  const steps = diffSteps(snapshot.steps, draft.steps)
  const changed = steps.filter((d) => d.kind !== 'same')
  const { t } = useTranslation('testcases')
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t('revisions.comparedWith', { against })}{' '}
        {meta.length === 0 && changed.length === 0
          ? t('revisions.noDiff')
          : t('revisions.diffSummary', { fields: t('revisions.infoFields', { count: meta.length }), count: changed.length })}
      </p>
      {meta.length > 0 && (
        <table className="w-full border-collapse rounded-md border border-border text-sm">
          <caption className="sr-only">{t('revisions.infoDiffCaption')}</caption>
          <thead>
            <tr className="h-8 border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" className="w-32 px-3 font-medium">{t('revisions.columns.field')}</th>
              <th scope="col" className="px-3 font-medium">{t('revisions.columns.thisRevision')}</th>
              <th scope="col" className="px-3 font-medium">{t('revisions.columns.now')}</th>
            </tr>
          </thead>
          <tbody>
            {meta.map((m) => (
              <tr key={m.label} className="border-b border-border align-top last:border-0">
                <td className="px-3 py-2 text-muted-foreground">{m.label}</td>
                <td className="px-3 py-2 break-words whitespace-pre-wrap text-status-failed line-through decoration-status-failed/50">{m.before}</td>
                <td className="px-3 py-2 break-words whitespace-pre-wrap text-status-passed">{m.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <ol className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={t('revisions.stepDiffLabel')}>
        {steps.map((d) => (
          <DiffRow key={`${d.kind}-${d.id}`} d={d} />
        ))}
        {steps.length === 0 && <li className="px-3 py-3 text-sm text-muted-foreground">{t('revisions.bothEmpty')}</li>}
      </ol>
    </div>
  )
}

const KIND_META: Record<StepDiff['kind'], { sign: string; cls: string }> = {
  added: { sign: '+', cls: 'text-status-passed' },
  removed: { sign: '−', cls: 'text-status-failed' },
  changed: { sign: '~', cls: 'text-status-blocked' },
  moved: { sign: '↕', cls: 'text-status-running' },
  same: { sign: '', cls: 'text-muted-foreground' },
}

function show(v: unknown): string {
  if (v === undefined) return '—'
  return typeof v === 'string' ? v : stableStringify(v)
}

function DiffRow({ d }: { d: StepDiff }) {
  const m = KIND_META[d.kind]
  const { t } = useTranslation('testcases')
  const Icon = actionIcon(d.step.action)
  const pos = d.kind === 'removed' ? `${d.from + 1}` : d.kind === 'added' ? `${d.to + 1}` : d.from === d.to ? `${d.to + 1}` : `${d.from + 1}→${d.to + 1}`
  return (
    <li className={cn('flex flex-col gap-1 px-3 py-1.5', d.kind === 'same' && 'opacity-70', d.kind === 'removed' && 'bg-status-failed-bg/40', d.kind === 'added' && 'bg-status-passed-bg/40')}>
      <div className="flex min-h-6 items-center gap-2 text-sm">
        <span className={cn('w-4 shrink-0 text-center font-mono font-medium', m.cls)} aria-hidden>
          {m.sign}
        </span>
        <span className="sr-only">{t(`revisions.kind.${d.kind}`)}:</span>
        <span className="w-8 shrink-0 text-right text-xs tabular text-muted-foreground">{pos}</span>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="hidden w-28 shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline">{d.step.action}</span>
        <StepSummaryText text={summarizeStep(d.step)} className={cn('min-w-0 flex-1 truncate', d.kind === 'removed' && 'line-through')} />
      </div>
      {d.kind === 'changed' && (
        <dl className="ml-16 grid grid-cols-[8rem_minmax(0,1fr)] gap-x-3 gap-y-0.5 pb-1 text-xs">
          {d.fields.map((f) => (
            <React.Fragment key={f.name}>
              <dt className="font-mono text-muted-foreground">{f.name}</dt>
              <dd className="font-mono break-all">
                <span className="text-status-failed line-through decoration-status-failed/50">{show(f.before)}</span>
                <span className="mx-1.5 text-muted-foreground" aria-hidden>
                  →
                </span>
                <span className="sr-only"> {t('revisions.becomes')} </span>
                <span className="text-status-passed">{show(f.after)}</span>
              </dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </li>
  )
}

function SnapshotView({ snapshot }: { snapshot: TestCaseInput }) {
  const { t } = useTranslation('testcases')
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t('fields.title')}</dt>
        <dd>{snapshot.title}</dd>
        <dt className="text-muted-foreground">{t('revisions.priorityStatus')}</dt>
        <dd>
          {snapshot.priority ?? '—'} · {snapshot.status ?? '—'} · {snapshot.execution ?? 'automated'}
        </dd>
        <dt className="text-muted-foreground">{t('fields.tags')}</dt>
        <dd>{snapshot.tags?.join(', ') || '—'}</dd>
        {snapshot.description ? (
          <>
            <dt className="text-muted-foreground">{t('fields.description')}</dt>
            <dd className="whitespace-pre-wrap">{snapshot.description}</dd>
          </>
        ) : null}
      </dl>
      <ReadOnlySteps steps={snapshot.steps} />
    </div>
  )
}

function ReadOnlySteps({ steps }: { steps: Step[] }) {
  const { t } = useTranslation('testcases')
  if (!steps.length) return <p className="text-sm text-muted-foreground">{t('revisions.noSteps')}</p>
  return (
    <ol className="flex flex-col divide-y divide-border rounded-md border border-border" aria-label={t('revisions.stepsLabel')}>
      {steps.map((s, i) => {
        const Icon = actionIcon(s.action)
        return (
          <li key={s.id} className={cn('flex min-h-9 items-center gap-2 px-3 py-1.5 text-sm', s.enabled === false && 'opacity-60')}>
            <span className="w-5 shrink-0 text-right text-xs tabular text-muted-foreground">{i + 1}</span>
            <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="hidden w-28 shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline">{s.action}</span>
            <StepSummaryText text={summarizeStep(s)} className="min-w-0 flex-1 truncate" />
            {s.enabled === false && <span className="rounded-sm bg-secondary px-1.5 text-xs text-muted-foreground">{t('stepList.disabledBadge')}</span>}
          </li>
        )
      })}
    </ol>
  )
}
