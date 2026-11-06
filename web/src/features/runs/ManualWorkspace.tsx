import { format } from 'date-fns'
import {
  ArrowLeft,
  ArrowRight,
  Ban,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleX,
  LoaderCircle,
  RotateCw,
  Upload,
  UserRoundCog,
  X,
  type LucideIcon,
} from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useCompleteManualCase, useManualStepResult, useMembers, useSetAssignee, useUploadAttachment } from '@/api/queries'
import type { Run, RunCase, RunStep, StepStatus } from '@/api/types'
import { DeviceIcon } from '@/components/devices'
import { StatusBadge, StatusIcon, STATUS_META } from '@/components/status'
import { Button, buttonVariants } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { deviceLabel } from '@/lib/devices'
import { formatBytes } from '@/lib/format'
import { cn, uid } from '@/lib/utils'
import { FileTile, Thumb } from './media'
import { attachmentItems, deviceOfCase, isImage, projectedManualStatus, type MediaItem } from './runUtils'

type ManualStatus = 'pending' | 'passed' | 'failed' | 'blocked' | 'skipped'
type Decision = Exclude<ManualStatus, 'pending'>

const toManual = (s: StepStatus): ManualStatus => (s === 'running' || s === 'error' ? 'pending' : s)
const needsActual = (s: StepStatus) => s === 'failed' || s === 'blocked'

const DECISIONS: { status: Decision; label: string; key: string; icon: LucideIcon; on: string }[] = [
  {
    status: 'passed',
    label: 'Pass',
    key: 'P',
    icon: CircleCheck,
    on: 'border-status-passed bg-status-passed-bg text-status-passed hover:bg-status-passed-bg hover:text-status-passed',
  },
  {
    status: 'failed',
    label: 'Fail',
    key: 'F',
    icon: CircleX,
    on: 'border-status-failed bg-status-failed-bg text-status-failed hover:bg-status-failed-bg hover:text-status-failed',
  },
  {
    status: 'blocked',
    label: 'Blocked',
    key: 'B',
    icon: Ban,
    on: 'border-status-blocked bg-status-blocked-bg text-status-blocked hover:bg-status-blocked-bg hover:text-status-blocked',
  },
  {
    status: 'skipped',
    label: 'Skip',
    key: 'S',
    icon: CircleDashed,
    on: 'border-status-skipped bg-status-skipped-bg text-status-skipped hover:bg-status-skipped-bg hover:text-status-skipped',
  },
]

const MAX_UPLOAD = 25 * 1024 * 1024
const MOD = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent) ? '⌘' : 'Ctrl'

interface Draft {
  status?: ManualStatus
  actual?: string
}

interface LocalUpload {
  localId: string
  file: File
  preview?: string
  stepId: string
  state: 'uploading' | 'error'
  error?: string
  retryable: boolean
}

function isTypingTarget(t: EventTarget | null) {
  return t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]')
}
function inOverlay(t: EventTarget | null) {
  return t instanceof HTMLElement && !!t.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')
}

/**
 * Mode eksekusi manual (ui-direction §Mode eksekusi manual).
 * `editable` = user adalah assignee dan berhak execute_manual; selain itu tampil read-only (ter-update lewat polling).
 */
export function ManualWorkspace({
  run,
  c,
  editable,
  canReassign,
  onOpenMedia,
  onFinished,
}: {
  run: Run
  c: RunCase
  editable: boolean
  canReassign: boolean
  onOpenMedia: (items: MediaItem[], index: number) => void
  onFinished: () => void
}) {
  const steps = c.steps
  const total = steps.length
  const save = useManualStepResult()
  const complete = useCompleteManualCase()
  const upload = useUploadAttachment()
  const { t } = useTranslation(['runs', 'common'])

  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({})
  const [idx, setIdx] = React.useState(() =>
    Math.max(
      0,
      steps.findIndex((s) => s.status === 'pending'),
    ),
  )
  const [invalid, setInvalid] = React.useState<string | null>(null)
  const [inflight, setInflight] = React.useState(0)
  const [savedAt, setSavedAt] = React.useState<Date | null>(null)
  const [saveError, setSaveError] = React.useState<{ stepId: string; status: ManualStatus; actual: string; message: string } | null>(null)
  const [uploads, setUploads] = React.useState<LocalUpload[]>([])
  const [dragging, setDragging] = React.useState(false)
  const [announce, setAnnounce] = React.useState('')
  const [finishOpen, setFinishOpen] = React.useState(false)
  const [finishing, setFinishing] = React.useState(false)
  const [finishError, setFinishError] = React.useState<string | null>(null)

  const cur = steps[Math.min(idx, total - 1)]
  const headingRef = React.useRef<HTMLHeadingElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const finishBtnRef = React.useRef<HTMLButtonElement>(null)
  const focusHeadingNext = React.useRef(false)
  const chain = React.useRef<Promise<unknown>>(Promise.resolve())
  const timers = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const draftsRef = React.useRef(drafts)
  const stepsRef = React.useRef(steps)
  React.useEffect(() => {
    draftsRef.current = drafts
    stepsRef.current = steps
  })

  const statusOf = (s: RunStep): ManualStatus => drafts[s.id]?.status ?? toManual(s.status)
  const actualOf = (s: RunStep): string => drafts[s.id]?.actual ?? s.actual_result ?? ''
  const latestStatus = (id: string): ManualStatus => {
    const d = draftsRef.current[id]?.status
    if (d) return d
    const s = stepsRef.current.find((x) => x.id === id)
    return s ? toManual(s.status) : 'pending'
  }
  const latestActual = (id: string): string => {
    const d = draftsRef.current[id]?.actual
    if (d !== undefined) return d
    return stepsRef.current.find((x) => x.id === id)?.actual_result ?? ''
  }

  /* ------------------------------------------------------------ autosave (diserialkan) */

  function persist(stepId: string, status: ManualStatus, actual: string): Promise<boolean> {
    setInflight((n) => n + 1)
    const p = chain.current
      .then(() => save.mutateAsync({ runKey: run.key, caseId: c.id, stepId, status, actual_result: actual }))
      .then(() => {
        setSavedAt(new Date())
        setSaveError((e) => (e?.stepId === stepId ? null : e))
        return true
      })
      .catch((err: unknown) => {
        setSaveError({ stepId, status, actual, message: errorMessage(err) })
        return false
      })
      .finally(() => setInflight((n) => n - 1))
    chain.current = p
    return p
  }

  function cancelTimer(stepId: string) {
    const timer = timers.current.get(stepId)
    if (timer) {
      clearTimeout(timer)
      timers.current.delete(stepId)
    }
  }

  function flushTimers(): Promise<boolean>[] {
    const out: Promise<boolean>[] = []
    for (const [stepId, timer] of timers.current) {
      clearTimeout(timer)
      out.push(persist(stepId, latestStatus(stepId), latestActual(stepId)))
    }
    timers.current.clear()
    return out
  }

  // simpan perubahan yang tertunda saat komponen dilepas (mis. pindah halaman)
  const flushRef = React.useRef(flushTimers)
  React.useEffect(() => {
    flushRef.current = flushTimers
  })
  React.useEffect(() => {
    const f = flushRef
    return () => {
      void f.current()
    }
  }, [])

  function onActualChange(text: string) {
    const id = cur.id
    setDrafts((d) => ({ ...d, [id]: { ...d[id], actual: text } }))
    if (invalid === id && text.trim()) setInvalid(null)
    cancelTimer(id)
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id)
        void persist(id, latestStatus(id), latestActual(id))
      }, 700),
    )
  }

  /* ------------------------------------------------------------ navigasi */

  function canLeave(): boolean {
    if (!editable) return true
    if (needsActual(statusOf(cur)) && !actualOf(cur).trim()) {
      setInvalid(cur.id)
      textareaRef.current?.focus()
      return false
    }
    return true
  }

  function goTo(i: number) {
    if (i < 0 || i >= total || i === idx) return
    if (!canLeave()) return
    setInvalid(null)
    focusHeadingNext.current = true
    setIdx(i)
  }

  React.useEffect(() => {
    if (!focusHeadingNext.current) return
    focusHeadingNext.current = false
    headingRef.current?.focus()
    setAnnounce(t('manual.stepOf', { n: String(idx + 1), total: String(total) }))
  }, [idx, total, t])

  /** Maju ke step berikutnya yang belum ditandai; jika semua sudah, fokus ke Selesai. */
  function advanceFrom(fromId: string, override: ManualStatus) {
    const st = (s: RunStep) => (s.id === fromId ? override : statusOf(s))
    const order = [...steps.slice(idx + 1), ...steps.slice(0, idx)]
    const next = order.find((s) => st(s) === 'pending')
    if (next) {
      focusHeadingNext.current = true
      setIdx(steps.indexOf(next))
    } else if (steps.every((s) => st(s) !== 'pending')) {
      setAnnounce(t('manual.allMarked'))
      requestAnimationFrame(() => finishBtnRef.current?.focus())
    }
  }

  function decide(status: Decision) {
    if (!editable) return
    const s = cur
    setDrafts((d) => ({ ...d, [s.id]: { ...d[s.id], status } }))
    cancelTimer(s.id)
    void persist(s.id, status, actualOf(s))
    if (status === 'passed' || status === 'skipped') {
      setInvalid(null)
      advanceFrom(s.id, status)
    } else {
      requestAnimationFrame(() => textareaRef.current?.focus())
    }
  }

  function saveAndNext() {
    cancelTimer(cur.id)
    void persist(cur.id, statusOf(cur), actualOf(cur))
    if (!canLeave()) return
    setInvalid(null)
    advanceFrom(cur.id, statusOf(cur))
  }

  /* ------------------------------------------------------------ lampiran */

  function startUpload(u: LocalUpload) {
    setUploads((list) => [...list.filter((x) => x.localId !== u.localId), { ...u, state: 'uploading', error: undefined }])
    upload
      .mutateAsync({ runKey: run.key, caseId: c.id, file: u.file, stepId: u.stepId })
      .then(() => {
        setUploads((list) => list.filter((x) => x.localId !== u.localId))
        if (u.preview) URL.revokeObjectURL(u.preview)
      })
      .catch((err: unknown) => {
        setUploads((list) => list.map((x) => (x.localId === u.localId ? { ...x, state: 'error', error: errorMessage(err) } : x)))
      })
  }

  function addFiles(files: File[], how: 'paste' | 'drop' | 'pick') {
    if (!editable || files.length === 0) return
    for (const file of files) {
      const u: LocalUpload = {
        localId: uid('up_'),
        file,
        preview: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
        stepId: cur.id,
        state: 'uploading',
        retryable: file.size <= MAX_UPLOAD,
      }
      if (file.size > MAX_UPLOAD) setUploads((list) => [...list, { ...u, state: 'error', error: t('manual.maxSize') }])
      else startUpload(u)
    }
    const names = files.map((f) => f.name || t('manual.imageFallback')).join(', ')
    setAnnounce(how === 'paste' ? t('manual.pasted', { count: files.length, names }) : t('manual.added', { count: files.length, names }))
  }

  function removeLocal(u: LocalUpload) {
    if (u.preview) URL.revokeObjectURL(u.preview)
    setUploads((list) => list.filter((x) => x.localId !== u.localId))
  }

  /* ------------------------------------------------------------ keyboard & paste global */

  const keyHandler = React.useRef<(e: KeyboardEvent) => void>(() => {})
  const pasteHandler = React.useRef<(e: ClipboardEvent) => void>(() => {})
  React.useEffect(() => {
    keyHandler.current = (e) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return
      if (isTypingTarget(e.target) || inOverlay(e.target) || finishOpen) return
      const k = e.key.toLowerCase()
      const d = DECISIONS.find((x) => x.key.toLowerCase() === k)
      if (d && editable) {
        e.preventDefault()
        decide(d.status)
      } else if (k === 'j') {
        e.preventDefault()
        goTo(idx + 1)
      } else if (k === 'k') {
        e.preventDefault()
        goTo(idx - 1)
      }
    }
    pasteHandler.current = (e) => {
      if (!editable || finishOpen || inOverlay(e.target)) return
      const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith('image/'))
      if (files.length === 0) return
      const hasText = !!e.clipboardData?.getData('text/plain')
      if (hasText && isTypingTarget(e.target)) return
      e.preventDefault()
      addFiles(
        files.map((f, i) =>
          f.name && f.name !== 'image.png' ? f : new File([f], `${t('manual.pastedFilePrefix')}-${format(new Date(), 'HHmmss')}${i ? `-${i}` : ''}.png`, { type: f.type }),
        ),
        'paste',
      )
    }
  })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e)
    const onPaste = (e: ClipboardEvent) => pasteHandler.current(e)
    document.addEventListener('keydown', onKey)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('paste', onPaste)
    }
  }, [])

  /* ------------------------------------------------------------ selesai */

  async function finish() {
    setFinishing(true)
    setFinishError(null)
    try {
      const results = await Promise.all(flushTimers())
      for (const s of steps) {
        if (statusOf(s) === 'pending') {
          setDrafts((d) => ({ ...d, [s.id]: { ...d[s.id], status: 'skipped' } }))
          results.push(await persist(s.id, 'skipped', actualOf(s)))
        }
      }
      await chain.current
      if (results.includes(false)) throw new Error(t('manual.partialSaveFailed'))
      const done = await complete.mutateAsync({ runKey: run.key, caseId: c.id })
      const fc = done.cases.find((x) => x.id === c.id)
      setFinishOpen(false)
      const msg = fc ? t('manual.finishedWithStatus', { key: c.test_case_key, status: STATUS_META[fc.status].label }) : t('manual.finished', { key: c.test_case_key })
      if (fc?.status === 'passed') toast.success(msg)
      else toast(msg)
      onFinished()
    } catch (err) {
      setFinishError(errorMessage(err))
    } finally {
      setFinishing(false)
    }
  }

  if (!cur) return <p className="px-3 py-4 text-sm text-muted-foreground">{t('manual.noSteps')}</p>

  const marked = steps.filter((s) => statusOf(s) !== 'pending').length
  const curStatus = statusOf(cur)
  const curAtts = c.attachments.filter((a) => a.run_step_id === cur.id)
  const curImages = attachmentItems(c, curAtts)
  const curUploads = uploads.filter((u) => u.stepId === cur.id)
  const isInvalid = invalid === cur.id
  const errStep = saveError ? steps.find((s) => s.id === saveError.stepId) : undefined

  return (
    <div>
      {/* toolbar */}
      <div className="sticky top-12 z-20 flex items-center gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 max-sm:gap-x-2">
        <MobileStepper steps={steps} idx={idx} statusOf={statusOf} onPick={goTo} />
        <span className="hidden text-sm font-medium tabular lg:inline">{t('manual.stepCounter', { n: String(idx + 1), total: String(total) })}</span>
        <span className="text-xs text-muted-foreground tabular max-sm:hidden">{t('manual.marked', { count: marked })}</span>
        {editable ? (
          <span aria-live="polite" className="inline-flex min-w-0 flex-1 items-center gap-1 truncate text-xs text-muted-foreground tabular">
            {inflight > 0 ? (
              <>
                <LoaderCircle className="size-3 shrink-0 animate-spin" aria-hidden /> {t('common:states.saving')}
              </>
            ) : saveError ? (
              <span className="text-status-failed">{t('manual.notSaved')}</span>
            ) : savedAt ? (
              t('manual.savedAt', { time: format(savedAt, 'HH:mm') })
            ) : (
              <>
                <span className="sm:hidden">{t('manual.autosaveShort')}</span>
                <span className="max-sm:hidden">{t('manual.autosave')}</span>
              </>
            )}
          </span>
        ) : (
          <span className="min-w-0 flex-1 text-xs text-muted-foreground">
            {t('steps.executedBy')} <span className="font-medium text-foreground">{run.assignee?.name ?? '—'}</span>
            <span className="max-sm:hidden"> · {t('manual.autoUpdated')}</span>
          </span>
        )}
        {canReassign && <ReassignMenu run={run} />}
        {editable && (
          <Button ref={finishBtnRef} size="default" className="shrink-0 max-sm:h-11" onClick={() => setFinishOpen(true)}>
            {t('manual.finish')}
          </Button>
        )}
      </div>

      {saveError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-status-failed/40 bg-status-failed-bg px-3 py-2 text-sm text-status-failed"
        >
          <span className="min-w-0 flex-1">
            {t('manual.saveError', { n: String(errStep?.position ?? ''), message: saveError.message })}
          </span>
          <Button size="sm" variant="outline" onClick={() => void persist(saveError.stepId, saveError.status, latestActual(saveError.stepId))}>
            <RotateCw /> {t('common:actions.retry')}
          </Button>
        </div>
      )}

      <div className="flex">
        {/* rail */}
        <nav aria-label={t('manual.railLabel')} className="hidden w-60 shrink-0 border-r border-border py-1 lg:block">
          <ol>
            {steps.map((s, i) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => goTo(i)}
                  aria-current={i === idx ? 'step' : undefined}
                  className={cn(
                    'relative flex w-full items-start gap-2 px-3 py-2 text-left text-sm transition-colors duration-150 hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                    i === idx && 'bg-muted font-medium before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:bg-ring',
                  )}
                >
                  <StatusIcon status={statusOf(s)} className="mt-0.5 shrink-0" />
                  <span className="mt-px w-4 shrink-0 text-xs text-muted-foreground tabular">{i + 1}</span>
                  <span className="line-clamp-2 min-w-0">{s.description || s.summary}</span>
                </button>
              </li>
            ))}
          </ol>
        </nav>

        {/* kolom fokus */}
        <div className="min-w-0 flex-1 px-4 py-5 md:px-6">
          <div className="grid max-w-2xl gap-6">
            <DeviceNote run={run} c={c} />
            <div>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('manual.instruction')}</p>
              <h2
                ref={headingRef}
                tabIndex={-1}
                className="mt-1 rounded-sm text-2xl leading-snug font-medium break-words focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 focus-visible:ring-offset-card"
              >
                <span className="sr-only">{`${t('manual.stepOf', { n: String(idx + 1), total: String(total) })}: `}</span>
                {cur.description || cur.summary}
              </h2>
              <p className="mt-5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{t('manual.expected')}</p>
              <p className="mt-1 text-lg break-words">{cur.expected || <span className="text-muted-foreground">{t('manual.noExpected')}</span>}</p>
            </div>

            {editable ? (
              <div role="group" aria-label={t('manual.resultGroup')} className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
                {DECISIONS.map((d) => {
                  const on = curStatus === d.status
                  return (
                    <button
                      key={d.status}
                      type="button"
                      aria-pressed={on}
                      aria-keyshortcuts={d.key}
                      onClick={() => decide(d.status)}
                      className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), 'justify-start gap-2 max-sm:h-11 sm:min-w-28', on && d.on)}
                    >
                      <d.icon aria-hidden />
                      {d.label}
                      <Kbd className="ml-auto bg-transparent" aria-hidden>
                        {d.key}
                      </Kbd>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">{t('manual.statusColon')}</span>
                <StatusBadge status={curStatus} />
              </div>
            )}

            {editable ? (
              <div className="grid gap-1.5">
                <Label htmlFor={`actual-${cur.id}`}>
                  {t('manual.actualResult')}
                  {needsActual(curStatus) ? (
                    <span className="font-normal text-muted-foreground"> {t('manual.requiredFor', { status: STATUS_META[curStatus].label })}</span>
                  ) : (
                    <span className="font-normal text-muted-foreground"> {t('manual.optional')}</span>
                  )}
                </Label>
                <Textarea
                  id={`actual-${cur.id}`}
                  ref={textareaRef}
                  rows={3}
                  value={actualOf(cur)}
                  onChange={(e) => onActualChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                      e.preventDefault()
                      saveAndNext()
                    }
                  }}
                  placeholder={t('manual.actualPlaceholder')}
                  aria-invalid={isInvalid || undefined}
                  aria-describedby={`actual-hint-${cur.id}${isInvalid ? ` actual-err-${cur.id}` : ''}`}
                />
                {isInvalid && (
                  <p id={`actual-err-${cur.id}`} className="text-xs text-status-failed">
                    {t('manual.actualRequired', { status: STATUS_META[curStatus].label })}
                  </p>
                )}
                <p id={`actual-hint-${cur.id}`} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Kbd>{MOD}</Kbd>+<Kbd>Enter</Kbd> {t('manual.saveAndNext')}
                </p>
              </div>
            ) : (
              <div className="grid gap-1">
                <p className="text-sm font-medium">{t('manual.actualResult')}</p>
                <p className="text-sm break-words whitespace-pre-wrap text-muted-foreground">{actualOf(cur) || t('manual.notFilled')}</p>
              </div>
            )}

            <div className="grid gap-2">
              <p className="text-sm font-medium" id={`att-label-${cur.id}`}>
                {t('manual.attachments')}
              </p>
              {editable && (
                <div
                  onDragOver={(e) => {
                    e.preventDefault()
                    setDragging(true)
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(e) => {
                    e.preventDefault()
                    setDragging(false)
                    addFiles(Array.from(e.dataTransfer.files), 'drop')
                  }}
                  className={cn(
                    'flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md border border-dashed border-input px-3 py-3 text-sm text-muted-foreground transition-colors duration-150 max-sm:border-0 max-sm:p-0',
                    dragging && 'border-ring bg-muted text-foreground',
                  )}
                >
                  <Upload className="size-4 max-sm:hidden" aria-hidden />
                  <span className="max-sm:hidden">{t('manual.dropHere')}</span>
                  <Button type="button" variant="link" className="h-auto px-0 text-sm max-sm:hidden" onClick={() => fileRef.current?.click()}>
                    {t('manual.chooseFile')}
                  </Button>
                  <span className="max-sm:hidden">{t('manual.orPaste', { mod: MOD })}</span>
                  <Button type="button" variant="outline" className="h-11 w-full sm:hidden" onClick={() => fileRef.current?.click()}>
                    <Upload /> {t('manual.takePhoto')}
                  </Button>
                  <input
                    ref={fileRef}
                    type="file"
                    multiple
                    accept="image/*,video/*"
                    className="sr-only"
                    tabIndex={-1}
                    aria-labelledby={`att-label-${cur.id}`}
                    onChange={(e) => {
                      addFiles(Array.from(e.target.files ?? []), 'pick')
                      e.target.value = ''
                    }}
                  />
                </div>
              )}
              {curAtts.length === 0 && curUploads.length === 0 ? (
                !editable && <p className="text-sm text-muted-foreground">{t('manual.noAttachments')}</p>
              ) : (
                <ul className="flex flex-wrap gap-2" aria-labelledby={`att-label-${cur.id}`}>
                  {curAtts.map((a) => {
                    const i = curImages.findIndex((m) => m.id === a.id)
                    return (
                      <li key={a.id}>
                        {isImage(a) ? (
                          <Thumb item={curImages[i]} onOpen={() => onOpenMedia(curImages, i)} className="h-16 w-28" />
                        ) : (
                          <FileTile name={a.name} url={a.url} mime={a.mime} sizeLabel={formatBytes(a.size_bytes)} />
                        )}
                      </li>
                    )
                  })}
                  {curUploads.map((u) => (
                    <li key={u.localId} className="relative h-16 w-28 overflow-hidden rounded-sm border border-border bg-muted">
                      {u.preview ? <img src={u.preview} alt="" className="size-full object-cover opacity-60" /> : null}
                      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-background/70 p-1 text-center text-xs">
                        {u.state === 'uploading' ? (
                          <>
                            <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-hidden />
                            <span className="sr-only">{t('manual.uploading', { name: u.file.name })}</span>
                          </>
                        ) : (
                          <>
                            <span className="line-clamp-2 text-status-failed">{u.error ?? t('manual.failed')}</span>
                            <span className="flex gap-1">
                              {u.retryable && (
                                <Button
                                  size="icon-sm"
                                  variant="outline"
                                  className="size-6"
                                  aria-label={t('manual.retryUpload', { name: u.file.name })}
                                  onClick={() => startUpload(u)}
                                >
                                  <RotateCw />
                                </Button>
                              )}
                              <Button size="icon-sm" variant="outline" className="size-6" aria-label={t('manual.removeUpload', { name: u.file.name })} onClick={() => removeLocal(u)}>
                                <X />
                              </Button>
                            </span>
                          </>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
              <Button variant="ghost" className="max-sm:h-11" disabled={idx === 0} onClick={() => goTo(idx - 1)} aria-keyshortcuts="K">
                <ArrowLeft /> {t('manual.previous')}{' '}
                <Kbd className="max-sm:hidden" aria-hidden>
                  K
                </Kbd>
              </Button>
              <Button variant="ghost" className="max-sm:h-11" disabled={idx === total - 1} onClick={() => goTo(idx + 1)} aria-keyshortcuts="J">
                <Kbd className="max-sm:hidden" aria-hidden>
                  J
                </Kbd>{' '}
                {t('manual.next')} <ArrowRight />
              </Button>
            </div>
          </div>
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        {announce}
      </p>

      {editable && (
        <FinishDialog
          returnFocusTo={finishBtnRef}
          open={finishOpen}
          onOpenChange={(o) => {
            setFinishOpen(o)
            if (!o) setFinishError(null)
          }}
          run={run}
          c={c}
          statusOf={statusOf}
          actualOf={actualOf}
          busy={finishing}
          error={finishError}
          onConfirm={() => void finish()}
          onJump={(i) => {
            setFinishOpen(false)
            focusHeadingNext.current = false
            setIdx(i)
            setInvalid(steps[i].id)
            requestAnimationFrame(() => textareaRef.current?.focus())
          }}
        />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ stepper mobile */

function MobileStepper({
  steps,
  idx,
  statusOf,
  onPick,
}: {
  steps: RunStep[]
  idx: number
  statusOf: (s: RunStep) => ManualStatus
  onPick: (i: number) => void
}) {
  const { t } = useTranslation('runs')
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="max-sm:h-11 lg:hidden">
          {t('manual.stepCounter', { n: String(idx + 1), total: String(steps.length) })} <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-80 w-[min(22rem,calc(100vw-2rem))] overflow-y-auto">
        <DropdownMenuRadioGroup value={String(idx)} onValueChange={(v) => onPick(Number(v))}>
          {steps.map((s, i) => (
            <DropdownMenuRadioItem key={s.id} value={String(i)} className="h-auto min-h-11 py-2 sm:min-h-8">
              <StatusIcon status={statusOf(s)} className="shrink-0" />
              <span className="w-4 shrink-0 text-xs text-muted-foreground tabular">{i + 1}</span>
              <span className="line-clamp-2">{s.description || s.summary}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ ganti assignee */

function ReassignMenu({ run }: { run: Run }) {
  const members = useMembers(run.project_key)
  const setAssignee = useSetAssignee()
  const eligible = (members.data?.data ?? []).filter((m) => m.role === 'editor' || m.role === 'maintainer')
  const { t } = useTranslation(['runs', 'common'])
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" className="shrink-0 max-sm:size-11 max-sm:px-0" loading={setAssignee.isPending} aria-label={t('manual.reassign')}>
          {!setAssignee.isPending && <UserRoundCog />} <span className="max-sm:hidden">{t('manual.reassign')}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-60">
        <DropdownMenuLabel>{t('manual.assigneeLabel')}</DropdownMenuLabel>
        {members.isPending && <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('manual.loadingMembers')}</p>}
        {members.isError && <p className="px-2 py-1.5 text-xs text-status-failed">{t('manual.membersFailed')}</p>}
        <DropdownMenuRadioGroup
          value={run.assignee?.id ?? ''}
          onValueChange={(id) => {
            if (id === run.assignee?.id) return
            const m = eligible.find((x) => x.user.id === id)
            setAssignee.mutate(
              { runKey: run.key, user_id: id },
              {
                onSuccess: () => toast.success(t('manual.reassigned', { name: m?.user.name ?? t('manual.otherMember') })),
                onError: (err) => toast.error(errorMessage(err)),
              },
            )
          }}
        >
          {eligible.map((m) => (
            <DropdownMenuRadioItem key={m.user.id} value={m.user.id}>
              <span className="min-w-0 flex-1 truncate">{m.user.name}</span>
              <span className="text-xs text-muted-foreground">{m.role === 'maintainer' ? t('common:roles.maintainer.label') : t('common:roles.editor.label')}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/* ------------------------------------------------------------------ dialog selesai */

function FinishDialog({
  returnFocusTo,
  open,
  onOpenChange,
  run,
  c,
  statusOf,
  actualOf,
  busy,
  error,
  onConfirm,
  onJump,
}: {
  returnFocusTo: React.RefObject<HTMLButtonElement | null>
  open: boolean
  onOpenChange: (o: boolean) => void
  run: Run
  c: RunCase
  statusOf: (s: RunStep) => ManualStatus
  actualOf: (s: RunStep) => string
  busy: boolean
  error: string | null
  onConfirm: () => void
  onJump: (i: number) => void
}) {
  const statuses = c.steps.map(statusOf)
  const count = (s: ManualStatus) => statuses.filter((x) => x === s).length
  const unmarked = c.steps.filter((s) => statusOf(s) === 'pending')
  const missing = c.steps.filter((s) => needsActual(statusOf(s)) && !actualOf(s).trim())
  const result = projectedManualStatus(statuses.map((s) => (s === 'pending' ? 'skipped' : s)))
  const hasMore = run.cases.some((x) => x.position > c.position && x.status === 'pending')
  const { t } = useTranslation(['runs', 'common'])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md"
        onCloseAutoFocus={(e) => {
          e.preventDefault()
          returnFocusTo.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('manual.finishDialog.title', { key: c.test_case_key })}</DialogTitle>
          <DialogDescription>
            {hasMore
              ? result === 'passed' || result === 'skipped'
                ? t('manual.finishDialog.continues')
                : t('manual.finishDialog.willBe', { status: STATUS_META[result].label })
              : t('manual.finishDialog.rule')}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border px-3 py-2.5 text-sm sm:grid-cols-4">
          {(['passed', 'failed', 'blocked', 'skipped'] as const).map((s) => (
            <div key={s} className="flex items-center gap-1.5">
              <StatusIcon status={s} />
              <dt className="sr-only">{STATUS_META[s].label}</dt>
              <dd className="tabular">
                <span className="font-medium">{count(s)}</span> <span className="text-xs text-muted-foreground">{STATUS_META[s].label}</span>
              </dd>
            </div>
          ))}
        </dl>
        <p className="flex items-center gap-2 text-sm">
          {t('manual.finishDialog.result')} <StatusBadge status={result} />
        </p>

        {missing.length > 0 && (
          <div role="alert" className="grid gap-1.5 rounded-md border border-status-failed/40 bg-status-failed-bg px-3 py-2 text-sm text-status-failed">
            <p>{t('manual.finishDialog.missingActual')}</p>
            <ul className="flex flex-wrap gap-1.5">
              {missing.map((s) => (
                <li key={s.id}>
                  <Button size="sm" variant="outline" onClick={() => onJump(c.steps.indexOf(s))}>
                    {t('manual.finishDialog.fillStep', { n: String(s.position) })}
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {unmarked.length > 0 && (
          <div className="grid gap-1.5">
            <p className="text-sm">
              <Trans
                t={t}
                i18nKey="manual.finishDialog.unmarked"
                count={unmarked.length}
                components={{ num: <span className="font-medium tabular" />, b: <span className="font-medium" /> }}
              />
            </p>
            <ul className="max-h-36 overflow-y-auto rounded-md border border-border text-sm">
              {unmarked.map((s) => (
                <li key={s.id} className="flex gap-2 border-b border-border px-3 py-1.5 last:border-0">
                  <span className="w-4 shrink-0 text-xs text-muted-foreground tabular">{s.position}</span>
                  <span className="line-clamp-1">{s.description || s.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p role="alert" className="text-sm text-status-failed">
            {error}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('common:actions.back')}
          </Button>
          <Button onClick={onConfirm} loading={busy} disabled={missing.length > 0} aria-disabled={missing.length > 0 || undefined}>
            {unmarked.length > 0 ? t('manual.finishDialog.skipRestAndFinish') : t('manual.finish')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Which device the tester must use for this case (docs/14: manual cases repeat per device). */
function DeviceNote({ run, c }: { run: Run; c: RunCase }) {
  const { t } = useTranslation('runs')
  const device = deviceOfCase(run, c)
  return (
    <div className="-mb-2 flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-sm" data-testid="manual-device">
      <DeviceIcon category={device.category} className="mt-0.5 size-4 text-muted-foreground" />
      <p className="min-w-0">
        <Trans t={t} i18nKey="manual.testOn" values={{ device: deviceLabel(device) }} components={{ b: <span className="font-medium" /> }} />
        <span className="block text-xs text-muted-foreground">{t('manual.testOnHint')}</span>
      </p>
    </div>
  )
}
