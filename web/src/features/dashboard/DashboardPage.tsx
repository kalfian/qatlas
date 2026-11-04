import { Link, useParams } from '@tanstack/react-router'
import { format, parseISO } from 'date-fns'
import { enUS, id as localeId, type Locale } from 'date-fns/locale'
import { ArrowDownRight, ArrowRight, ArrowUpRight, CircleCheck, History, Minus } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useProject, useProjectStats, useRuns } from '@/api/queries'
import type { ProjectStats, RunSummary, RunTrigger } from '@/api/types'
import { useCan } from '@/app/auth'
import { EmptyState, ErrorState, PageContainer, PageHeader, Panel } from '@/components/page'
import { StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatDateTime, formatDuration, formatPercent, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useDelayedFlag } from '@/features/settings/shared'

const DAY = 86_400_000

type Day = ProjectStats['daily'][number]

/* ------------------------------------------------------------------ page */

export function DashboardPage() {
  const { key } = useParams({ from: '/_app/p/$key/' })
  const project = useProject(key)

  return (
    <PageContainer>
      <PageHeader
        title={project.data?.name ?? key}
        description={project.data?.description || undefined}
      />
      <StatStrip projectKey={key} />
      <div className="grid grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-3">
        <TrendPanel projectKey={key} className="lg:col-span-2" />
        <TopFailingPanel projectKey={key} />
      </div>
      <RecentRunsPanel projectKey={key} />
    </PageContainer>
  )
}

/* ------------------------------------------------------------------ stat strip */

/**
 * Pass rate 7 hari sebelumnya, dihitung dengan rumus yang sama dengan endpoint stats:
 * passed / run final (cancelled tidak dihitung). null bila tidak ada data / data terpotong.
 */
function usePreviousPassRate(projectKey: string): number | null | undefined {
  // dibulatkan ke jam agar query key stabil antar render
  const now = Math.floor(Date.now() / 3_600_000) * 3_600_000
  const start = now - 14 * DAY
  const end = now - 7 * DAY
  const runs = useRuns(
    projectKey,
    { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) },
    { limit: 200, live: false },
  )
  if (!runs.data) return undefined
  if (runs.data.next_cursor) return null
  const inWindow = runs.data.data.filter((r) => {
    const t = Date.parse(r.queued_at)
    return t >= start && t < end
  })
  const finals = inWindow.filter((r) => ['passed', 'failed', 'blocked', 'error'].includes(r.status))
  if (!finals.length) return null
  return finals.filter((r) => r.status === 'passed').length / finals.length
}

function StatStrip({ projectKey }: { projectKey: string }) {
  const s7 = useProjectStats(projectKey, '7d')
  const s30 = useProjectStats(projectKey, '30d')
  const { t, i18n } = useTranslation('dashboard')
  const prev = usePreviousPassRate(projectKey)
  const loading = s7.isPending || s30.isPending
  const showSkeleton = useDelayedFlag(loading)

  if (s7.isError || s30.isError) {
    return <ErrorState error={s7.error ?? s30.error} onRetry={() => (s7.refetch(), s30.refetch())} />
  }

  if (loading) {
    return (
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-4" aria-busy="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex h-[92px] flex-col gap-2 bg-card px-4 py-3">
            {showSkeleton && (
              <>
                <Skeleton className="h-3 w-24" />
                <Skeleton className="h-7 w-16" />
                <Skeleton className="h-3 w-32" />
              </>
            )}
          </div>
        ))}
        <span className="sr-only">{t('stats.loading')}</span>
      </div>
    )
  }

  const a = s7.data!
  const b = s30.data!
  const delta = a.pass_rate != null && prev != null ? Math.round(a.pass_rate * 100) - Math.round(prev * 100) : null

  return (
    <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border bg-border lg:grid-cols-4">
      <Stat label={t('stats.passRate7')} value={formatPercent(a.pass_rate)} extra={delta != null ? <Delta value={delta} /> : null}>
        {a.pass_rate == null
          ? t('stats.noFinishedRuns')
          : prev != null
            ? t('stats.previous7', { value: formatPercent(prev) })
            : t('stats.noComparison')}
      </Stat>
      <Stat label={t('stats.passRate30')} value={formatPercent(b.pass_rate)}>
        {b.pass_rate == null ? t('stats.noFinishedRuns') : t('stats.fromRuns', { count: b.total_runs })}
      </Stat>
      <Stat label={t('stats.totalRuns7')} value={formatNumber(a.total_runs, i18n.language)}>
        {a.avg_duration_ms != null ? t('stats.avgDuration', { duration: formatDuration(a.avg_duration_ms) }) : t('stats.noDuration')}
      </Stat>
      <Stat
        label={t('stats.awaitingManual')}
        value={
          <Link
            to="/p/$key/runs"
            params={{ key: projectKey }}
            search={{ status: 'awaiting_manual' }}
            className="group inline-flex items-center gap-1 rounded-sm underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
          >
            {a.awaiting_manual}
            <span className="sr-only">{t('stats.awaitingSr')}</span>
            <ArrowUpRight className="size-4 text-muted-foreground transition-colors group-hover:text-foreground" aria-hidden />
          </Link>
        }
      >
        {a.awaiting_manual > 0 ? t('stats.needsWork') : t('stats.nothingWaiting')}
      </Stat>
    </dl>
  )
}

function Stat({ label, value, extra, children }: { label: string; value: React.ReactNode; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col bg-card px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 flex items-baseline gap-2">
        <span className="tabular text-2xl font-semibold tracking-tight">{value}</span>
        {extra}
      </dd>
      <dd className="mt-0.5 truncate text-xs text-muted-foreground">{children}</dd>
    </div>
  )
}

function Delta({ value }: { value: number }) {
  const { t } = useTranslation('dashboard')
  const Icon = value > 0 ? ArrowUpRight : value < 0 ? ArrowDownRight : Minus
  const tone = value > 0 ? 'text-status-passed' : value < 0 ? 'text-status-failed' : 'text-muted-foreground'
  const spoken =
    value > 0 ? t('stats.deltaUp', { count: value }) : value < 0 ? t('stats.deltaDown', { count: Math.abs(value) }) : t('stats.deltaFlat')
  return (
    <span className={cn('tabular inline-flex items-center gap-0.5 text-xs font-medium', tone)}>
      <Icon className="size-3.5" aria-hidden />
      <span aria-hidden>{value === 0 ? '0' : Math.abs(value)}</span>
      <span className="sr-only">{spoken}</span>
    </span>
  )
}

/* ------------------------------------------------------------------ trend chart */

const SERIES = [
  { key: 'passed', label: 'Passed', fill: 'fill-status-passed', swatch: 'bg-status-passed' },
  { key: 'failed', label: 'Failed / Error', fill: 'fill-status-failed', swatch: 'bg-status-failed' },
  { key: 'other', label: null, fill: 'fill-status-skipped', swatch: 'bg-status-skipped' },
] as const

/** Label seri: status (Passed, Failed / Error) tetap Inggris; "lainnya" diterjemahkan. */
const seriesLabel = (s: (typeof SERIES)[number], t: TFunction<'dashboard'>) => s.label ?? t('trend.other')

/** Locale date-fns sesuai bahasa UI. */
const dateLocale = (lang: string): Locale => (lang === 'id' ? localeId : enUS)

const formatNumber = (n: number, lang: string) => new Intl.NumberFormat(lang).format(n)

const dayTotal = (d: Day) => d.passed + d.failed + d.other
const dayDate = (d: Day) => parseISO(d.date)
const longDate = (d: Day, lang: string) => format(dayDate(d), 'EEEE, d MMM', { locale: dateLocale(lang) })
const shortDate = (d: Day, lang: string) => format(dayDate(d), 'd MMM', { locale: dateLocale(lang) })

/** Batas atas sumbu Y yang "bulat" dan setengahnya tetap bilangan bulat. */
function niceMax(v: number): number {
  if (v <= 4) return 4
  const mag = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 4, 6, 8, 10]) if (m * mag >= v) return m * mag
  return 10 * mag
}

function TrendPanel({ projectKey, className }: { projectKey: string; className?: string }) {
  const { t } = useTranslation('dashboard')
  const stats = useProjectStats(projectKey, '30d')
  const showSkeleton = useDelayedFlag(stats.isPending)
  const totals = stats.data?.daily.reduce(
    (acc, d) => ({ passed: acc.passed + d.passed, failed: acc.failed + d.failed, other: acc.other + d.other }),
    { passed: 0, failed: 0, other: 0 },
  )

  return (
    <Panel
      title={t('trend.title')}
      className={className}
      actions={totals && <Legend totals={totals} className="hidden sm:flex" />}
    >
      {totals && <Legend totals={totals} className="mb-4 sm:hidden" />}
      {stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} className="border-0 px-0 py-2" />
      ) : stats.isPending ? (
        <div className="h-[200px]" aria-busy="true">
          {showSkeleton && <Skeleton className="h-full w-full" />}
          <span className="sr-only">{t('trend.loading')}</span>
        </div>
      ) : stats.data.daily.every((d) => dayTotal(d) === 0) ? (
        <EmptyState icon={History} title={t('trend.empty')} className="h-[200px] justify-center border-0 px-0" />
      ) : (
        <TrendChart daily={stats.data.daily} />
      )}
    </Panel>
  )
}

function Legend({ totals, className }: { totals: Record<(typeof SERIES)[number]['key'], number>; className?: string }) {
  const { t } = useTranslation('dashboard')
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground', className)} aria-label={t('trend.legend')}>
      {SERIES.map((s) => (
        <li key={s.key} className="inline-flex items-center gap-1.5">
          <span className={cn('size-2 rounded-[2px]', s.swatch)} aria-hidden />
          {seriesLabel(s, t)}
          <span className="tabular font-medium text-foreground">{totals[s.key]}</span>
        </li>
      ))}
    </ul>
  )
}

function TrendChart({ daily }: { daily: Day[] }) {
  const { t, i18n } = useTranslation('dashboard')
  const lang = i18n.language
  const [active, setActive] = React.useState<number | null>(null)
  const [viaKeyboard, setViaKeyboard] = React.useState(false)
  const n = daily.length
  const max = niceMax(Math.max(...daily.map(dayTotal)))
  const W = n * 10
  const H = 100
  const GAP = 0.9 // jarak antar segmen (unit Y) agar batas terbaca tanpa warna

  const onKeyDown = (e: React.KeyboardEvent) => {
    const cur = active ?? n - 1
    let next: number | null = null
    if (e.key === 'ArrowLeft') next = Math.max(0, cur - 1)
    else if (e.key === 'ArrowRight') next = Math.min(n - 1, cur + 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = n - 1
    else if (e.key === 'Escape') {
      setActive(null)
      return
    }
    if (next != null) {
      e.preventDefault()
      setViaKeyboard(true)
      setActive(next)
    }
  }

  const activeDay = active != null ? daily[active] : null

  return (
    <div>
      <div className="flex gap-2">
        {/* sumbu Y */}
        <div className="tabular relative h-40 w-6 shrink-0 text-right text-xs text-muted-foreground" aria-hidden>
          <span className="absolute top-0 right-0 -translate-y-1/2">{max}</span>
          <span className="absolute top-1/2 right-0 -translate-y-1/2">{max / 2}</span>
          <span className="absolute right-0 bottom-0 translate-y-1/2">0</span>
        </div>

        <div
          className="relative h-40 min-w-0 flex-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
          tabIndex={0}
          role="group"
          aria-label={t('trend.chartLabel')}
          onKeyDown={onKeyDown}
          onFocus={(e) => {
            // hanya fokus keyboard yang membuka tooltip; klik mouse sudah ditangani hover
            if (!e.currentTarget.matches(':focus-visible')) return
            setViaKeyboard(true)
            setActive((a) => a ?? n - 1)
          }}
          onBlur={() => setActive(null)}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            className="block h-full w-full overflow-visible"
            aria-hidden
            onMouseLeave={() => setActive(null)}
          >
            {[0, 0.5, 1].map((f) => (
              <line
                key={f}
                x1={0}
                x2={W}
                y1={H - f * H}
                y2={H - f * H}
                className={f === 0 ? 'stroke-input' : 'stroke-border'}
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                strokeDasharray={f === 0 ? undefined : '3 3'}
              />
            ))}
            {daily.map((d, i) => {
              const x = i * 10 + 1.75
              const bw = 6.5
              const total = dayTotal(d)
              let y = H
              const segs = SERIES.map((s) => {
                const v = d[s.key]
                if (!v) return null
                const h = (v / max) * H
                const top = y - h
                const rect = { s, y: top, h: Math.max(h - (y < H ? GAP : 0), 0.6) }
                y = top
                return rect
              }).filter(Boolean) as { s: (typeof SERIES)[number]; y: number; h: number }[]
              return (
                <g key={d.date}>
                  {active === i && <rect x={i * 10} y={0} width={10} height={H} className="fill-muted" />}
                  {total === 0 ? (
                    <rect x={x} y={H - 0.8} width={bw} height={0.8} className="fill-border" />
                  ) : (
                    segs.map((seg) => <rect key={seg.s.key} x={x} y={seg.y} width={bw} height={seg.h} className={seg.s.fill} />)
                  )}
                  {/* area hover selebar slot */}
                  <rect
                    x={i * 10}
                    y={0}
                    width={10}
                    height={H}
                    fill="transparent"
                    onMouseEnter={() => {
                      setViaKeyboard(false)
                      setActive(i)
                    }}
                  />
                </g>
              )
            })}
          </svg>

          {activeDay && active != null && <ChartTooltip day={activeDay} index={active} count={n} lang={lang} />}
        </div>
      </div>

      {/* sumbu X */}
      <div className="mt-2 ml-8 flex justify-between text-xs text-muted-foreground" aria-hidden>
        <span>{shortDate(daily[0], lang)}</span>
        <span>{shortDate(daily[Math.floor(n / 2)], lang)}</span>
        <span>{t('trend.today')}</span>
      </div>

      <p className="sr-only" aria-live="polite">
        {viaKeyboard && activeDay ? describeDay(activeDay, lang, t) : ''}
      </p>

      <table className="sr-only">
        <caption>{t('trend.tableCaption')}</caption>
        <thead>
          <tr>
            <th scope="col">{t('trend.date')}</th>
            <th scope="col">Passed</th>
            <th scope="col">Failed / Error</th>
            <th scope="col">{t('trend.other')}</th>
            <th scope="col">{t('trend.total')}</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((d) => (
            <tr key={d.date}>
              <th scope="row">{longDate(d, lang)}</th>
              <td>{d.passed}</td>
              <td>{d.failed}</td>
              <td>{d.other}</td>
              <td>{dayTotal(d)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function describeDay(d: Day, lang: string, t: TFunction<'dashboard'>): string {
  const total = dayTotal(d)
  if (!total) return t('trend.dayNone', { date: longDate(d, lang) })
  return t('trend.dayDetail', { date: longDate(d, lang), total, passed: d.passed, failed: d.failed, other: d.other })
}

function ChartTooltip({ day, index, count, lang }: { day: Day; index: number; count: number; lang: string }) {
  const { t } = useTranslation('dashboard')
  const total = dayTotal(day)
  const finals = day.passed + day.failed
  // tooltip di sisi bar yang lebih lapang agar bar aktif tidak tertutup
  const rightSide = index < count / 2
  const style: React.CSSProperties = rightSide
    ? { left: `calc(${((index + 1) / count) * 100}% + 6px)` }
    : { right: `calc(${((count - index) / count) * 100}% + 6px)` }
  return (
    <div
      className="pointer-events-none absolute top-0 z-10 w-44 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-overlay"
      style={style}
      aria-hidden
    >
      <p className="font-medium capitalize">{longDate(day, lang)}</p>
      {total === 0 ? (
        <p className="mt-1 text-muted-foreground">{t('trend.noRuns')}</p>
      ) : (
        <>
          <ul className="mt-1.5 grid gap-1">
            {SERIES.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className={cn('size-2 rounded-[2px]', s.swatch)} />
                <span className="text-muted-foreground">{seriesLabel(s, t)}</span>
                <span className="tabular ml-auto font-medium">{day[s.key]}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 border-t border-border pt-1.5 text-muted-foreground">
            <span className="tabular">{total}</span> {t('trend.runs', { count: total })}
            {finals > 0 && (
              <>
                {' · '}
                {t('trend.pass')} <span className="tabular">{formatPercent(day.passed / finals)}</span>
              </>
            )}
          </p>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ top failing */

function TopFailingPanel({ projectKey }: { projectKey: string }) {
  const stats = useProjectStats(projectKey, '30d')
  const showSkeleton = useDelayedFlag(stats.isPending)
  const items = stats.data?.top_failing ?? []
  const { t } = useTranslation('dashboard')

  return (
    <Panel title={t('topFailing.title')} actions={<span className="text-xs text-muted-foreground">{t('topFailing.period')}</span>} bodyClassName="p-0">
      {stats.isError ? (
        <ErrorState error={stats.error} onRetry={() => stats.refetch()} className="m-4" />
      ) : stats.isPending ? (
        <div className="grid gap-px" aria-busy="true">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-12 items-center gap-3 px-4">
              {showSkeleton && (
                <>
                  <Skeleton className="h-4 w-16" />
                  <Skeleton className="h-4 flex-1" />
                </>
              )}
            </div>
          ))}
          <span className="sr-only">{t('topFailing.loading')}</span>
        </div>
      ) : items.length === 0 ? (
        <EmptyState icon={CircleCheck} title={t('topFailing.empty')} className="m-4 border-0 px-0 py-4" />
      ) : (
        <ol className="divide-y divide-border">
          {items.map((item) => (
            <li key={item.test_case_key}>
              <Link
                to="/p/$key/tests/$caseKey"
                params={{ key: projectKey, caseKey: item.test_case_key }}
                className="group flex flex-col gap-1.5 px-4 py-2.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs text-muted-foreground">{item.test_case_key}</span>
                  <span className="truncate group-hover:underline">{item.title}</span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {/* bar = proporsi run yang gagal, sesuai teks "x gagal dari y run" */}
                  <span className="h-1 flex-1 overflow-hidden rounded-full bg-muted" aria-hidden>
                    <span className="block h-full rounded-full bg-status-failed" style={{ width: `${(item.failures / Math.max(1, item.runs)) * 100}%` }} />
                  </span>
                  <span className="tabular shrink-0">
                    <Trans
                      t={t}
                      i18nKey="topFailing.failedOf"
                      count={item.runs}
                      values={{ failures: item.failures }}
                      components={{ fail: <span className="font-medium text-status-failed" /> }}
                    />
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  )
}

/* ------------------------------------------------------------------ recent runs */

const TRIGGER_LABEL: Record<RunTrigger, 'MCP' | 'API' | 'schedule' | null> = { manual: null, mcp: 'MCP', api: 'API', schedule: 'schedule' }

function RecentRunsPanel({ projectKey }: { projectKey: string }) {
  const runs = useRuns(projectKey, {}, { limit: 10 })
  const canRun = useCan('run', projectKey)
  const { t } = useTranslation('dashboard')
  const showSkeleton = useDelayedFlag(runs.isPending)
  const list = runs.data?.data ?? []

  return (
    <Panel
      title={t('recent.title')}
      bodyClassName="p-0"
      actions={
        <Button asChild variant="ghost" size="sm">
          <Link to="/p/$key/runs" params={{ key: projectKey }}>
            {t('recent.viewAll')} <ArrowRight />
          </Link>
        </Button>
      }
    >
      {runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} className="m-4" />
      ) : runs.isPending ? (
        <div aria-busy="true">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="flex h-9 items-center gap-4 border-b border-border px-3 last:border-0">
              {showSkeleton && (
                <>
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="h-4 flex-1" />
                  <Skeleton className="h-4 w-16" />
                </>
              )}
            </div>
          ))}
          <span className="sr-only">{t('recent.loading')}</span>
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={History}
          title={t('recent.empty')}
          description={canRun ? t('recent.emptyHint') : undefined}
          className="m-4"
          action={
            canRun ? (
              <Button asChild size="sm">
                <Link to="/p/$key/tests" params={{ key: projectKey }}>
                  {t('recent.openTestCases')}
                </Link>
              </Button>
            ) : undefined
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('recent.col.run')}</TableHead>
              <TableHead className="hidden sm:table-cell">{t('recent.col.target')}</TableHead>
              <TableHead>{t('recent.col.status')}</TableHead>
              <TableHead className="hidden md:table-cell">{t('recent.col.environment')}</TableHead>
              <TableHead className="hidden lg:table-cell">{t('recent.col.by')}</TableHead>
              <TableHead className="hidden text-right md:table-cell">{t('recent.col.duration')}</TableHead>
              <TableHead className="hidden text-right sm:table-cell">{t('recent.col.time')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((r) => (
              <RunRow key={r.id} run={r} projectKey={projectKey} />
            ))}
          </TableBody>
        </Table>
      )}
    </Panel>
  )
}

function RunRow({ run, projectKey }: { run: RunSummary; projectKey: string }) {
  const { t } = useTranslation('dashboard')
  const raw = TRIGGER_LABEL[run.trigger]
  const trigger = raw === 'schedule' ? t('recent.schedule') : raw
  return (
    <TableRow className="hover:bg-muted/50">
      <TableCell className="max-w-[12rem] sm:max-w-none sm:whitespace-nowrap">
        <Link
          to="/p/$key/runs/$runKey"
          params={{ key: projectKey, runKey: run.key }}
          className="rounded-sm font-mono text-xs font-medium text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {run.key}
        </Link>
        <span className="block truncate text-xs text-muted-foreground sm:hidden">{run.target.title}</span>
      </TableCell>
      <TableCell className="hidden max-w-[18rem] min-w-[10rem] sm:table-cell">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 font-mono text-xs text-muted-foreground">{run.target.key}</span>
          <span className="truncate">{run.target.title}</span>
        </span>
      </TableCell>
      <TableCell>
        <StatusBadge status={run.status} />
        <time dateTime={run.queued_at} className="mt-0.5 block text-xs text-muted-foreground sm:hidden">
          {formatRelative(run.queued_at)}
        </time>
      </TableCell>
      <TableCell className="hidden text-muted-foreground md:table-cell">{run.environment?.name ?? '—'}</TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {run.triggered_by.name}
        {trigger && <span className="ml-1.5 text-xs text-muted-foreground">{t('recent.via', { trigger })}</span>}
      </TableCell>
      <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground md:table-cell">{formatDuration(run.duration_ms)}</TableCell>
      <TableCell className="hidden text-right whitespace-nowrap text-muted-foreground sm:table-cell">
        <time dateTime={run.queued_at} title={formatDateTime(run.queued_at)}>
          {formatRelative(run.queued_at)}
        </time>
      </TableCell>
    </TableRow>
  )
}
