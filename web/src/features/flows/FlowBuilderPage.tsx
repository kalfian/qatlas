import { arrayMove } from '@dnd-kit/sortable'
import { Link, useBlocker, useNavigate, useParams } from '@tanstack/react-router'
import { ArrowLeft, CircleAlert, ListPlus, Lock, MoreHorizontal, Play, Plus, RotateCw, Search, Trash2 } from 'lucide-react'
import * as React from 'react'
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
  if (iso && Date.now() - Date.parse(iso) < 60_000) return 'baru saja'
  return formatRelative(iso)
}

export function FlowBuilderPage() {
  const { key, flowKey } = useParams({ from: ROUTE })
  if (flowKey === 'new') return <NewFlow key={`${key}/new`} projectKey={key} />
  return <ExistingFlow key={`${key}/${flowKey}`} projectKey={key} flowKey={flowKey} />
}

function NewFlow({ projectKey }: { projectKey: string }) {
  const canEdit = useCan('edit_tests', projectKey)
  if (!canEdit) {
    return (
      <PageContainer>
        <EmptyState
          icon={Lock}
          title="Kamu tidak punya akses untuk membuat flow."
          description="Hanya editor dan maintainer project yang bisa menyusun flow."
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
  const notFound = (q.error instanceof ApiError && q.error.status === 404) || (q.data && q.data.project_key !== projectKey)

  if (notFound) {
    return (
      <PageContainer>
        <EmptyState
          icon={Search}
          title={`Flow ${flowKey} tidak ditemukan.`}
          description="Flow ini mungkin sudah dihapus atau key-nya salah."
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
  return (
    <Button asChild variant="outline" size="sm">
      <Link to="/p/$key/flows" params={{ key: projectKey }}>
        <ArrowLeft /> Kembali ke Flows
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
    announce(`${tc.key} ditambahkan di posisi ${n}.`)
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
    announce(`${removed.test_case.key} dihapus dari posisi ${index + 1}.`)
    // fokus ke baris pengganti agar keyboard user tidak kehilangan posisi
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll<HTMLElement>('[data-grip]')
      ;(rows[Math.min(index, rows.length - 1)] ?? pickerInputRef.current)?.focus()
    })
    toast(`${removed.test_case.key} dihapus dari flow`, {
      duration: 5000,
      action: {
        label: 'Urungkan',
        onClick: () => {
          setDraft((d) => {
            const items = [...d.items]
            items.splice(Math.min(index, items.length), 0, removed)
            return { ...d, items }
          })
          announce(`${removed.test_case.key} dikembalikan ke posisi ${index + 1}.`)
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
      announce(`Flow belum bisa disimpan: ${issues.blocking} masalah perlu diperbaiki.`)
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
        toast.success(`Flow ${f.key} dibuat`)
        navigate({ to: '/p/$key/flows/$flowKey', params: { key: projectKey, flowKey: f.key }, replace: true })
      } else {
        const f = await update.mutateAsync({ ...input, revision: saved!.revision })
        setSaved(f)
        setBaseline(sig)
        setAttempted(false)
        toast.success(`Flow tersimpan · revisi ${f.revision}`)
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
      toast.error(`Gagal menyimpan flow: ${errorMessage(e)}`)
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
        toast.success(`Flow dimuat ulang · revisi ${fresh.revision}`)
      }
    } catch (e) {
      toast.error(`Gagal memuat ulang: ${errorMessage(e)}`)
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
      toast.success(`Flow ${saved.key} dihapus`)
      navigate({ to: '/p/$key/flows', params: { key: projectKey } })
    } catch (e) {
      toast.error(`Gagal menghapus flow: ${errorMessage(e)}`)
    }
  }

  // ---- run availability
  const enabledCount = draft.items.filter((i) => i.enabled).length
  const runBlockReason = isNew
    ? 'Simpan flow dulu sebelum menjalankannya.'
    : issues.blocking > 0
      ? firstItemError && issues.itemErrors[firstItemError.uid]
        ? `Flow belum valid: ${firstItemError.test_case.key} (posisi ${draft.items.indexOf(firstItemError) + 1}) manual tidak boleh ada di flow shared session.`
        : 'Flow belum valid. Perbaiki error yang ditandai dulu.'
      : dirty
        ? 'Simpan perubahan dulu. Run memakai versi flow yang tersimpan.'
        : enabledCount === 0
          ? 'Semua test case di flow ini nonaktif.'
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
            {isNew ? <span className="shrink-0 text-xs font-medium text-muted-foreground">Flow baru</span> : <KeyBadge className="shrink-0">{saved!.key}</KeyBadge>}
            {readOnly ? (
              <h1 className="min-w-0 truncate text-xl font-semibold tracking-tight">{draft.name}</h1>
            ) : (
              <>
                <h1 className="sr-only">{isNew ? 'Flow baru' : `Flow ${saved!.key}`}</h1>
                <Input
                  ref={nameRef}
                  value={draft.name}
                  onChange={(e) => {
                    const name = e.target.value
                    patch((d) => ({ ...d, name }))
                    if (serverErrors.name) setServerErrors((s) => ({ ...s, name: undefined }))
                  }}
                  placeholder="Nama flow, mis. Checkout happy path"
                  aria-label="Nama flow"
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
              <span>Revisi {saved.revision}</span>
              <span>
                Diubah <time dateTime={saved.updated_at}>{relative(saved.updated_at)}</time>
              </span>
              <span className="flex items-center gap-1.5">
                Last run
                {saved.last_run_status ? (
                  <>
                    <StatusBadge status={saved.last_run_status} />
                    <time dateTime={saved.last_run_at ?? undefined}>{relative(saved.last_run_at)}</time>
                  </>
                ) : (
                  <span>belum pernah</span>
                )}
              </span>
            </div>
          )}
        </div>

        {(canEdit || canRun) && (
          <div className="flex flex-wrap items-center gap-2">
            {canEdit && dirty && (
              <span role="status" className="mr-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className="size-1.5 rounded-full bg-status-blocked" aria-hidden /> Belum disimpan
              </span>
            )}
            {canRun && (
              <Tip label={runBlockReason ?? 'Jalankan flow ini'}>
                <Button
                  variant="outline"
                  aria-disabled={runBlockReason ? true : undefined}
                  aria-describedby={runBlockReason ? 'flow-run-reason' : undefined}
                  onClick={() => !runBlockReason && setRunOpen(true)}
                >
                  <Play /> Run
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
                title={!isNew && !dirty ? 'Belum ada perubahan' : undefined}
              >
                Simpan
                <span className="font-mono text-[11px] font-normal opacity-70" aria-hidden>
                  {saveLabel}
                </span>
              </Button>
            )}
            {canEdit && !isNew && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" aria-label="Aksi lain">
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => setDeleteOpen(true)} className="text-destructive focus:text-destructive">
                    <Trash2 /> Hapus flow
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
            <span className="font-medium">Flow ini sudah diubah orang lain sejak kamu membukanya.</span>{' '}
            <span className="text-muted-foreground">Muat ulang untuk mengambil versi terbaru. Perubahanmu yang belum disimpan akan dibuang.</span>
          </p>
          <Button variant="outline" size="sm" onClick={() => void reload()} loading={reloading}>
            <RotateCw /> Muat ulang
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
              Test case <span className="font-normal text-muted-foreground tabular">({draft.items.length})</span>
              {draft.items.length > 0 && enabledCount < draft.items.length && (
                <span className="ml-2 text-xs font-normal text-muted-foreground">{enabledCount} aktif</span>
              )}
              {errorCount > 0 && (
                <span className="ml-2 text-xs font-medium text-destructive">
                  {errorCount} error
                </span>
              )}
            </h2>
            {!readOnly && !wide && (
              <Button variant="outline" size="sm" onClick={() => setSheetOpen(true)}>
                <Plus /> Tambah test case
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
              <p className="text-sm font-medium">Flow ini belum berisi test case.</p>
              {readOnly ? null : (
                <>
                  <p className="text-sm text-muted-foreground">
                    {wide ? 'Pilih dari panel Tambah test case di kanan.' : 'Tambahkan dari daftar test case project.'} Urutan bisa diubah dengan drag
                    atau keyboard.
                  </p>
                  <Button
                    id="flow-empty-add"
                    size="sm"
                    variant="outline"
                    onClick={() => (wide ? pickerInputRef.current?.focus() : setSheetOpen(true))}
                    className="mt-1"
                  >
                    <Plus /> Tambah test case
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
              Ubah urutan dengan menggeser pegangan di kiri, atau fokuskan pegangan lalu tekan Alt + ↑/↓.
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
                Tambah test case
              </h2>
              <p className="text-xs text-muted-foreground">Klik atau Enter untuk menambah ke akhir flow.</p>
            </div>
            {picker}
          </aside>
        )}
      </div>

      {!readOnly && !wide && (
        <Dialog open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="right" className="w-[min(100vw,24rem)]">
            <div className="border-b border-border px-4 py-3 pr-10">
              <DialogTitle className="text-sm font-semibold">Tambah test case</DialogTitle>
              <DialogDescription className="text-xs">Klik atau Enter untuk menambah ke akhir flow. Panel tetap terbuka.</DialogDescription>
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
            <AlertDialogTitle>Hapus flow {saved?.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              "{saved?.name}" beserta urutan {saved?.items.length ?? 0} test case-nya akan dihapus. Test case-nya sendiri dan riwayat run tetap ada.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Batal</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={(e) => {
                e.preventDefault()
                void confirmDelete()
              }}
              disabled={del.isPending}
            >
              Hapus flow
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(o) => !o && blocker.reset?.()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buang perubahan?</AlertDialogTitle>
            <AlertDialogDescription>Perubahan pada flow ini belum disimpan dan akan hilang kalau kamu pindah halaman.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>Tetap di sini</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => blocker.proceed?.()}>
              Buang perubahan
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  )
}

function BuilderSkeleton() {
  return (
    <PageContainer className="gap-4">
      <span className="sr-only" role="status">Memuat flow…</span>
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
