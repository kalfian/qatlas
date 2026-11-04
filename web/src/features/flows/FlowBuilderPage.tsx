import { arrayMove } from '@dnd-kit/sortable'
import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, CircleAlert, ListPlus, Lock, MoreHorizontal, Play, Plus, RotateCw, Search, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { useCreateFlow, useDeleteFlow, useFlow, useUpdateFlow } from '@/api/queries'
import type { Flow } from '@/api/types'
import { useCan } from '@/app/auth'
import { KeyBadge } from '@/components/misc'
import { EmptyState, ErrorState, PageContainer } from '@/components/page'
import { StatusBadge } from '@/components/status'
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
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Tip } from '@/components/ui/tooltip'
import { RunDialog } from '@/features/runs/RunDialog'
import { i18n } from '@/i18n'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { FlowItemsList } from './FlowItemsList'
import { FlowSettings } from './FlowSettings'
import { TestCasePicker } from './TestCasePicker'
import {
  draftFromFlow,
  draftSignature,
  draftToInput,
  emptyDraft,
  itemIndexFromPath,
  newDraftItem,
  validateDraft,
  type DraftItem,
  type FlowCaseRef,
  type FlowDraft,
} from './flow-draft'
import { isMac, useDelayedFlag, useMediaQuery } from './hooks'

const ROUTE = '/_app/p/$key/flows/$flowKey'

function relative(iso: string | null) {
  if (iso && Date.now() - Date.parse(iso) < 60_000) return i18n.t('common:time.justNow')
  return formatRelative(iso)
}

export function FlowBuilderPage() {
  const { key, flowKey } = useParams({ from: ROUTE })
  if (flowKey === 'new') return <NewFlow key={`${key}/new`} projectKey={key} />
  return <ExistingFlow key={`${key}/${flowKey}`} projectKey={key} flowKey={flowKey} />
}

function NewFlow({ projectKey }: { projectKey: string }) {
  const canEdit = useCan('edit_tests', projectKey)
  const { t } = useTranslation('flows')
  if (!canEdit) {
    return (
      <PageContainer>
        <EmptyState
          icon={Lock}
          title={t('builder.noAccessTitle')}
          description={t('builder.noAccessDescription')}
          action={<BackToFlows projectKey={projectKey} />}
        />
      </PageContainer>
    )
  }
  return <FlowEditor projectKey={projectKey} flow={null} />
}

function ExistingFlow({ projectKey, flowKey }: { projectKey: string; flowKey: string }) {
  const q = useFlow(flowKey)
  const showSkeleton = useDelayedFlag(q.isLoading)
  const { t } = useTranslation('flows')
  const notFound = (q.error instanceof ApiError && q.error.status === 404) || (q.data && q.data.project_key !== projectKey)

  if (notFound) {
    return (
      <PageContainer>
        <EmptyState
          icon={Search}
          title={t('builder.notFoundTitle', { key: flowKey })}
          description={t('builder.notFoundDescription')}
          action={<BackToFlows projectKey={projectKey} />}
        />
      </PageContainer>
    )
  }
  if (q.isError) {
    return (
      <PageContainer>
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </PageContainer>
    )
  }
  if (!q.data) return showSkeleton ? <BuilderSkeleton /> : <div aria-busy="true" className="min-h-96" />
  return <FlowEditor projectKey={projectKey} flow={q.data} onReload={async () => (await q.refetch()).data} />
}

function BackToFlows({ projectKey }: { projectKey: string }) {
  const { t } = useTranslation('flows')
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/p/$key/flows" params={{ key: projectKey }}>
        <ArrowLeft /> {t('builder.backToList')}
      </Link>
    </Button>
  )
}

/* ------------------------------------------------------------------ editor */

interface ServerErrors {
  name?: string
  items?: string
  itemErrors: Record<string, string>
  other: string[]
}
const NO_SERVER_ERRORS: ServerErrors = { itemErrors: {}, other: [] }

function FlowEditor({ projectKey, flow, onReload }: { projectKey: string; flow: Flow | null; onReload?: () => Promise<Flow | undefined> }) {
  const isNew = flow === null
  const navigate = useNavigate()
  const canEdit = useCan('edit_tests', projectKey)
  const canRun = useCan('run', projectKey)
  const readOnly = !canEdit
  const wide = useMediaQuery('(min-width: 1280px)')
  const { t } = useTranslation(['flows', 'common'])

  const [saved, setSaved] = React.useState<Flow | null>(flow)
  const [draft, setDraft] = React.useState<FlowDraft>(() => (flow ? draftFromFlow(flow) : emptyDraft()))
  const [baseline, setBaseline] = React.useState(() => draftSignature(draft))
  const [attempted, setAttempted] = React.useState(false)
  const [serverErrors, setServerErrors] = React.useState<ServerErrors>(NO_SERVER_ERRORS)
  const [conflict, setConflict] = React.useState(false)
  const [reloading, setReloading] = React.useState(false)
  const [runOpen, setRunOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [live, setLive] = React.useState('')

  const create = useCreateFlow(projectKey)
  const update = useUpdateFlow(saved?.key ?? '')
  const del = useDeleteFlow()
  const saving = create.isPending || update.isPending

  const nameRef = React.useRef<HTMLInputElement>(null)
  const pickerInputRef = React.useRef<HTMLInputElement>(null)

  const issues = React.useMemo(() => validateDraft(draft), [draft])
  const dirty = draftSignature(draft) !== baseline
  const announce = React.useCallback((msg: string) => setLive((prev) => (prev === msg ? `${msg}\u00a0` : msg)), [])

  const patch = React.useCallback((fn: (d: FlowDraft) => FlowDraft) => setDraft(fn), [])

  // ---- unsaved-changes guard
  const dirtyRef = React.useRef(dirty)
  const allowNavRef = React.useRef(false)
  React.useLayoutEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current && !allowNavRef.current,
    enableBeforeUnload: () => dirtyRef.current && !allowNavRef.current,
    withResolver: true,
  })

  // ---- item operations
  const usage = React.useMemo(() => {
    const m = new Map<string, number>()
    for (const i of draft.items) m.set(i.test_case.id, (m.get(i.test_case.id) ?? 0) + 1)
    return m
  }, [draft.items])

  const addItem = (tc: FlowCaseRef) => {
    const n = draft.items.length + 1
    setDraft((d) => ({ ...d, items: [...d.items, newDraftItem(tc)] }))
    announce(t('builder.announce.added', { key: tc.key, n: String(n) }))
  }
  const moveItem = (from: number, to: number) => setDraft((d) => ({ ...d, items: arrayMove(d.items, from, to) }))
  const changeItem = (uid: string, p: Partial<Pick<DraftItem, 'continue_on_failure' | 'enabled'>>) =>
    setDraft((d) => ({ ...d, items: d.items.map((i) => (i.uid === uid ? { ...i, ...p } : i)) }))
  const removeItem = (uid: string) => {
    const index = draft.items.findIndex((i) => i.uid === uid)
    if (index < 0) return
    const removed = draft.items[index]
    setDraft((d) => ({ ...d, items: d.items.filter((i) => i.uid !== uid) }))
    setServerErrors((s) => {
      if (!s.itemErrors[uid]) return s
      const itemErrors = { ...s.itemErrors }
      delete itemErrors[uid]
      return { ...s, itemErrors }
    })
    announce(t('builder.announce.removed', { key: removed.test_case.key, n: String(index + 1) }))
    // fokus ke baris pengganti agar keyboard user tidak kehilangan posisi
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>('[data-grip]')
      ;(rows[Math.min(index, rows.length - 1)] ?? pickerInputRef.current)?.focus()
    })
    toast(t('builder.removedToast', { key: removed.test_case.key }), {
      duration: 5000,
      action: {
        label: t('common:actions.undo'),
        onClick: () => {
          setDraft((d) => {
            const items = [...d.items]
            items.splice(Math.min(index, items.length), 0, removed)
            return { ...d, items }
          })
          announce(t('builder.announce.restored', { key: removed.test_case.key, n: String(index + 1) }))
        },
      },
    })
  }

  // ---- errors (client mirror + server 422)
  const showRequired = attempted
  const itemErrors = { ...serverErrors.itemErrors, ...issues.itemErrors }
  const nameError = (showRequired && issues.name) || serverErrors.name
  const itemsError = (showRequired && issues.items) || (draft.items.length === 0 ? serverErrors.items : undefined)
  const firstItemError = draft.items.find((i) => itemErrors[i.uid])

  const focusFirstError = () => {
    requestAnimationFrame(() => {
      if (issues.name || serverErrors.name) return nameRef.current?.focus()
      const grip = document.querySelector<HTMLElement>('[data-invalid="true"] [data-grip]')
      if (grip) return grip.focus()
      if (Object.keys(issues.variableErrors).length) return document.getElementById('flow-vars-trigger')?.focus()
      if (draft.items.length === 0) {
        if (wide) pickerInputRef.current?.focus()
        else document.getElementById('flow-empty-add')?.focus()
      }
    })
  }

  // ---- save
  const save = async () => {
    if (readOnly || saving) return
    if (!isNew && !dirty) return
    setAttempted(true)
    if (issues.blocking > 0) {
      focusFirstError()
      announce(t('builder.announce.cannotSave', { count: issues.blocking }))
      return
    }
    const input = draftToInput(draft)
    const sig = draftSignature(draft)
    const uidsAtSave = draft.items.map((i) => i.uid)
    setServerErrors(NO_SERVER_ERRORS)
    try {
      if (isNew) {
        const f = await create.mutateAsync(input)
        allowNavRef.current = true
        toast.success(t('builder.created', { key: f.key }))
        navigate({ to: '/p/$key/flows/$flowKey', params: { key: projectKey, flowKey: f.key }, replace: true })
      } else {
        const f = await update.mutateAsync({ ...input, revision: saved!.revision })
        setSaved(f)
        setBaseline(sig)
        setAttempted(false)
        toast.success(t('builder.saved', { revision: String(f.revision) }))
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'revision_conflict') {
        setConflict(true)
        return
      }
      if (e instanceof ApiError && e.status === 422) {
        const next: ServerErrors = { itemErrors: {}, other: [] }
        for (const d of e.details) {
          const idx = itemIndexFromPath(d.path)
          if (idx !== null && uidsAtSave[idx]) next.itemErrors[uidsAtSave[idx]] = d.message
          else if (d.path === 'name') next.name = d.message
          else if (d.path === 'items') next.items = d.message
          else next.other.push(d.message)
        }
        if (!e.details.length) next.other.push(e.message)
        setServerErrors(next)
        requestAnimationFrame(() => {
          if (next.name) return nameRef.current?.focus()
          document.querySelector<HTMLElement>('[data-invalid="true"] [data-grip]')?.focus()
        })
        return
      }
      toast.error(t('builder.saveFailed', { message: errorMessage(e) }))
    }
  }
  const saveRef = React.useRef(save)
  React.useLayoutEffect(() => {
    saveRef.current = save
  })
  React.useEffect(() => {
    if (readOnly) return
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [readOnly])

  const reload = async () => {
    if (!onReload) return
    setReloading(true)
    try {
      const fresh = await onReload()
      if (fresh) {
        const d = draftFromFlow(fresh)
        setSaved(fresh)
        setDraft(d)
        setBaseline(draftSignature(d))
        setServerErrors(NO_SERVER_ERRORS)
        setAttempted(false)
        setConflict(false)
        toast.success(t('builder.reloaded', { revision: String(fresh.revision) }))
      }
    } catch (e) {
      toast.error(t('builder.reloadFailed', { message: errorMessage(e) }))
    } finally {
      setReloading(false)
    }
  }

  const confirmDelete = async () => {
    if (!saved) return
    try {
      await del.mutateAsync(saved.key)
      allowNavRef.current = true
      setDeleteOpen(false)
      toast.success(t('builder.deleted', { key: saved.key }))
      navigate({ to: '/p/$key/flows', params: { key: projectKey } })
    } catch (e) {
      toast.error(t('builder.deleteFailed', { message: errorMessage(e) }))
    }
  }

  // ---- run availability
  const enabledCount = draft.items.filter((i) => i.enabled).length
  const runBlockReason = isNew
    ? t('builder.runBlock.saveFirst')
    : issues.blocking > 0
      ? firstItemError && issues.itemErrors[firstItemError.uid]
        ? t('builder.runBlock.manualInShared', { key: firstItemError.test_case.key, n: String(draft.items.indexOf(firstItemError) + 1) })
        : t('builder.runBlock.invalid')
      : dirty
        ? t('builder.runBlock.unsaved')
        : enabledCount === 0
          ? t('builder.runBlock.allDisabled')
          : null

  const saveLabel = isMac ? '⌘S' : 'Ctrl S'
  const errorCount = Object.keys(itemErrors).length

  const picker = (
    <TestCasePicker
      projectKey={projectKey}
      usage={usage}
      sharedSession={draft.shared_session}
      onAdd={addItem}
      inputRef={pickerInputRef}
      className="min-h-0 flex-1"
    />
  )

  return (
    <PageContainer className="gap-4">
      {/* header */}
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-[min(100%,22rem)] flex-1 flex-col gap-1">
          <div className="flex min-w-0 items-center gap-2">
            {isNew ? <span className="shrink-0 text-xs font-medium text-muted-foreground">{t('builder.newFlow')}</span> : <KeyBadge className="shrink-0">{saved!.key}</KeyBadge>}
            {readOnly ? (
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{draft.name}</h1>
            ) : (
              <>
                <h1 className="sr-only">{isNew ? t('builder.newFlow') : t('builder.flowKey', { key: saved!.key })}</h1>
                <Input
                  ref={nameRef}
                  value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value
                    patch((d) => ({ ...d, name }))
                    if (serverErrors.name) setServerErrors((s) => ({ ...s, name: undefined }))
                  }}
                  placeholder={t('builder.namePlaceholder')}
                  aria-label={t('builder.nameLabel')}
                  aria-invalid={!!nameError || undefined}
                  aria-describedby={nameError ? 'flow-name-error' : undefined}
                  autoFocus={isNew}
                  maxLength={200}
                  className="h-9 min-w-0 flex-1 border-transparent bg-transparent px-2 text-xl placeholder:font-normal font-semibold tracking-tight hover:border-input focus-visible:border-input md:max-w-2xl"
                />
              </>
            )}
          </div>
          {nameError && (
            <p id="flow-name-error" className="flex items-center gap-1.5 pl-2 text-xs text-destructive">
              <CircleAlert className="size-3.5" aria-hidden /> {nameError}
            </p>
          )}
          {saved && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>{t('builder.revision', { revision: String(saved.revision) })}</span>
              <span>
                {t('builder.updated')} <time dateTime={saved.updated_at}>{relative(saved.updated_at)}</time>
              </span>
              <span className="flex items-center gap-1.5">
                {t('builder.lastRun')}
                {saved.last_run_status ? (
                  <>
                    <StatusBadge status={saved.last_run_status} />
                    <time dateTime={saved.last_run_at ?? undefined}>{relative(saved.last_run_at)}</time>
                  </>
                ) : (
                  <span>{t('builder.neverRun')}</span>
                )}
              </span>
            </div>
          )}
        </div>

        {(canEdit || canRun) && (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && dirty && (
              <span role="status" className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-status-blocked" aria-hidden /> {t('builder.unsaved')}
              </span>
            )}
            {canRun && (
              <Tip label={runBlockReason ?? t('builder.runTip')}>
                <Button
                  variant="outline"
                  aria-disabled={runBlockReason ? true : undefined}
                  aria-describedby={runBlockReason ? 'flow-run-reason' : undefined}
                  onClick={() => !runBlockReason && setRunOpen(true)}
                >
                  <Play /> {t('builder.run')}
                </Button>
              </Tip>
            )}
            {runBlockReason && (
              <span id="flow-run-reason" className="sr-only">
                {runBlockReason}
              </span>
            )}
            {canEdit && (
              <Button
                onClick={() => void save()}
                loading={saving}
                aria-disabled={!isNew && !dirty ? true : undefined}
                aria-keyshortcuts={isMac ? 'Meta+S' : 'Control+S'}
                title={!isNew && !dirty ? t('builder.noChanges') : undefined}
              >
                {t('common:actions.save')}
                <span className="font-mono text-[11px] font-normal opacity-70" aria-hidden>
                  {saveLabel}
                </span>
              </Button>
            )}
            {canEdit && !isNew && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label={t('common:a11y.moreActions')}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-destructive focus:text-destructive">
                    <Trash2 /> {t('builder.delete')}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </header>

      {conflict && (
        <div role="alert" className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-md border border-status-blocked/40 bg-status-blocked-bg px-4 py-2.5 text-sm">
          <CircleAlert className="size-4 shrink-0 text-status-blocked" aria-hidden />
          <p className="min-w-0 flex-1">
            <span className="font-medium">{t('builder.conflict.title')}</span>{' '}
            <span className="text-muted-foreground">{t('builder.conflict.hint')}</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void reload()} loading={reloading}>
            <RotateCw /> {t('builder.conflict.reload')}
          </Button>
        </div>
      )}

      {serverErrors.other.length > 0 && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-destructive/50 px-4 py-2.5 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
          <ul className="flex flex-col gap-0.5">
            {serverErrors.other.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </div>
      )}

      <FlowSettings draft={draft} patch={patch} variableErrors={issues.variableErrors} readOnly={readOnly} />

      <div className={cn('grid items-start gap-4', !readOnly && 'xl:grid-cols-[minmax(0,1fr)_20rem]')}>
        <section aria-labelledby="flow-items-heading" className="flex min-w-0 flex-col gap-2">
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
            <h2 id="flow-items-heading" className="text-sm font-semibold">
              {t('builder.itemsHeading')} <span className="font-normal text-muted-foreground tabular">({draft.items.length})</span>
              {draft.items.length > 0 && enabledCount < draft.items.length && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{t('builder.enabledCount', { count: enabledCount })}</span>
              )}
              {errorCount > 0 && (
                <span className="ml-2 text-xs font-medium text-destructive">
                  {t('builder.errorCount', { count: errorCount })}
                </span>
              )}
            </h2>
            {!readOnly && !wide && (
              <Button variant="outline" size="sm" onClick={() => setSheetOpen(true)}>
                <Plus /> {t('builder.addTestCase')}
              </Button>
            )}
          </div>

          {draft.items.length === 0 ? (
            <div
              className={cn(
                'flex flex-col items-start gap-2 rounded-md border border-dashed px-5 py-8',
                itemsError ? 'border-destructive' : 'border-border',
              )}
            >
              <ListPlus className="size-5 text-muted-foreground" aria-hidden />
              <p className="text-sm font-medium">{t('builder.emptyTitle')}</p>
              {readOnly ? null : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {wide ? t('builder.emptyHintWide') : t('builder.emptyHint')} {t('builder.emptyReorderHint')}
                  </p>
                  <Button
                    id="flow-empty-add"
                    size="sm"
                    variant="outline"
                    onClick={() => (wide ? pickerInputRef.current?.focus() : setSheetOpen(true))}
                    className="mt-1"
                  >
                    <Plus /> {t('builder.addTestCase')}
                  </Button>
                </>
              )}
              {itemsError && (
                <p role="alert" className="flex items-center gap-1.5 text-xs text-destructive">
                  <CircleAlert className="size-3.5" aria-hidden /> {itemsError}
                </p>
              )}
            </div>
          ) : (
            <div className="overflow-hidden rounded-md border border-border">
              <FlowItemsList
                items={draft.items}
                readOnly={readOnly}
                stopOnFailure={draft.stop_on_failure}
                errors={itemErrors}
                warnings={issues.itemWarnings}
                onMove={moveItem}
                onChange={changeItem}
                onRemove={removeItem}
                announce={announce}
              />
            </div>
          )}
          {!readOnly && draft.items.length > 1 && (
            <p className="text-xs text-muted-foreground">
              {t('builder.reorderHint')}
            </p>
          )}
        </section>

        {!readOnly && wide && (
          <aside
            aria-labelledby="flow-picker-heading"
            className="sticky top-16 flex h-[calc(100dvh-5rem)] max-h-[44rem] min-h-80 flex-col overflow-hidden rounded-md border border-border bg-card"
          >
            <div className="border-b border-border px-3 py-2">
              <h2 id="flow-picker-heading" className="text-sm font-semibold">
                {t('builder.addTestCase')}
              </h2>
              <p className="text-xs text-muted-foreground">{t('builder.pickerHint')}</p>
            </div>
            {picker}
          </aside>
        )}
      </div>

      {!readOnly && !wide && (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-[min(100vw,24rem)]">
            <div className="border-b border-border px-4 py-3 pr-10">
              <DialogTitle className="text-sm font-semibold">{t('builder.addTestCase')}</DialogTitle>
              <DialogDescription className="text-xs">{t('builder.pickerSheetHint')}</DialogDescription>
            </div>
            {picker}
          </SheetContent>
        </Dialog>
      )}

      <div aria-live="polite" className="sr-only">
        {live}
      </div>

      {saved && canRun && (
        <RunDialog
          projectKey={projectKey}
          target={{ kind: 'flow', key: saved.key, title: saved.name, hasManual: saved.has_manual }}
          open={runOpen}
          onOpenChange={setRunOpen}
        />
      )}

      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('builder.deleteTitle', { key: saved?.key ?? '' })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('builder.deleteBody', { name: saved?.name ?? '', count: saved?.items.length ?? 0 })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
              disabled={del.isPending}
            >
              {t('builder.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(o) => !o && blocker.reset?.()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('builder.leave.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('builder.leave.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>{t('builder.leave.stay')}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => blocker.proceed?.()}>
              {t('builder.leave.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  )
}

function BuilderSkeleton() {
  const { t } = useTranslation('flows')
  return (
    <PageContainer className="gap-4">
      <span className="sr-only" role="status">{t('builder.loading')}</span>
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-6 w-72" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex flex-col divide-y divide-border rounded-md border border-border">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-10 items-center gap-3 px-3">
              <Skeleton className="h-3 w-4" />
              <Skeleton className="h-3 w-14" />
              <Skeleton className="h-3 flex-1" />
              <Skeleton className="h-3 w-20" />
            </div>
          ))}
        </div>
        <Skeleton className="hidden h-80 xl:block" />
      </div>
    </PageContainer>
  )
}
