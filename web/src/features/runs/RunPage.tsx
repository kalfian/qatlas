import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowDown, Ban, ChevronDown, Ellipsis, FileCode2, FileJson, Film, ImageOff, Link2, RotateCw, SlidersHorizontal, SearchX } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { useCancelRun, useRerun, useRunJUnit, useRunProgress } from '@/api/queries'
import type { Run } from '@/api/types'
import { useAuth, useCan } from '@/app/auth'
import { KeyBadge, useCopy } from '@/components/misc'
import { EmptyState, ErrorState, PageContainer } from '@/components/page'
import { StatusBadge, STATUS_META } from '@/components/status'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DeviceChip } from '@/components/devices'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { deviceLabel, devicesSummary } from '@/lib/devices'
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { scrollToElement, useDelayedFlag, useNow, usePrefersReducedMotion } from './hooks'
import { ManualWorkspace } from './ManualWorkspace'
import { ExpiredArtifact, Lightbox, Thumb } from './media'
import { RunDialog } from './RunDialog'
import { RunMatrix } from './RunMatrix'
import { CaseList } from './RunSteps'
import {
  BROWSER_LABEL,
  collectScreenshots,
  deviceOfCase,
  downloadJson,
  downloadText,
  failedStepCount,
  firstFailedStep,
  formatClock,
  isActive,
  isLive,
  kindLabel,
  manualCaseOf,
  runDevices,
  screenshotLabel,
  tallySteps,
  triggerLabel,
  videoLabel,
  type MediaItem,
} from './runUtils'

type Tab = 'matrix' | 'steps' | 'screenshots' | 'video' | 'detail'

export function RunPage() {
  const { key, runKey } = useParams({ from: '/_app/p/$key/runs/$runKey' })
  const q = useRunProgress(runKey)
  const showSkeleton = useDelayedFlag(q.isPending)
  const { t } = useTranslation('runs')

  if (q.isPending) return showSkeleton ? <RunSkeleton /> : <div className="min-h-96" aria-busy="true" />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <PageContainer>
          <EmptyState
            icon={SearchX}
            title={t('report.notFoundTitle', { key: runKey })}
            description={t('report.notFoundDescription')}
            action={
              <Button asChild variant="outline">
                <Link to="/p/$key/runs" params={{ key }}>
                  {t('report.backToList')}
                </Link>
              </Button>
            }
          />
        </PageContainer>
      )
    return (
      <PageContainer>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </PageContainer>
    )
  }
  return <RunView key={q.data.key} run={q.data} projectKey={key} />
}

function RunSkeleton() {
  const { t } = useTranslation('runs')
  return (
    <PageContainer>
      <div className="grid gap-2" aria-busy="true" aria-label={t('list.loading')}>
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <Skeleton className="h-2 w-full" />
      <Skeleton className="h-9 w-80 max-w-full" />
      <div className="grid gap-px rounded-md border border-border">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-10 rounded-none" />
        ))}
      </div>
    </PageContainer>
  )
}

/* ------------------------------------------------------------------ view */

function RunView({ run, projectKey }: { run: Run; projectKey: string }) {
  const me = useAuth()
  const canExecute = useCan('execute_manual', run.project_key)
  const canReassign = useCan('reassign_manual', run.project_key)
  const reduced = usePrefersReducedMotion()
  const { t, i18n } = useTranslation('runs')

  const manualCase = manualCaseOf(run)
  const editable = !!manualCase && canExecute && run.assignee?.id === me.user.id

  const multiDevice = runDevices(run).length > 1
  // multi-device runs open on the matrix (docs/14); the grouped case list is one tab away
  const [tab, setTab] = React.useState<Tab>(() => (multiDevice ? 'matrix' : 'steps'))
  const [caseOpen, setCaseOpen] = React.useState<Record<string, boolean>>({})
  const [stepOpen, setStepOpen] = React.useState<Record<string, boolean>>({})
  const [lightbox, setLightbox] = React.useState<{ items: MediaItem[]; index: number } | null>(null)

  const lang = i18n.language
  const screenshots = React.useMemo(() => collectScreenshots(run, lang), [run, lang])
  const shotIndex = React.useMemo(() => new Map(screenshots.map((s, i) => [s.id, i])), [screenshots])
  const videos = run.cases.filter((c) => c.video)

  /* ---------- auto-scroll ke step gagal pertama (sekali) / pill */
  const interacted = React.useRef(false)
  const didAutoFail = React.useRef(false)
  const [pill, setPill] = React.useState(false)
  const firstFail = firstFailedStep(run, manualCase?.id)
  const failStepId = firstFail?.stepId
  const failCaseId = firstFail?.caseId
  const failCount = failedStepCount(run, manualCase?.id)

  React.useEffect(() => {
    const mark = () => {
      interacted.current = true
    }
    const onKey = (e: KeyboardEvent) => {
      if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' '].includes(e.key)) mark()
    }
    window.addEventListener('wheel', mark, { passive: true })
    window.addEventListener('touchmove', mark, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('wheel', mark)
      window.removeEventListener('touchmove', mark)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const hasManualSlot = !!manualCase
  React.useEffect(() => {
    if (!failStepId || !failCaseId || didAutoFail.current) return
    didAutoFail.current = true
    if (interacted.current || tab !== 'steps' || hasManualSlot) {
      setPill(true)
      return
    }
    setCaseOpen((o) => ({ ...o, [failCaseId]: true }))
    setStepOpen((o) => ({ ...o, [failStepId]: true }))
    requestAnimationFrame(() => scrollToElement(document.getElementById(`step-${failStepId}`), reduced))
  }, [failStepId, failCaseId, tab, hasManualSlot, reduced])

  // pill hilang begitu step gagal terlihat
  React.useEffect(() => {
    if (!pill || !failStepId) return
    const el = document.getElementById(`step-${failStepId}`)
    if (!el) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setPill(false)
    })
    io.observe(el)
    return () => io.disconnect()
  }, [pill, failStepId, tab, caseOpen, run])

  const jumpToFail = () => {
    if (!failStepId || !failCaseId) return
    setTab('steps')
    setCaseOpen((o) => ({ ...o, [failCaseId]: true }))
    setStepOpen((o) => ({ ...o, [failStepId]: true }))
    setPill(false)
    requestAnimationFrame(() => {
      const el = document.getElementById(`step-${failStepId}`)
      scrollToElement(el, reduced)
      el?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true })
    })
  }

  /* ---------- live region: hanya perubahan level case + status final */
  const [announcement, setAnnouncement] = React.useState('')
  const prevRun = React.useRef<Run | null>(null)
  React.useEffect(() => {
    const prev = prevRun.current
    prevRun.current = run
    if (!prev) return
    const msgs: string[] = []
    for (const c of run.cases) {
      const p = prev.cases.find((x) => x.id === c.id)
      if (!p || p.status === c.status) continue
      const device = multiDevice ? deviceLabel(deviceOfCase(run, c)) : null
      if (c.status === 'running' && c.execution === 'automated')
        msgs.push(device ? t('live.caseRunningOn', { n: String(c.position), key: c.test_case_key, device }) : t('live.caseRunning', { n: String(c.position), key: c.test_case_key }))
      else if (c.status !== 'pending' && c.status !== 'running')
        msgs.push(
          device
            ? t('live.caseDoneOn', { n: String(c.position), device, status: STATUS_META[c.status].label })
            : t('live.caseDone', { n: String(c.position), status: STATUS_META[c.status].label }),
        )
    }
    if (prev.status !== run.status) {
      if (!isActive(run.status)) {
        const failed = run.summary.cases.failed
        msgs.push(
          failed
            ? t('live.runFinishedFailed', { status: STATUS_META[run.status].label, failed: String(failed), count: run.summary.cases.total })
            : t('live.runFinished', { status: STATUS_META[run.status].label }),
        )
      } else if (run.status === 'awaiting_manual') {
        msgs.push(t('live.awaitingManual', { name: run.assignee?.name ?? t('live.assigneeFallback') }))
      } else if (prev.status === 'awaiting_manual' && run.status === 'running') {
        msgs.push(t('live.resumed'))
      }
    }
    if (msgs.length) setAnnouncement(msgs.join('. '))
  }, [run, t, multiDevice])

  const titleRef = React.useRef<HTMLHeadingElement>(null)

  const onToggleCase = (id: string, open: boolean) => setCaseOpen((o) => ({ ...o, [id]: open }))
  /** Matrix cell → that case on that device, opened in the Steps tab, scrolled to and focused. */
  const openCase = (id: string) => {
    interacted.current = true
    setPill(false)
    setTab('steps')
    setCaseOpen((o) => ({ ...o, [id]: true }))
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = document.getElementById(`case-${id}`)
        scrollToElement(el, reduced)
        el?.querySelector<HTMLButtonElement>(`#case-title-${id} button`)?.focus({ preventScroll: true })
      }),
    )
  }
  const onToggleStep = (id: string, open: boolean) => setStepOpen((o) => ({ ...o, [id]: open }))
  const lightboxOrigin = React.useRef<HTMLElement | null>(null)
  const openShot = (index: number) => {
    lightboxOrigin.current = document.activeElement as HTMLElement | null
    setLightbox({ items: screenshots, index })
  }
  const openMedia = (items: MediaItem[], index: number) => {
    lightboxOrigin.current = document.activeElement as HTMLElement | null
    setLightbox({ items, index })
  }

  return (
    <PageContainer>
      <RunHeader run={run} projectKey={projectKey} titleRef={titleRef} />
      <RunProgress run={run} />

      {run.status === 'error' && run.error_message && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-status-error/40 bg-status-error-bg px-3 py-2 text-sm text-status-error">
          <span className="font-medium">{t('report.infraError')}</span>
          <span className="min-w-0 font-mono text-xs leading-5 break-words">{run.error_message}</span>
        </div>
      )}
      {run.cancel_requested && isLive(run.status) && (
        <p className="text-sm text-muted-foreground">{t('report.cancelRequested')}</p>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
        <TabsList aria-label={t('report.tabsLabel')}>
          {multiDevice && <TabsTrigger value="matrix">{t('report.tabs.matrix')}</TabsTrigger>}
          <TabsTrigger value="steps">{t('report.tabs.steps')}</TabsTrigger>
          <TabsTrigger value="screenshots">
            {t('report.tabs.screenshots')} <span className="text-xs text-muted-foreground tabular">{screenshots.length}</span>
          </TabsTrigger>
          <TabsTrigger value="video">
            {t('report.tabs.video')} <span className="text-xs text-muted-foreground tabular">{videos.length}</span>
          </TabsTrigger>
          <TabsTrigger value="detail">{t('report.tabs.detail')}</TabsTrigger>
        </TabsList>

        {multiDevice && (
          <TabsContent value="matrix">
            <RunMatrix run={run} onOpenCase={openCase} />
          </TabsContent>
        )}

        <TabsContent value="steps">
          <CaseList
            run={run}
            caseOpen={caseOpen}
            stepOpen={stepOpen}
            onToggleCase={onToggleCase}
            onToggleStep={onToggleStep}
            shotIndex={shotIndex}
            screenshots={screenshots}
            onOpenScreenshot={openShot}
            onOpenMedia={openMedia}
            manualSlot={
              manualCase
                ? {
                    caseId: manualCase.id,
                    node: (
                      <ManualWorkspace
                        key={manualCase.id}
                        run={run}
                        c={manualCase}
                        editable={editable}
                        canReassign={canReassign}
                        onOpenMedia={openMedia}
                        onFinished={() => titleRef.current?.focus()}
                      />
                    ),
                  }
                : undefined
            }
          />
        </TabsContent>

        <TabsContent value="screenshots">
          <ScreenshotGallery run={run} items={screenshots} onOpen={openShot} />
        </TabsContent>

        <TabsContent value="video">
          <VideoList run={run} />
        </TabsContent>

        <TabsContent value="detail">
          <RunDetail run={run} />
        </TabsContent>
      </Tabs>

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

      {pill && failCount > 0 && (
        <Button onClick={jumpToFail} className="fixed bottom-4 left-1/2 z-30 -translate-x-1/2 shadow-overlay max-sm:h-11">
          {t('report.failedPill', { count: failCount })} <ArrowDown />
        </Button>
      )}

      <Lightbox
        items={lightbox?.items ?? []}
        index={lightbox?.index ?? null}
        onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
        onClose={() => setLightbox(null)}
        returnFocusTo={lightboxOrigin}
      />
    </PageContainer>
  )
}

/* ------------------------------------------------------------------ header */

function RunHeader({ run, projectKey, titleRef }: { run: Run; projectKey: string; titleRef: React.Ref<HTMLHeadingElement> }) {
  const me = useAuth()
  const navigate = useNavigate()
  const canRun = useCan('run', run.project_key)
  const canCancelOwn = useCan('cancel_own_run', run.project_key)
  const canCancelAny = useCan('cancel_any_run', run.project_key)
  const cancel = useCancelRun()
  const junit = useRunJUnit()
  const rerun = useRerun()
  const { copy } = useCopy()
  const [confirmCancel, setConfirmCancel] = React.useState(false)
  const [dialog, setDialog] = React.useState(false)
  const cancelBtn = React.useRef<HTMLButtonElement>(null)
  const rerunBtn = React.useRef<HTMLButtonElement>(null)
  const { t } = useTranslation(['runs', 'common'])

  const live = isLive(run.status)
  const now = useNow(live)
  const startIso = run.started_at ?? run.queued_at
  const elapsed = live ? now - Date.parse(startIso) : null

  const showCancel = isActive(run.status) && (canCancelAny || (canCancelOwn && run.triggered_by.id === me.user.id))
  const allManual = run.cases.length > 0 && run.cases.every((c) => c.execution === 'manual')
  const failedCases = run.cases.filter((c) => ['failed', 'error', 'blocked', 'skipped'].includes(c.status)).length
  const isFinal = !isActive(run.status)
  const primaryRerun = isFinal

  const doRerun = (only_failed: boolean) =>
    rerun.mutate(
      { runKey: run.key, only_failed },
      {
        onSuccess: (r) => navigate({ to: '/p/$key/runs/$runKey', params: { key: r.project_key, runKey: r.key } }),
        onError: (e) => toast.error(errorMessage(e)),
      },
    )

  const target =
    run.kind === 'flow' ? (
      <Link to="/p/$key/flows/$flowKey" params={{ key: run.project_key, flowKey: run.target.key }} className="font-mono text-link hover:underline">
        {run.target.key}
      </Link>
    ) : (
      <Link to="/p/$key/tests/$caseKey" params={{ key: run.project_key, caseKey: run.target.key }} className="font-mono text-link hover:underline">
        {run.target.key}
      </Link>
    )

  const sep = (
    <span aria-hidden className="text-border">
      ·
    </span>
  )

  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <h1 ref={titleRef} tabIndex={-1} className="font-mono text-xl font-semibold tracking-tight outline-none">
            {run.key}
          </h1>
          <StatusBadge status={run.status} />
          {elapsed != null ? (
            <span className="text-sm text-muted-foreground tabular" title={t('report.elapsed')}>
              <span className="sr-only">{t('report.durationSr')} </span>
              {formatClock(elapsed)}
            </span>
          ) : (
            run.duration_ms != null &&
            !isActive(run.status) && (
              <span className="text-sm text-muted-foreground tabular">
                <span className="sr-only">{t('report.durationSr')} </span>
                {formatDuration(run.duration_ms)}
              </span>
            )
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
          <span>{kindLabel(run.kind)}</span>
          {target}
          <span className="min-w-0 text-foreground">{run.target.title}</span>
          {sep}
          <span>{run.environment?.name ?? t('report.noEnvironment')}</span>
          {!allManual && (
            <>
              {sep}
              <span>{BROWSER_LABEL[run.options.browser]}</span>
            </>
          )}
          {sep}
          <span>{devicesSummary(runDevices(run))}</span>
          {sep}
          <span>
            {t('report.by')} <span className="text-foreground">{run.triggered_by.name}</span>
            {run.trigger !== 'manual' && ` ${run.trigger === 'schedule' ? t('report.scheduledSuffix') : triggerLabel(run.trigger)}`}
          </span>
          {sep}
          <time dateTime={run.queued_at} title={formatDateTime(run.queued_at)}>
            {formatDateTime(run.queued_at)}
          </time>
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {showCancel && (
          <Button ref={cancelBtn} variant="outline" className="max-sm:h-11" onClick={() => setConfirmCancel(true)} disabled={run.cancel_requested} loading={cancel.isPending}>
            <Ban /> {run.cancel_requested ? t('report.cancelling') : t('report.cancel')}
          </Button>
        )}
        {canRun && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={rerunBtn} variant={primaryRerun ? 'default' : 'outline'} className="max-sm:h-11" loading={rerun.isPending}>
                {!rerun.isPending && <RotateCw />} {t('report.rerun')} <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuItem onSelect={() => doRerun(false)}>
                <RotateCw /> {t('report.rerunSame')}
              </DropdownMenuItem>
              {run.kind === 'flow' && (
                <DropdownMenuItem disabled={failedCases === 0 || isActive(run.status)} onSelect={() => doRerun(true)}>
                  <RotateCw />
                  <span className="flex-1">{t('report.rerunFailed')}</span>
                  {failedCases > 0 && <span className="text-xs text-muted-foreground tabular">{t('report.caseCount', { count: failedCases })}</span>}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialog(true)}>
                <SlidersHorizontal /> {t('report.changeOptions')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="max-sm:size-11" aria-label={t('common:a11y.moreActions')}>
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48">
            <DropdownMenuItem onSelect={() => copy(`${window.location.origin}/p/${run.project_key}/runs/${run.key}`, t('report.linkCopied'))}>
              <Link2 /> {t('report.copyLink')}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                downloadJson(`${run.key}.json`, run)
                toast.success(t('report.exported', { file: `${run.key}.json` }))
              }}
            >
              <FileJson /> {t('report.exportJson')}
            </DropdownMenuItem>
            {isFinal && (
              <DropdownMenuItem
                disabled={junit.isPending}
                onSelect={() => {
                  const file = `${run.key}.junit.xml`
                  junit.mutate(run.key, {
                    onSuccess: (xml) => {
                      downloadText(file, xml, 'application/xml')
                      toast.success(t('report.exported', { file }))
                    },
                    onError: (err) => toast.error(errorMessage(err)),
                  })
                }}
              >
                <FileCode2 /> {t('report.downloadJunit')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AlertDialog open={confirmCancel} onOpenChange={setConfirmCancel}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            cancelBtn.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('report.cancelTitle', { key: run.key })}</AlertDialogTitle>
            <AlertDialogDescription>
              {run.status === 'awaiting_manual'
                ? t('report.cancelBodyManual')
                : t('report.cancelBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.back')}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() =>
                cancel.mutate(run.key, {
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              {t('report.cancelConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {canRun && (
        <RunDialog
          projectKey={projectKey}
          open={dialog}
          onOpenChange={(o) => {
            setDialog(o)
            // dialog dibuka dari item menu (tanpa Trigger): kembalikan fokus ke tombol Re-run
            if (!o) requestAnimationFrame(() => rerunBtn.current?.focus())
          }}
          target={{
            kind: run.kind,
            key: run.target.key,
            title: run.target.title,
            manualOnly: run.kind === 'test_case' && allManual,
            hasManual: run.kind === 'flow' && run.has_manual,
          }}
          initial={{ options: run.options, environmentId: run.environment?.id, assigneeId: run.assignee?.id }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ progress */

const SEGMENTS = [
  { k: 'passed', cls: 'bg-status-passed' },
  { k: 'failed', cls: 'bg-status-failed' },
  { k: 'error', cls: 'bg-status-error' },
  { k: 'blocked', cls: 'bg-status-blocked' },
  { k: 'skipped', cls: 'bg-status-skipped/50' },
  { k: 'running', cls: 'bg-status-running' },
] as const

function RunProgress({ run }: { run: Run }) {
  const tally = tallySteps(run)
  const { t } = useTranslation('runs')
  const pct = (n: number) => (tally.total ? (n / tally.total) * 100 : 0)
  const parts: React.ReactNode[] = []
  // label status tetap Inggris (sama dengan output MCP/API)
  if (tally.passed) parts.push(<span key="p">{tally.passed} passed</span>)
  if (tally.failed)
    parts.push(
      <span key="f" className="font-medium text-status-failed">
        {tally.failed} failed
      </span>,
    )
  if (tally.error)
    parts.push(
      <span key="e" className="font-medium text-status-error">
        {tally.error} error
      </span>,
    )
  if (tally.blocked)
    parts.push(
      <span key="b" className="font-medium text-status-blocked">
        {tally.blocked} blocked
      </span>,
    )
  if (tally.skipped) parts.push(<span key="s">{tally.skipped} skipped</span>)

  return (
    <div className="grid gap-1.5">
      <div
        role="progressbar"
        aria-label={t('progress.label')}
        aria-valuemin={0}
        aria-valuemax={tally.total}
        aria-valuenow={tally.done}
        aria-valuetext={t('progress.valueText', { done: String(tally.done), count: tally.total })}
        className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted"
      >
        {SEGMENTS.map(({ k, cls }) =>
          tally[k] ? (
            <div key={k} className={cn('h-full transition-[width] duration-150 ease-out motion-reduce:transition-none', cls)} style={{ width: `${pct(tally[k])}%` }} />
          ) : null,
        )}
      </div>
      <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground tabular">
        <span className="text-foreground">{t('progress.steps', { done: String(tally.done), count: tally.total })}</span>
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            <span aria-hidden>·</span>
            {p}
          </React.Fragment>
        ))}
        {run.kind === 'flow' && (
          <>
            <span aria-hidden>·</span>
            <span>{t('progress.casesPassed', { passed: String(run.summary.cases.passed), count: run.summary.cases.total })}</span>
          </>
        )}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ screenshots */

function ScreenshotGallery({ run, items, onOpen }: { run: Run; items: MediaItem[]; onOpen: (i: number) => void }) {
  const { t } = useTranslation('runs')
  if (items.length === 0)
    return (
      <EmptyState
        icon={ImageOff}
        title={isLive(run.status) ? t('report.screenshots.emptyLive') : t('report.screenshots.empty')}
        description={`${t('report.screenshots.option', { option: screenshotLabel(run.options.screenshot) })}${run.options.screenshot === 'on_failure' ? ` ${t('report.screenshots.onFailureHint')}` : ''}`}
      />
    )
  return (
    <ul className="grid grid-cols-1 gap-x-3 gap-y-4 min-[480px]:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {items.map((it, i) => (
        <li key={it.id} className="grid min-w-0 gap-1.5">
          <Thumb item={it} size="lg" onOpen={() => onOpen(i)} className="sm:w-full" />
          <p className="flex min-w-0 items-center gap-1.5 text-xs">
            {it.status && <StatusBadge status={it.status} compact />}
            <span className="truncate font-mono text-muted-foreground">{it.caption}</span>
          </p>
        </li>
      ))}
    </ul>
  )
}

/* ------------------------------------------------------------------ video */

function VideoList({ run }: { run: Run }) {
  const withVideo = run.cases.filter((c) => c.video)
  const { t } = useTranslation(['runs', 'common'])
  if (withVideo.length === 0)
    return (
      <EmptyState
        icon={Film}
        title={isLive(run.status) ? t('report.videos.emptyLive') : t('report.videos.empty')}
        description={`${t('report.videos.option', { option: videoLabel(run.options.video) })}${run.options.video === 'on_failure' ? ` ${t('report.videos.onFailureHint')}` : ''}`}
      />
    )
  const sharedSession = run.kind === 'flow' && run.shared_session

  return (
    <div className="grid max-w-3xl gap-6">
      {withVideo.map((c) => {
        const v = c.video!
        return (
          <figure key={c.id} className="grid gap-2">
            <figcaption className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              {sharedSession ? (
                <span className="font-medium">{t('report.videos.wholeFlow')}</span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground tabular">{t('report.videos.caseN', { n: String(c.position) })}</span>
                  <KeyBadge>{c.test_case_key}</KeyBadge>
                  <span className="font-medium">{c.title}</span>
                  <StatusBadge status={c.status} />
                </>
              )}
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular">
                {formatBytes(v.size_bytes)}
                {!v.expired && (
                  <a href={v.url} download={v.name} className="text-link hover:underline">
                    {t('common:actions.download')}
                  </a>
                )}
              </span>
            </figcaption>
            {v.expired ? (
              <ExpiredArtifact className="aspect-video w-full rounded-md" />
            ) : (
              <video
                controls
                preload="metadata"
                src={v.url}
                className="aspect-video w-full rounded-md border border-border bg-black"
                aria-label={sharedSession ? t('report.videos.runLabel', { key: run.key }) : t('report.videos.caseLabel', { key: c.test_case_key, title: c.title })}
              />
            )}
          </figure>
        )
      })}
    </div>
  )
}

/* ------------------------------------------------------------------ detail */

function DetailGroup({ title, rows }: { title: string; rows: [string, React.ReactNode][] }) {
  return (
    <section className="grid gap-2">
      <h2 className="text-sm font-semibold">{title}</h2>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 rounded-md border border-border px-4 py-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        {rows.map(([k, v]) => (
          <React.Fragment key={k}>
            <dt className="text-muted-foreground max-sm:mt-1.5 max-sm:text-xs">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </React.Fragment>
        ))}
      </dl>
    </section>
  )
}

function RunDetail({ run }: { run: Run }) {
  const o = run.options
  const allManual = run.cases.length > 0 && run.cases.every((c) => c.execution === 'manual')
  const mono = (v: React.ReactNode) => <span className="font-mono text-xs">{v}</span>
  const { t } = useTranslation('runs')
  return (
    <div className="grid max-w-3xl gap-6">
      {run.error_message && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold">{t('detail.error')}</h2>
          <pre className="rounded-md border border-status-error/40 bg-status-error-bg px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-status-error">
            {run.error_message}
          </pre>
        </section>
      )}
      <DetailGroup
        title={t('detail.run')}
        rows={[
          [t('detail.key'), mono(run.key)],
          [t('detail.id'), mono(run.id)],
          [t('detail.target'), <>{kindLabel(run.kind)} {mono(run.target.key)} · {run.target.title}</>],
          [t('detail.environment'), run.environment?.name ?? '—'],
          [t('detail.trigger'), <>{run.triggered_by.name} · {triggerLabel(run.trigger)}</>],
          ...(run.has_manual ? ([[t('detail.manualAssignee'), run.assignee?.name ?? '—']] as [string, React.ReactNode][]) : []),
        ]}
      />
      <DetailGroup
        title={t('detail.time')}
        rows={[
          [t('detail.queued'), <time dateTime={run.queued_at}>{formatDateTime(run.queued_at)}</time>],
          [t('detail.started'), run.started_at ? <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time> : '—'],
          [t('detail.finished'), run.finished_at ? <time dateTime={run.finished_at}>{formatDateTime(run.finished_at)}</time> : '—'],
          [t('detail.duration'), <span className="tabular">{formatDuration(run.duration_ms)}</span>],
        ]}
      />
      {!allManual && (
        <DetailGroup
          title={t('detail.options')}
          rows={[
            [t('detail.browser'), `${BROWSER_LABEL[o.browser]}${o.headless ? ' · headless' : ' · headed'}`],
            [
              t('detail.devices'),
              <ul className="flex flex-wrap gap-1.5" aria-label={t('detail.devices')}>
                {runDevices(run).map((d, i) => (
                  <li key={i}>
                    <DeviceChip device={d} />
                  </li>
                ))}
              </ul>,
            ],
            [t('detail.screenshot'), screenshotLabel(o.screenshot)],
            [t('detail.video'), videoLabel(o.video)],
            [t('detail.stepTimeout'), mono(`${o.step_timeout_ms} ms`)],
            [t('detail.retries'), <span className="tabular">{o.retries}</span>],
          ]}
        />
      )}
    </div>
  )
}
