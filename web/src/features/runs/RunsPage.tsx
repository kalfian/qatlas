import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Check, ChevronDown, FlaskConical, History, Search, SearchX, Workflow, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useRuns, type RunFilters } from '@/api/queries'
import type { RunKind, RunStatus, RunSummary, RunTrigger } from '@/api/types'
import type { RunsSearch } from '@/app/router'
import { useCan } from '@/app/auth'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { StatusBadge, StatusIcon, STATUS_META } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDate, formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useDelayedFlag } from './hooks'
import { kindLabel, RUN_STATUS_ORDER, triggerLabel } from './runUtils'

const TRIGGERS: RunTrigger[] = ['manual', 'mcp', 'api', 'schedule']
const KINDS: RunKind[] = ['test_case', 'flow']

export function RunsPage() {
  const { key } = useParams({ from: '/_app/p/$key/runs' })
  const search = useSearch({ from: '/_app/p/$key/runs' })
  const navigate = useNavigate({ from: '/p/$key/runs' })
  const canRun = useCan('run', key)
  const { t } = useTranslation(['runs', 'common'])

  const filters: RunFilters = {
    status: search.status,
    kind: search.kind,
    trigger: search.trigger,
    target: search.target,
    from: search.from,
    to: search.to,
  }
  const active = Object.values(filters).some(Boolean)
  const runs = useRuns(key, filters)
  const showSkeleton = useDelayedFlag(runs.isPending)

  const setSearch = (patch: Partial<RunsSearch>, replace = false) => navigate({ search: (prev: RunsSearch) => ({ ...prev, ...patch }), replace })
  const reset = () => navigate({ search: {} })

  /* ---------- search target (debounce ke URL) */
  const [targetText, setTargetText] = React.useState(search.target ?? '')
  const [syncedTarget, setSyncedTarget] = React.useState(search.target)
  if (search.target !== syncedTarget) {
    setSyncedTarget(search.target)
    setTargetText(search.target ?? '')
  }
  React.useEffect(() => {
    const v = targetText.trim().toUpperCase() || undefined
    if (v === search.target) return
    const timer = setTimeout(() => setSearch({ target: v }, true), 300)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetText])

  const rows = runs.data?.data ?? []

  const chips: { label: React.ReactNode; clear: () => void; id: string; name: string }[] = []
  if (search.status)
    chips.push({ id: 'status', name: t('list.filters.status'), label: <>{t('list.filters.status')}: {STATUS_META[search.status].label}</>, clear: () => setSearch({ status: undefined }) })
  if (search.kind)
    chips.push({ id: 'kind', name: t('list.filters.kind'), label: <>{t('list.filters.kind')}: {kindLabel(search.kind)}</>, clear: () => setSearch({ kind: undefined }) })
  if (search.trigger)
    chips.push({ id: 'trigger', name: t('list.filters.trigger'), label: <>{t('list.filters.trigger')}: {triggerLabel(search.trigger)}</>, clear: () => setSearch({ trigger: undefined }) })
  if (search.target)
    chips.push({
      id: 'target',
      name: t('list.filters.target'),
      label: (
        <>
          {t('list.filters.target')}: <span className="font-mono">{search.target}</span>
        </>
      ),
      clear: () => setSearch({ target: undefined }),
    })
  if (search.from)
    chips.push({ id: 'from', name: t('list.filters.fromName'), label: <>{t('list.filters.fromChip', { date: formatDate(search.from) })}</>, clear: () => setSearch({ from: undefined }) })
  if (search.to)
    chips.push({ id: 'to', name: t('list.filters.toName'), label: <>{t('list.filters.toChip', { date: formatDate(search.to) })}</>, clear: () => setSearch({ to: undefined }) })

  const dateInvalid = !!(search.from && search.to && search.from > search.to)

  return (
    <PageContainer>
      <PageHeader title={t('list.title')} description={t('list.description')} />

      <div className="grid gap-2">
        <div className="flex flex-wrap items-end gap-2">
          <div className="relative w-full sm:w-56">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              value={targetText}
              onChange={(e) => setTargetText(e.target.value)}
              placeholder={t('list.targetPlaceholder')}
              aria-label={t('list.targetLabel')}
              className="pl-8 font-mono placeholder:font-sans max-sm:h-11"
              spellCheck={false}
            />
          </div>
          <FilterMenu
            label={t('list.filters.status')}
            value={search.status}
            onChange={(v) => setSearch({ status: v as RunStatus | undefined })}
            options={RUN_STATUS_ORDER.map((s) => ({ value: s, label: STATUS_META[s].label, icon: <StatusIcon status={s} /> }))}
          />
          <FilterMenu
            label={t('list.filters.kind')}
            value={search.kind}
            onChange={(v) => setSearch({ kind: v as RunKind | undefined })}
            options={KINDS.map((k) => ({ value: k, label: kindLabel(k), icon: k === 'flow' ? <Workflow /> : <FlaskConical /> }))}
          />
          <FilterMenu
            label={t('list.filters.trigger')}
            value={search.trigger}
            onChange={(v) => setSearch({ trigger: v as RunTrigger | undefined })}
            options={TRIGGERS.map((tr) => ({ value: tr, label: triggerLabel(tr) }))}
          />
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-2 max-sm:w-full">
            <span className="flex items-center gap-1.5 max-sm:w-full">
              <Label htmlFor="runs-from" className="text-xs text-muted-foreground max-sm:w-12">
                {t('list.filters.from')}
              </Label>
              <Input
                id="runs-from"
                type="date"
                value={search.from ?? ''}
                max={search.to}
                onChange={(e) => setSearch({ from: e.target.value || undefined })}
                className="w-36 tabular max-sm:h-11 max-sm:flex-1"
                aria-invalid={dateInvalid || undefined}
                aria-describedby={dateInvalid ? 'runs-date-err' : undefined}
              />
            </span>
            <span className="flex items-center gap-1.5 max-sm:w-full">
              <Label htmlFor="runs-to" className="text-xs text-muted-foreground max-sm:w-12">
                {t('list.filters.to')}
              </Label>
              <Input
                id="runs-to"
                type="date"
                value={search.to ?? ''}
                min={search.from}
                onChange={(e) => setSearch({ to: e.target.value || undefined })}
                className="w-36 tabular max-sm:h-11 max-sm:flex-1"
                aria-invalid={dateInvalid || undefined}
                aria-describedby={dateInvalid ? 'runs-date-err' : undefined}
              />
            </span>
          </div>
        </div>

        {chips.length > 0 && (
          <ul className="flex flex-wrap items-center gap-1.5" aria-label={t('list.activeFilters')}>
            {chips.map((c) => (
              <li key={c.id}>
                <span className="inline-flex h-6 items-center gap-1 rounded-sm bg-secondary pr-0.5 pl-2 text-xs text-secondary-foreground">
                  {c.label}
                  <button
                    type="button"
                    onClick={c.clear}
                    className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:size-8"
                    aria-label={t('list.removeFilter', { name: c.name })}
                  >
                    <X className="size-3" aria-hidden />
                  </button>
                </span>
              </li>
            ))}
            <li>
              <Button variant="ghost" size="sm" onClick={reset}>
                {t('common:actions.reset')}
              </Button>
            </li>
          </ul>
        )}
        {dateInvalid && (
          <p id="runs-date-err" className="text-xs text-status-failed">
            {t('list.dateInvalid')}
          </p>
        )}
      </div>

      {runs.isError && !runs.data ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : runs.isPending ? (
        showSkeleton ? (
          <TableSkeleton />
        ) : (
          <div className="min-h-80" aria-busy="true" />
        )
      ) : rows.length === 0 ? (
        active ? (
          <EmptyState
            icon={SearchX}
            title={t('list.emptyFilteredTitle')}
            description={t('list.emptyFilteredDescription')}
            action={
              <Button variant="outline" onClick={reset}>
                {t('list.resetFilters')}
              </Button>
            }
          />
        ) : (
          <EmptyState
            icon={History}
            title={t('list.emptyTitle')}
            description={canRun ? t('list.emptyDescription') : t('list.emptyDescriptionReadOnly')}
            action={
              canRun ? (
                <Button asChild>
                  <Link to="/p/$key/tests" params={{ key }}>
                    {t('list.openTestCases')}
                  </Link>
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div
          className={cn('grid gap-2 transition-opacity duration-150', runs.isPlaceholderData && 'opacity-60')}
          aria-busy={runs.isFetching && runs.isPlaceholderData}
        >
          <RunsTable rows={rows} projectKey={key} />
          {runs.data?.next_cursor && (
            <p className="text-xs text-muted-foreground">{t('list.truncated', { count: rows.length })}</p>
          )}
        </div>
      )}
    </PageContainer>
  )
}

/* ------------------------------------------------------------------ filter menu */

function FilterMenu({
  label,
  value,
  onChange,
  options,
}: {
  label: string
  value: string | undefined
  onChange: (v: string | undefined) => void
  options: { value: string; label: string; icon?: React.ReactNode }[]
}) {
  const current = options.find((o) => o.value === value)
  const { t } = useTranslation('common')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className={cn('max-sm:h-11', current && 'border-foreground/40')}>
          {label}
          {current && (
            <>
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
              <span className="font-normal">{current.label}</span>
            </>
          )}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuRadioGroup value={value ?? ''} onValueChange={(v) => onChange(v || undefined)}>
          <DropdownMenuRadioItem value="">{t('states.all')}</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {options.map((o) => (
            <DropdownMenuRadioItem key={o.value} value={o.value}>
              {o.icon}
              {o.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ tabel */

function CaseSummary({ r }: { r: RunSummary }) {
  const { t } = useTranslation('runs')
  const c = r.summary.cases
  if (!c.total) return <span className="text-muted-foreground">—</span>
  const bad = c.failed + c.blocked
  return (
    <span className="inline-flex items-center gap-1.5 text-xs tabular">
      <span>
        {c.passed}/{c.total}
      </span>
      {bad > 0 && (
        <span className="inline-flex items-center gap-0.5 font-medium text-status-failed">
          <span aria-hidden>·</span> {t('list.failedCount', { count: bad })}
        </span>
      )}
      {bad === 0 && c.passed === c.total && <Check className="size-3.5 text-status-passed" aria-label={t('list.allPassed')} />}
    </span>
  )
}

function RunsTable({ rows, projectKey }: { rows: RunSummary[]; projectKey: string }) {
  const navigate = useNavigate()
  const { t } = useTranslation('runs')
  const go = (r: RunSummary) => navigate({ to: '/p/$key/runs/$runKey', params: { key: projectKey, runKey: r.key } })

  return (
    <>
      <ul className="divide-y divide-border rounded-md border border-border sm:hidden" aria-label={t('list.listLabel')}>
        {rows.map((r) => (
          <li key={r.id}>
            <Link
              to="/p/$key/runs/$runKey"
              params={{ key: projectKey, runKey: r.key }}
              className="grid gap-1 px-3 py-2.5 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <span className="flex items-center gap-2">
                <span className="font-mono text-xs font-medium text-link">{r.key}</span>
                <StatusBadge status={r.status} />
                <span className="ml-auto text-xs text-muted-foreground tabular">{formatDuration(r.duration_ms)}</span>
              </span>
              <span className="flex min-w-0 items-center gap-2 text-sm">
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.target.key}</span>
                <span className="truncate">{r.target.title}</span>
              </span>
              <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                <time dateTime={r.queued_at}>{formatRelative(r.started_at ?? r.queued_at)}</time>
                <span aria-hidden>·</span>
                <span className={cn(r.trigger === 'mcp' && 'font-medium text-foreground')}>{triggerLabel(r.trigger)}</span>
                <span aria-hidden>·</span>
                <span>{r.triggered_by.name}</span>
                <span aria-hidden>·</span>
                <CaseSummary r={r} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="min-w-0 rounded-md border border-border max-sm:hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('list.columns.run')}</TableHead>
              <TableHead>{t('list.columns.target')}</TableHead>
              <TableHead>{t('list.columns.status')}</TableHead>
              <TableHead className="max-md:hidden">{t('list.columns.trigger')}</TableHead>
              <TableHead className="max-lg:hidden">{t('list.columns.environment')}</TableHead>
              <TableHead className="max-lg:hidden">{t('list.columns.by')}</TableHead>
              <TableHead>{t('list.columns.started')}</TableHead>
              <TableHead className="text-right">{t('list.columns.duration')}</TableHead>
              <TableHead className="max-md:hidden">{t('list.columns.cases')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow
                key={r.id}
                className="cursor-pointer hover:bg-muted/50"
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a, button')) return
                  go(r)
                }}
              >
                <TableCell className="whitespace-nowrap">
                  <Link
                    to="/p/$key/runs/$runKey"
                    params={{ key: projectKey, runKey: r.key }}
                    className="rounded-sm font-mono text-xs font-medium text-link hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {r.key}
                  </Link>
                </TableCell>
                <TableCell className="w-full max-w-0 min-w-44">
                  <span className="flex min-w-0 items-center gap-2">
                    {r.kind === 'flow' ? (
                      <Workflow className="size-3.5 shrink-0 text-muted-foreground" aria-label={kindLabel('flow')} />
                    ) : (
                      <FlaskConical className="size-3.5 shrink-0 text-muted-foreground" aria-label={kindLabel('test_case')} />
                    )}
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">{r.target.key}</span>
                    <span className="truncate" title={r.target.title}>
                      {r.target.title}
                    </span>
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground max-md:hidden">
                  {r.trigger === 'mcp' ? <span className="font-medium text-foreground">{triggerLabel(r.trigger)}</span> : triggerLabel(r.trigger)}
                </TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground max-lg:hidden">{r.environment?.name ?? '—'}</TableCell>
                <TableCell className="whitespace-nowrap max-lg:hidden">{r.triggered_by.name}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">
                  <time dateTime={r.queued_at} title={formatDateTime(r.queued_at)}>
                    {formatRelative(r.started_at ?? r.queued_at)}
                  </time>
                </TableCell>
                <TableCell className="text-right whitespace-nowrap text-muted-foreground">
                  {r.status === 'running' || r.status === 'queued' ? (
                    <span className="text-status-running">{formatDuration(r.duration_ms)}</span>
                  ) : (
                    formatDuration(r.duration_ms)
                  )}
                </TableCell>
                <TableCell className="whitespace-nowrap max-md:hidden">
                  <CaseSummary r={r} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </>
  )
}

function TableSkeleton() {
  const { t } = useTranslation('runs')
  return (
    <div className="rounded-md border border-border" aria-busy="true" aria-label={t('list.loading')}>
      <div className="h-8 border-b border-border" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-4 border-b border-border px-3 last:border-0">
          <Skeleton className="h-3.5 w-20" />
          <Skeleton className="h-3.5 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-3.5 w-24 max-md:hidden" />
          <Skeleton className="h-3.5 w-14" />
        </div>
      ))}
    </div>
  )
}
