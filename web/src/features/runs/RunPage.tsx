import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowDown, Ban, ChevronDown, Ellipsis, FileJson, Film, ImageOff, Link2, RotateCw, SlidersHorizontal, SearchX } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { useCancelRun, useRerun, useRunProgress } from '@/api/queries'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { formatBytes, formatDateTime, formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { scrollToElement, useDelayedFlag, useNow, usePrefersReducedMotion } from './hooks'
import { ManualWorkspace } from './ManualWorkspace'
import { ExpiredArtifact, Lightbox, Thumb } from './media'
import { RunDialog } from './RunDialog'
import { CaseList } from './RunSteps'
import {
  BROWSER_LABEL,
  collectScreenshots,
  downloadJson,
  failedStepCount,
  firstFailedStep,
  formatClock,
  isActive,
  isLive,
  KIND_LABEL,
  manualCaseOf,
  SCREENSHOT_LABEL,
  tallySteps,
  TRIGGER_LABEL,
  VIDEO_LABEL,
  type MediaItem,
} from './runUtils'

type Tab = 'steps' | 'screenshots' | 'video' | 'detail'

export function RunPage() {
  const { key, runKey } = useParams({ from: '/_app/p/$key/runs/$runKey' })
  const q = useRunProgress(runKey)
  const showSkeleton = useDelayedFlag(q.isPending)

  if (q.isPending) return showSkeleton ? <RunSkeleton /> : <div className="min-h-96" aria-busy="true" />
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404)
      return (
        <PageContainer>
          <EmptyState
            icon={SearchX}
            title={`Run ${runKey} tidak ditemukan`}
            description="Run ini tidak ada di project ini, atau sudah dihapus."
            action={
              <Button asChild variant="outline">
                <Link to="/p/$key/runs" params={{ key }}>
                  Kembali ke daftar run
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
  return (
    <PageContainer>
      <div className="grid gap-2" aria-busy="true" aria-label="Memuat run">
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

  const manualCase = manualCaseOf(run)
  const editable = !!manualCase && canExecute && run.assignee?.id === me.user.id

  const [tab, setTab] = React.useState<Tab>('steps')
  const [caseOpen, setCaseOpen] = React.useState<Record<string, boolean>>({})
  const [stepOpen, setStepOpen] = React.useState<Record<string, boolean>>({})
  const [lightbox, setLightbox] = React.useState<{ items: MediaItem[]; index: number } | null>(null)

  const screenshots = React.useMemo(() => collectScreenshots(run), [run])
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
      if (c.status === 'running' && c.execution === 'automated') msgs.push(`Case ${c.position} ${c.test_case_key} berjalan`)
      else if (c.status !== 'pending' && c.status !== 'running')
        msgs.push(`Case ${c.position} ${c.status === 'failed' ? 'gagal' : STATUS_META[c.status].label}`)
    }
    if (prev.status !== run.status) {
      if (!isActive(run.status)) {
        const failed = run.summary.cases.failed
        msgs.push(`Run selesai: ${STATUS_META[run.status].label}${failed ? `, ${failed} dari ${run.summary.cases.total} case gagal` : ''}`)
      } else if (run.status === 'awaiting_manual') {
        msgs.push(`Run menunggu eksekusi manual oleh ${run.assignee?.name ?? 'assignee'}`)
      } else if (prev.status === 'awaiting_manual' && run.status === 'running') {
        msgs.push('Run dilanjutkan')
      }
    }
    if (msgs.length) setAnnouncement(msgs.join('. '))
  }, [run])

  const titleRef = React.useRef<HTMLHeadingElement>(null)

  const onToggleCase = (id: string, open: boolean) => setCaseOpen((o) => ({ ...o, [id]: open }))
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
          <span className="font-medium">Error infrastruktur:</span>
          <span className="min-w-0 font-mono text-xs leading-5 break-words">{run.error_message}</span>
        </div>
      )}
      {run.cancel_requested && isLive(run.status) && (
        <p className="text-sm text-muted-foreground">Pembatalan diminta, menunggu step yang sedang berjalan berhenti…</p>
      )}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="grid gap-4">
        <TabsList aria-label="Bagian report">
          <TabsTrigger value="steps">Steps</TabsTrigger>
          <TabsTrigger value="screenshots">
            Screenshots <span className="text-xs text-muted-foreground tabular">{screenshots.length}</span>
          </TabsTrigger>
          <TabsTrigger value="video">
            Video <span className="text-xs text-muted-foreground tabular">{videos.length}</span>
          </TabsTrigger>
          <TabsTrigger value="detail">Detail</TabsTrigger>
        </TabsList>

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
          {failCount} step gagal <ArrowDown />
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
  const rerun = useRerun()
  const { copy } = useCopy()
  const [confirmCancel, setConfirmCancel] = React.useState(false)
  const [dialog, setDialog] = React.useState(false)
  const cancelBtn = React.useRef<HTMLButtonElement>(null)
  const rerunBtn = React.useRef<HTMLButtonElement>(null)

  const live = isLive(run.status)
  const now = useNow(live)
  const startIso = run.started_at ?? run.queued_at
  const elapsed = live ? now - Date.parse(startIso) : null

  const showCancel = isActive(run.status) && (canCancelAny || (canCancelOwn && run.triggered_by.id === me.user.id))
  const allManual = run.cases.length > 0 && run.cases.every((c) => c.execution === 'manual')
  const failedCases = run.cases.filter((c) => ['failed', 'error', 'blocked', 'skipped'].includes(c.status)).length
  const primaryRerun = !isActive(run.status)

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
            <span className="text-sm text-muted-foreground tabular" title="Durasi berjalan">
              <span className="sr-only">Durasi </span>
              {formatClock(elapsed)}
            </span>
          ) : (
            run.duration_ms != null &&
            !isActive(run.status) && (
              <span className="text-sm text-muted-foreground tabular">
                <span className="sr-only">Durasi </span>
                {formatDuration(run.duration_ms)}
              </span>
            )
          )}
        </div>
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm text-muted-foreground">
          <span>{KIND_LABEL[run.kind]}</span>
          {target}
          <span className="min-w-0 text-foreground">{run.target.title}</span>
          {sep}
          <span>{run.environment?.name ?? 'tanpa environment'}</span>
          {!allManual && (
            <>
              {sep}
              <span>{BROWSER_LABEL[run.options.browser]}</span>
            </>
          )}
          {sep}
          <span>
            oleh <span className="text-foreground">{run.triggered_by.name}</span>
            {run.trigger !== 'manual' && ` ${run.trigger === 'schedule' ? '(terjadwal)' : TRIGGER_LABEL[run.trigger]}`}
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
            <Ban /> {run.cancel_requested ? 'Membatalkan…' : 'Cancel'}
          </Button>
        )}
        {canRun && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button ref={rerunBtn} variant={primaryRerun ? 'default' : 'outline'} className="max-sm:h-11" loading={rerun.isPending}>
                {!rerun.isPending && <RotateCw />} Re-run <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-56">
              <DropdownMenuItem onSelect={() => doRerun(false)}>
                <RotateCw /> Re-run (opsi sama)
              </DropdownMenuItem>
              {run.kind === 'flow' && (
                <DropdownMenuItem disabled={failedCases === 0 || isActive(run.status)} onSelect={() => doRerun(true)}>
                  <RotateCw />
                  <span className="flex-1">Re-run yang gagal</span>
                  {failedCases > 0 && <span className="text-xs text-muted-foreground tabular">{failedCases} case</span>}
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setDialog(true)}>
                <SlidersHorizontal /> Ubah opsi & run…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="icon" className="max-sm:size-11" aria-label="Aksi lain">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-48">
            <DropdownMenuItem onSelect={() => copy(`${window.location.origin}/p/${run.project_key}/runs/${run.key}`, 'Link run disalin')}>
              <Link2 /> Salin link
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                downloadJson(`${run.key}.json`, run)
                toast.success(`${run.key}.json diunduh`)
              }}
            >
              <FileJson /> Export JSON
            </DropdownMenuItem>
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
            <AlertDialogTitle>Batalkan run {run.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              {run.status === 'awaiting_manual'
                ? 'Case manual yang sedang dikerjakan dan case berikutnya akan ditandai Skipped. Hasil yang sudah ada tetap tersimpan.'
                : 'Step yang sedang berjalan dihentikan dan sisa step ditandai Skipped. Hasil yang sudah ada tetap tersimpan.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Kembali</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() =>
                cancel.mutate(run.key, {
                  onError: (e) => toast.error(errorMessage(e)),
                })
              }
            >
              Batalkan run
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
  const t = tallySteps(run)
  const pct = (n: number) => (t.total ? (n / t.total) * 100 : 0)
  const parts: React.ReactNode[] = []
  if (t.passed) parts.push(<span key="p">{t.passed} passed</span>)
  if (t.failed)
    parts.push(
      <span key="f" className="font-medium text-status-failed">
        {t.failed} failed
      </span>,
    )
  if (t.error)
    parts.push(
      <span key="e" className="font-medium text-status-error">
        {t.error} error
      </span>,
    )
  if (t.blocked)
    parts.push(
      <span key="b" className="font-medium text-status-blocked">
        {t.blocked} blocked
      </span>,
    )
  if (t.skipped) parts.push(<span key="s">{t.skipped} skipped</span>)

  return (
    <div className="grid gap-1.5">
      <div
        role="progressbar"
        aria-label="Progres run"
        aria-valuemin={0}
        aria-valuemax={t.total}
        aria-valuenow={t.done}
        aria-valuetext={`${t.done} dari ${t.total} step`}
        className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted"
      >
        {SEGMENTS.map(({ k, cls }) =>
          t[k] ? (
            <div key={k} className={cn('h-full transition-[width] duration-150 ease-out motion-reduce:transition-none', cls)} style={{ width: `${pct(t[k])}%` }} />
          ) : null,
        )}
      </div>
      <p className="flex flex-wrap gap-x-1.5 text-xs text-muted-foreground tabular">
        <span className="text-foreground">
          {t.done}/{t.total} step
        </span>
        {parts.map((p, i) => (
          <React.Fragment key={i}>
            <span aria-hidden>·</span>
            {p}
          </React.Fragment>
        ))}
        {run.kind === 'flow' && (
          <>
            <span aria-hidden>·</span>
            <span>
              {run.summary.cases.passed}/{run.summary.cases.total} case passed
            </span>
          </>
        )}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ screenshots */

function ScreenshotGallery({ run, items, onOpen }: { run: Run; items: MediaItem[]; onOpen: (i: number) => void }) {
  if (items.length === 0)
    return (
      <EmptyState
        icon={ImageOff}
        title={isLive(run.status) ? 'Belum ada screenshot' : 'Tidak ada screenshot di run ini'}
        description={`Opsi screenshot run ini: ${SCREENSHOT_LABEL[run.options.screenshot]}.${run.options.screenshot === 'on_failure' ? ' Screenshot hanya diambil saat step gagal.' : ''}`}
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
  if (withVideo.length === 0)
    return (
      <EmptyState
        icon={Film}
        title={isLive(run.status) ? 'Video tersedia setelah case selesai' : 'Tidak ada video di run ini'}
        description={`Opsi video run ini: ${VIDEO_LABEL[run.options.video]}.${run.options.video === 'on_failure' ? ' Video disimpan hanya untuk case yang gagal.' : ''}`}
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
                <span className="font-medium">Seluruh flow · satu sesi browser</span>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground tabular">Case {c.position}</span>
                  <KeyBadge>{c.test_case_key}</KeyBadge>
                  <span className="font-medium">{c.title}</span>
                  <StatusBadge status={c.status} />
                </>
              )}
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground tabular">
                {formatBytes(v.size_bytes)}
                {!v.expired && (
                  <a href={v.url} download={v.name} className="text-link hover:underline">
                    Unduh
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
                aria-label={sharedSession ? `Video run ${run.key}` : `Video ${c.test_case_key} ${c.title}`}
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
  return (
    <div className="grid max-w-3xl gap-6">
      {run.error_message && (
        <section className="grid gap-2">
          <h2 className="text-sm font-semibold">Error</h2>
          <pre className="rounded-md border border-status-error/40 bg-status-error-bg px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap text-status-error">
            {run.error_message}
          </pre>
        </section>
      )}
      <DetailGroup
        title="Run"
        rows={[
          ['Key', mono(run.key)],
          ['ID', mono(run.id)],
          ['Target', <>{KIND_LABEL[run.kind]} {mono(run.target.key)} · {run.target.title}</>],
          ['Environment', run.environment?.name ?? '—'],
          ['Pemicu', <>{run.triggered_by.name} · {TRIGGER_LABEL[run.trigger]}</>],
          ...(run.has_manual ? ([['Assignee manual', run.assignee?.name ?? '—']] as [string, React.ReactNode][]) : []),
        ]}
      />
      <DetailGroup
        title="Waktu"
        rows={[
          ['Masuk antrean', <time dateTime={run.queued_at}>{formatDateTime(run.queued_at)}</time>],
          ['Mulai', run.started_at ? <time dateTime={run.started_at}>{formatDateTime(run.started_at)}</time> : '—'],
          ['Selesai', run.finished_at ? <time dateTime={run.finished_at}>{formatDateTime(run.finished_at)}</time> : '—'],
          ['Durasi', <span className="tabular">{formatDuration(run.duration_ms)}</span>],
        ]}
      />
      {!allManual && (
        <DetailGroup
          title="Opsi run"
          rows={[
            ['Browser', `${BROWSER_LABEL[o.browser]}${o.headless ? ' · headless' : ' · headed'}`],
            ['Viewport', mono(`${o.viewport.width}×${o.viewport.height}`)],
            ['Screenshot', SCREENSHOT_LABEL[o.screenshot]],
            ['Video', VIDEO_LABEL[o.video]],
            ['Timeout per step', mono(`${o.step_timeout_ms} ms`)],
            ['Retries', <span className="tabular">{o.retries}</span>],
          ]}
        />
      )}
    </div>
  )
}
