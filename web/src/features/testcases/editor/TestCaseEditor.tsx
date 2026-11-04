import { useBlocker, useNavigate, useSearch } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ChevronDown, CircleAlert, Keyboard, ListPlus, Play, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { qk, useCreateTestCase, useEnvironments, useUpdateTestCase } from '@/api/queries'
import type { Step, StepAction, StepStatus, TestCase, TestCaseInput } from '@/api/types'
import { useCan } from '@/app/auth'
import { KeyBadge, ManualBadge } from '@/components/misc'
import { EmptyState, PageContainer } from '@/components/page'
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
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Tip } from '@/components/ui/tooltip'
import { RunDialog } from '@/features/runs/RunDialog'
import { errorsByStep, newStep, validateSteps } from '@/lib/steps'
import { cn } from '@/lib/utils'
import {
  draftFromCase,
  draftFromInput,
  draftToInput,
  draftToJsonDoc,
  isTypingTarget,
  locateIssues,
  MOD_LABEL,
  newStepId,
  parseJsonDoc,
  sameDraft,
  type Draft,
  type JsonIssue,
} from '../lib'
import { InfoTab } from './InfoTab'
import { JsonView } from './JsonView'
import { RevisionsTab } from './RevisionsTab'
import { RunsTab } from './RunsTab'
import { EmptyPanel, StepPanel } from './StepPanel'
import { StepList, type StepListHandlers } from './StepList'
import { VariablesTab } from './VariablesTab'
import { VarSuggestionsContext, type VarSuggestion } from './VarField'

type Tab = 'steps' | 'variables' | 'info' | 'revisions' | 'runs'
const FROM = '/_app/p/$key/tests/$caseKey' as const

const FN_SUGGESTIONS: VarSuggestion[] = [
  { token: 'fn.uuid', ns: 'fn', hint: 'UUID acak' },
  { token: 'fn.now', ns: 'fn', hint: 'waktu sekarang (ISO)' },
  { token: 'fn.random_email', ns: 'fn', hint: 'email acak' },
  { token: 'fn.random_int 1 100', ns: 'fn', hint: 'angka acak' },
]

function useMediaQuery(q: string) {
  return React.useSyncExternalStore(
    (cb) => {
      const m = matchMedia(q)
      m.addEventListener('change', cb)
      return () => m.removeEventListener('change', cb)
    },
    () => matchMedia(q).matches,
  )
}

export function TestCaseEditor({
  projectKey,
  server,
  initial,
  runStatus,
  reload,
}: {
  projectKey: string
  /** null = mode buat baru */
  server: TestCase | null
  initial: Draft
  runStatus: Map<string, StepStatus>
  reload?: () => Promise<TestCase | undefined>
}) {
  const isCreate = !server
  const caseKey = server?.key ?? null
  const search = useSearch({ from: FROM })
  const navigate = useNavigate()
  const qc = useQueryClient()
  const canEdit = useCan('edit_tests', projectKey)
  const canRun = useCan('run', projectKey)
  const readOnly = !canEdit
  const isXl = useMediaQuery('(min-width: 1280px)')

  const rawTab = (search.tab ?? 'steps') as Tab
  const tab: Tab = isCreate && (rawTab === 'revisions' || rawTab === 'runs') ? 'steps' : rawTab
  const setTab = (t: Tab) =>
    navigate({ to: '/p/$key/tests/$caseKey', params: { key: projectKey, caseKey: caseKey ?? 'new' }, search: (p) => ({ ...p, tab: t === 'steps' ? undefined : t }), replace: true })

  /* ---------------------------------------------------------------- draft state */
  const [baseline, setBaseline] = React.useState(initial)
  const [baseRevision, setBaseRevision] = React.useState(server?.revision ?? 0)
  const [draft, setDraft] = React.useState(initial)
  const update = React.useCallback((fn: (d: Draft) => Draft) => setDraft(fn), [])
  const dirty = React.useMemo(() => !sameDraft(draft, baseline), [draft, baseline])
  const setSteps = (fn: (s: Step[]) => Step[]) => setDraft((d) => ({ ...d, steps: fn(d.steps) }))

  const [mode, setMode] = React.useState<'form' | 'json'>('form')
  const [jsonText, setJsonText] = React.useState('')
  const [blocking, setBlocking] = React.useState<JsonIssue[]>([])

  const resetTo = (d: Draft, revision: number) => {
    setBaseline(d)
    setDraft(d)
    setBaseRevision(revision)
    if (mode === 'json') {
      setJsonText(JSON.stringify(draftToJsonDoc(d), null, 2))
      setBlocking([])
    }
  }

  // Data server berubah (refetch saat fokus, user lain menyimpan) dan tidak ada edit lokal → ikuti server.
  const dirtyRef = React.useRef(dirty)
  const baseRevRef = React.useRef(baseRevision)
  React.useEffect(() => {
    dirtyRef.current = dirty
    baseRevRef.current = baseRevision
  })
  React.useEffect(() => {
    if (!server || server.revision === baseRevRef.current || dirtyRef.current) return
    const d = draftFromCase(server)
    setBaseline(d)
    setDraft(d)
    setBaseRevision(server.revision)
  }, [server])

  /* ---------------------------------------------------------------- validation */
  const validation = React.useMemo(() => validateSteps(draft.steps, draft.execution), [draft.steps, draft.execution])
  const stepErrors = React.useMemo(() => errorsByStep(validation.errors), [validation.errors])
  const stepWarnings = React.useMemo(() => errorsByStep(validation.warnings), [validation.warnings])
  const titleMissing = !draft.title.trim()
  const errorCount = validation.errors.length + (titleMissing ? 1 : 0)
  const [titleTouched, setTitleTouched] = React.useState(false)

  /* ---------------------------------------------------------------- variable suggestions */
  const envs = useEnvironments(projectKey)
  const suggestions = React.useMemo<VarSuggestion[]>(() => {
    const env = new Map<string, string[]>()
    const sec = new Map<string, string[]>()
    for (const e of envs.data?.data ?? []) {
      for (const k of Object.keys(e.variables)) env.set(k, [...(env.get(k) ?? []), e.name])
      for (const s of e.secrets) sec.set(s.name, [...(sec.get(s.name) ?? []), e.name])
    }
    const vars = new Map<string, string>()
    for (const k of Object.keys(draft.variables)) vars.set(k, 'variable test case')
    for (const s of draft.steps) {
      if (s.save_as) vars.set(s.save_as, 'dari extract_text')
      if (s.action === 'set_variable' && s.name) vars.set(s.name, 'dari set_variable')
      for (const k of Object.keys(s.save ?? {})) vars.set(k, 'dari HTTP save')
    }
    return [
      ...[...env].map(([k, names]) => ({ token: `env.${k}`, ns: 'env' as const, hint: names.join(', ') })),
      ...[...vars].map(([k, hint]) => ({ token: `vars.${k}`, ns: 'vars' as const, hint })),
      ...[...sec].map(([k]) => ({ token: `secret.${k}`, ns: 'secret' as const, hint: 'nilai tersembunyi' })),
      ...FN_SUGGESTIONS,
    ]
  }, [envs.data, draft.variables, draft.steps])

  /* ---------------------------------------------------------------- step selection & panel */
  const [selectedId, setSelectedId] = React.useState<string | null>(initial.steps[0]?.id ?? null)
  const selectedIndex = selectedId ? draft.steps.findIndex((s) => s.id === selectedId) : -1
  const selectedStep = selectedIndex >= 0 ? draft.steps[selectedIndex] : null
  const [sheetOpen, setSheetOpen] = React.useState(false)
  const [paletteOpen, setPaletteOpen] = React.useState(false)
  const [shortcutsOpen, setShortcutsOpen] = React.useState(false)
  const rowRefs = React.useRef(new Map<string, HTMLElement>())
  const panelRef = React.useRef<HTMLElement>(null)
  const [focusPanelReq, setFocusPanelReq] = React.useState(0)

  const focusRow = (id: string | null | undefined) => {
    if (!id) return
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus())
  }
  const focusFirstField = () => {
    const el = panelRef.current?.querySelector<HTMLElement>('input:not([type=hidden]), textarea, button[role="combobox"], button[role="checkbox"]')
    el?.focus()
  }
  React.useEffect(() => {
    if (!focusPanelReq || !isXl) return
    const t = requestAnimationFrame(focusFirstField)
    return () => cancelAnimationFrame(t)
  }, [focusPanelReq, isXl])

  const openStep = (id: string, focusField = true) => {
    setSelectedId(id)
    if (!isXl) setSheetOpen(true)
    else if (focusField) setFocusPanelReq((n) => n + 1)
  }

  const announceRef = React.useRef<HTMLDivElement>(null)
  const announce = (msg: string) => {
    if (announceRef.current) announceRef.current.textContent = msg
  }

  const addStep = (action: StepAction) => {
    const id = newStepId(draft.steps)
    const step = newStep(action, id)
    const at = selectedIndex >= 0 ? selectedIndex + 1 : draft.steps.length
    setSteps((steps) => [...steps.slice(0, at), step, ...steps.slice(at)])
    announce(`Step ${at + 1} (${action === 'manual' ? 'langkah manual' : action}) ditambahkan`)
    openStep(id)
  }

  const handlers: StepListHandlers = {
    onSelect: (id) => setSelectedId(id),
    onRowClick: (id) => openStep(id, false),
    onOpen: (id) => openStep(id),
    onReorder: (from, to) =>
      setSteps((steps) => {
        const next = [...steps]
        const [m] = next.splice(from, 1)
        next.splice(to, 0, m)
        return next
      }),
    onDuplicate: (id) => {
      const idx = draft.steps.findIndex((s) => s.id === id)
      if (idx < 0) return
      const copy = { ...structuredClone(draft.steps[idx]), id: newStepId(draft.steps) }
      setSteps((steps) => [...steps.slice(0, idx + 1), copy, ...steps.slice(idx + 1)])
      setSelectedId(copy.id)
      announce(`Step ${idx + 1} diduplikat sebagai step ${idx + 2}`)
      focusRow(copy.id)
    },
    onToggle: (id) =>
      setSteps((steps) =>
        steps.map((s) => {
          if (s.id !== id) return s
          const next = { ...s }
          if (s.enabled === false) delete next.enabled
          else next.enabled = false
          return next
        }),
      ),
    onDelete: (id) => {
      const idx = draft.steps.findIndex((s) => s.id === id)
      if (idx < 0) return
      const removed = draft.steps[idx]
      const neighbour = draft.steps[idx + 1] ?? draft.steps[idx - 1]
      setSteps((steps) => steps.filter((s) => s.id !== id))
      if (selectedId === id) setSelectedId(neighbour?.id ?? null)
      if (sheetOpen) setSheetOpen(false)
      focusRow(neighbour?.id)
      toast(`Step ${idx + 1} dihapus`, {
        duration: 5000,
        action: {
          label: 'Urungkan',
          onClick: () => {
            setSteps((steps) => (steps.some((s) => s.id === removed.id) ? steps : [...steps.slice(0, idx), removed, ...steps.slice(idx)]))
            setSelectedId(removed.id)
            focusRow(removed.id)
          },
        },
      })
    },
    onAdd: addStep,
  }

  const moveSelected = (dir: -1 | 1) => {
    if (selectedIndex < 0) return
    const to = selectedIndex + dir
    if (to < 0 || to >= draft.steps.length) return
    handlers.onReorder(selectedIndex, to)
    announce(`Step ${selectedIndex + 1} dipindah ke posisi ${to + 1}`)
  }

  /* ---------------------------------------------------------------- JSON mode */
  const switchMode = (m: 'form' | 'json') => {
    if (m === mode) return
    if (m === 'json') {
      setJsonText(JSON.stringify(draftToJsonDoc(draft), null, 2))
      setBlocking([])
      setMode('json')
    } else {
      if (blocking.length) {
        toast.error('JSON belum valid', { description: 'Perbaiki error sintaks/struktur di daftar bawah editor dulu, baru kembali ke Form.' })
        return
      }
      setMode('form')
    }
  }
  const onJsonChange = (t: string) => {
    setJsonText(t)
    const r = parseJsonDoc(t, draft)
    setBlocking(r.blocking)
    if (r.draft) setDraft(r.draft)
  }
  const semanticIssues = React.useMemo(() => {
    if (mode !== 'json' || blocking.length) return { errors: [] as JsonIssue[], warnings: [] as JsonIssue[] }
    const errs = [...(titleMissing ? [{ path: 'title', message: 'Judul wajib diisi' }] : []), ...validation.errors]
    return { errors: locateIssues(jsonText, errs), warnings: locateIssues(jsonText, validation.warnings.filter((w) => w.path !== 'steps')) }
  }, [mode, blocking.length, jsonText, validation, titleMissing])

  /* ---------------------------------------------------------------- save */
  const createMut = useCreateTestCase(projectKey)
  const updateMut = useUpdateTestCase(caseKey ?? '__none')
  const saving = createMut.isPending || updateMut.isPending
  const [conflict, setConflict] = React.useState<string | null>(null)
  const [serverErrors, setServerErrors] = React.useState<{ path: string; message: string }[]>([])
  const [note, setNote] = React.useState('')
  const [noteOpen, setNoteOpen] = React.useState(false)
  const skipBlock = React.useRef(false)
  const titleRef = React.useRef<HTMLInputElement>(null)

  let saveBlock: string | null = null
  if (blocking.length) saveBlock = 'JSON belum valid; perbaiki dulu.'
  else if (errorCount) saveBlock = `Perbaiki ${errorCount} error dulu.`
  else if (!isCreate && !dirty) saveBlock = 'Belum ada perubahan untuk disimpan.'

  let runBlock: string | null = null
  if (isCreate) runBlock = 'Simpan test case dulu sebelum menjalankannya.'
  else if (dirty) runBlock = 'Simpan perubahan dulu; run memakai versi yang tersimpan.'
  else if (errorCount) runBlock = `Perbaiki ${errorCount} error dulu.`
  else if (!draft.steps.length) runBlock = 'Tambah minimal satu step dulu.'

  const goToFirstError = () => {
    if (titleMissing) {
      setTitleTouched(true)
      titleRef.current?.focus()
      return
    }
    const first = [...stepErrors.keys()].sort((a, b) => a - b)[0]
    if (first === undefined) return
    if (mode === 'json') return
    if (tab !== 'steps') setTab('steps')
    openStep(draft.steps[first].id)
  }

  const onSaveError = (err: unknown) => {
    if (err instanceof ApiError && err.status === 409) {
      setConflict(err.message)
      return
    }
    if (err instanceof ApiError && err.status === 422) {
      setServerErrors(err.details)
      toast.error(err.message, { description: err.details[0]?.message })
      return
    }
    toast.error('Gagal menyimpan', { description: errorMessage(err) })
  }

  const save = (changeNote?: string) => {
    if (readOnly || saving) return
    if (saveBlock) {
      if (errorCount) {
        toast.error(saveBlock)
        goToFirstError()
      } else if (blocking.length) toast.error(saveBlock)
      return
    }
    const submitted = draft
    const input = draftToInput(draft)
    if (isCreate) {
      createMut.mutate(input, {
        onSuccess: (tc) => {
          skipBlock.current = true
          toast.success(`${tc.key} dibuat · revisi 1 tersimpan`)
          navigate({ to: '/p/$key/tests/$caseKey', params: { key: projectKey, caseKey: tc.key }, search: {}, replace: true })
        },
        onError: onSaveError,
      })
      return
    }
    updateMut.mutate(
      { ...input, revision: baseRevision, change_note: changeNote?.trim() || undefined },
      {
        onSuccess: (tc) => {
          const d = draftFromCase(tc)
          setBaseline(d)
          setBaseRevision(tc.revision)
          setDraft((cur) => (sameDraft(cur, submitted) ? d : cur))
          setConflict(null)
          setServerErrors([])
          setNote('')
          setNoteOpen(false)
          toast.success(`Revisi ${tc.revision} tersimpan`)
        },
        onError: onSaveError,
      },
    )
  }

  const reloadFromServer = async () => {
    if (!reload) return
    const fresh = await reload()
    if (!fresh) return
    resetTo(draftFromCase(fresh), fresh.revision)
    setConflict(null)
    toast(`Dimuat ulang ke revisi ${fresh.revision}`)
  }

  /* ---------------------------------------------------------------- keyboard: ⌘S, N, ? */
  const latest = React.useRef({ save, addStep, tab, mode, readOnly, execution: draft.execution })
  React.useEffect(() => {
    latest.current = { save, addStep, tab, mode, readOnly, execution: draft.execution }
  })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const L = latest.current
      const mod = e.metaKey || e.ctrlKey
      if (mod && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (!L.readOnly) L.save()
        return
      }
      if (mod || e.altKey || e.defaultPrevented || isTypingTarget(e.target)) return
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"],[data-radix-popper-content-wrapper]')) return
      if (L.tab !== 'steps' || L.mode !== 'form') return
      if (e.key === '?') {
        e.preventDefault()
        setShortcutsOpen(true)
        return
      }
      if (L.readOnly) return
      if (e.key === 'n' || e.key === 'N') {
        e.preventDefault()
        if (L.execution === 'manual') L.addStep('manual')
        else setPaletteOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /* ---------------------------------------------------------------- leave guard */
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => dirtyRef.current && !skipBlock.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirtyRef.current && !skipBlock.current,
    withResolver: true,
  })

  /* ---------------------------------------------------------------- layout */
  const headRef = React.useRef<HTMLDivElement>(null)
  const [headH, setHeadH] = React.useState(120)
  React.useLayoutEffect(() => {
    const el = headRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setHeadH(el.offsetHeight))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const panelTop = 48 + headH + 16

  const [runOpen, setRunOpen] = React.useState(false)
  const manual = draft.execution === 'manual'
  const stepWarnCount = validation.warnings.filter((w) => w.path !== 'steps').length
  const varCount = Object.keys(draft.variables).length

  const panel = selectedStep ? (
    <StepPanel
      ref={panelRef}
      key={selectedStep.id}
      step={selectedStep}
      index={selectedIndex}
      total={draft.steps.length}
      readOnly={readOnly}
      errors={stepErrors.get(selectedIndex) ?? []}
      warnings={stepWarnings.get(selectedIndex) ?? []}
      runStatus={runStatus.get(selectedStep.id)}
      onChange={(next) => setSteps((steps) => steps.map((s) => (s.id === next.id ? next : s)))}
      onDuplicate={() => handlers.onDuplicate(selectedStep.id)}
      onToggle={() => handlers.onToggle(selectedStep.id)}
      onMove={moveSelected}
      onDelete={() => handlers.onDelete(selectedStep.id)}
      onEscape={() => {
        if (!isXl) setSheetOpen(false)
        focusRow(selectedStep.id)
      }}
      bare={!isXl}
      className={isXl ? 'min-h-0 flex-1' : 'h-full'}
    />
  ) : null

  return (
    <VarSuggestionsContext.Provider value={suggestions}>
      <PageContainer className="gap-4">
        <h1 className="sr-only">{isCreate ? 'Test case baru' : `${caseKey} ${draft.title}`}</h1>
        <Tabs value={mode === 'json' ? '__json' : tab} onValueChange={(v) => setTab(v as Tab)} className="flex flex-col gap-4">
          <div
            ref={headRef}
            className={cn('sticky top-12 z-20 -mx-4 -mt-4 flex flex-col gap-3 bg-background px-4 pt-4 md:-mx-6 md:-mt-5 md:px-6 md:pt-5', mode === 'json' && 'border-b border-border pb-3')}
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex min-w-0 flex-1 basis-80 items-center gap-2">
                <KeyBadge className="shrink-0">{caseKey ?? 'Baru'}</KeyBadge>
                {manual && <ManualBadge execution="manual" className="shrink-0" />}
                {readOnly ? (
                  <p className="min-w-0 truncate text-xl font-semibold tracking-tight" title={draft.title}>
                    {draft.title}
                  </p>
                ) : (
                  <input
                    ref={titleRef}
                    autoFocus={isCreate}
                    aria-label="Judul test case"
                    aria-invalid={titleTouched && titleMissing ? true : undefined}
                    aria-describedby={titleTouched && titleMissing ? 'tc-title-err' : undefined}
                    value={draft.title}
                    placeholder={manual ? 'Judul test case manual, mis. Login dengan OTP SMS' : 'Judul test case, mis. User bisa login dengan email'}
                    onChange={(e) => update((d) => ({ ...d, title: e.target.value }))}
                    onBlur={() => setTitleTouched(true)}
                    className="h-9 min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1.5 text-xl font-semibold tracking-tight transition-colors duration-150 outline-none placeholder:font-normal placeholder:text-muted-foreground hover:border-border focus-visible:border-input focus-visible:ring-2 focus-visible:ring-ring aria-invalid:border-destructive"
                  />
                )}
                {dirty && !readOnly && (
                  <span className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground" role="status">
                    <span className="size-1.5 rounded-full bg-status-blocked" aria-hidden />
                    belum disimpan
                  </span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Segmented
                  ariaLabel="Mode editor"
                  value={mode}
                  onChange={switchMode}
                  options={[
                    { value: 'form', label: 'Form' },
                    { value: 'json', label: 'JSON' },
                  ]}
                />
                {canRun && !isCreate && (
                  <>
                    <Tip label={runBlock ?? 'Jalankan versi tersimpan'}>
                      <Button
                        variant="outline"
                        aria-disabled={runBlock ? true : undefined}
                        aria-describedby={runBlock ? 'tc-run-reason' : undefined}
                        onClick={() => {
                          if (runBlock) {
                            if (errorCount) goToFirstError()
                            return
                          }
                          setRunOpen(true)
                        }}
                      >
                        <Play /> Run
                      </Button>
                    </Tip>
                    {runBlock && (
                      <span id="tc-run-reason" className="sr-only">
                        {runBlock}
                      </span>
                    )}
                  </>
                )}
                {!readOnly && (
                  <div className="inline-flex">
                    <Tip label={saveBlock ?? `Simpan (${MOD_LABEL}+S)`}>
                      <Button
                        className={cn(!isCreate && 'rounded-r-none')}
                        aria-disabled={saveBlock ? true : undefined}
                        aria-describedby={saveBlock ? 'tc-save-reason' : undefined}
                        aria-keyshortcuts={`${MOD_LABEL === '⌘' ? 'Meta' : 'Control'}+S`}
                        loading={saving}
                        onClick={() => save(note)}
                      >
                        Simpan
                        <span className="hidden font-mono text-[11px] opacity-60 sm:inline">{MOD_LABEL === '⌘' ? '⌘S' : 'Ctrl S'}</span>
                      </Button>
                    </Tip>
                    {saveBlock && (
                      <span id="tc-save-reason" className="sr-only">
                        {saveBlock}
                      </span>
                    )}
                    {!isCreate && (
                      <Popover open={noteOpen} onOpenChange={setNoteOpen}>
                        <PopoverTrigger asChild>
                          <Button className="rounded-l-none border-l border-primary-foreground/25 px-2" aria-label="Simpan dengan catatan perubahan" disabled={saving || !dirty}>
                            <ChevronDown />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-80">
                          <form
                            className="flex flex-col gap-2"
                            onSubmit={(e) => {
                              e.preventDefault()
                              save(note)
                            }}
                          >
                            <Label htmlFor="tc-change-note">Catatan perubahan</Label>
                            <Input id="tc-change-note" autoFocus value={note} onChange={(e) => setNote(e.target.value)} placeholder="Mis. Perbaiki expected total setelah diskon" />
                            <p className="text-xs text-muted-foreground">Tampil di tab Revisi. Opsional.</p>
                            <Button type="submit" className="self-end" loading={saving} aria-disabled={saveBlock ? true : undefined}>
                              Simpan revisi {baseRevision + 1}
                            </Button>
                          </form>
                        </PopoverContent>
                      </Popover>
                    )}
                  </div>
                )}
              </div>
            </div>
            {titleTouched && titleMissing && !readOnly && (
              <p id="tc-title-err" className="-mt-1 flex items-center gap-1 text-xs text-destructive">
                <CircleAlert className="size-3.5" aria-hidden /> Judul wajib diisi
              </p>
            )}
            {mode === 'form' && (
              <TabsList aria-label="Bagian test case">
                <TabsTrigger value="steps">
                  {manual ? 'Langkah' : 'Steps'} <span className="text-xs tabular text-muted-foreground">{draft.steps.length}</span>
                  {validation.errors.length > 0 && (
                    <span className="inline-flex h-4 items-center gap-0.5 rounded-sm bg-status-failed-bg px-1 text-xs text-status-failed">
                      <CircleAlert className="size-3" aria-hidden />
                      <span className="tabular">{validation.errors.length}</span>
                      <span className="sr-only"> error</span>
                    </span>
                  )}
                </TabsTrigger>
                <TabsTrigger value="variables">
                  Variables {varCount > 0 && <span className="text-xs tabular text-muted-foreground">{varCount}</span>}
                </TabsTrigger>
                <TabsTrigger value="info">Info</TabsTrigger>
                {!isCreate && <TabsTrigger value="revisions">Revisi</TabsTrigger>}
                {!isCreate && <TabsTrigger value="runs">Riwayat run</TabsTrigger>}
              </TabsList>
            )}
          </div>

          <div ref={announceRef} aria-live="polite" className="sr-only" />

          {conflict && (
            <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-status-blocked/40 bg-status-blocked-bg px-4 py-2.5 text-sm">
              <TriangleAlert className="size-4 shrink-0 text-status-blocked" aria-hidden />
              <p className="min-w-0 flex-1">
                {conflict} <span className="text-muted-foreground">Muat ulang akan membuang perubahanmu yang belum disimpan.</span>
              </p>
              <Button variant="outline" size="sm" onClick={reloadFromServer}>
                Muat ulang
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  if (caseKey) qc.invalidateQueries({ queryKey: qk.revisions(caseKey) })
                  if (mode === 'json') switchMode('form')
                  setTab('revisions')
                }}
              >
                Lihat perbedaan
              </Button>
            </div>
          )}
          {serverErrors.length > 0 && !conflict && (
            <div role="alert" className="flex flex-col gap-1 rounded-md border border-destructive/40 bg-status-failed-bg px-4 py-2.5 text-sm">
              <p className="font-medium text-status-failed">Server menolak simpan:</p>
              <ul className="list-inside list-disc text-foreground">
                {serverErrors.map((e) => (
                  <li key={e.path + e.message}>
                    <span className="font-mono text-xs">{e.path}</span> {e.message}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {mode === 'json' ? (
            <JsonView
              text={jsonText}
              onTextChange={onJsonChange}
              blocking={blocking}
              semantic={semanticIssues.errors}
              warnings={semanticIssues.warnings}
              readOnly={readOnly}
            />
          ) : (
            <>
              <TabsContent value="steps">
                <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex min-h-7 items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">
                        <span className="tabular">{draft.steps.length}</span> {manual ? 'langkah' : 'step'}
                        {validation.errors.length > 0 && (
                          <span className="text-destructive">
                            {' '}
                            · <span className="tabular">{validation.errors.length}</span> error
                          </span>
                        )}
                        {stepWarnCount > 0 && (
                          <span className="text-status-blocked">
                            {' '}
                            · <span className="tabular">{stepWarnCount}</span> warning
                          </span>
                        )}
                        {runStatus.size > 0 && <span> · status = run terakhir</span>}
                      </p>
                      <ShortcutsPopover open={shortcutsOpen} onOpenChange={setShortcutsOpen} readOnly={readOnly} manual={manual} />
                    </div>
                    {draft.steps.length === 0 && (
                      <EmptyState
                        icon={ListPlus}
                        title={readOnly ? 'Test case ini belum punya step' : manual ? 'Belum ada langkah' : 'Belum ada step'}
                        description={
                          readOnly
                            ? undefined
                            : manual
                              ? 'Tulis instruksi untuk tester dan hasil yang diharapkan, satu langkah per baris.'
                              : 'Tambah step pertama dari palette action: buka URL, isi input, klik, lalu assertion.'
                        }
                      />
                    )}
                    <StepList
                      steps={draft.steps}
                      execution={draft.execution}
                      selectedId={selectedId}
                      readOnly={readOnly}
                      errors={stepErrors}
                      warnings={stepWarnings}
                      runStatus={runStatus}
                      paletteOpen={paletteOpen}
                      setPaletteOpen={setPaletteOpen}
                      handlers={handlers}
                      rowRefs={rowRefs}
                    />
                  </div>
                  {isXl && (
                    <div className="sticky flex flex-col" style={{ top: panelTop, maxHeight: `calc(100dvh - ${panelTop + 16}px)` }}>
                      {panel ?? <EmptyPanel hasSteps={draft.steps.length > 0} readOnly={readOnly} />}
                    </div>
                  )}
                </div>
                {!isXl && (
                  <Dialog open={sheetOpen && !!selectedStep} onOpenChange={setSheetOpen}>
                    <SheetContent
                      className="w-[min(100vw,400px)] p-0"
                      onOpenAutoFocus={(e) => {
                        e.preventDefault()
                        requestAnimationFrame(focusFirstField)
                      }}
                      onCloseAutoFocus={(e) => {
                        // Radix mengembalikan fokus ke DialogTrigger; Sheet ini tidak punya trigger → kembalikan ke baris step.
                        e.preventDefault()
                        focusRow(selectedId)
                      }}
                      onEscapeKeyDown={(e) => {
                        // Esc pertama menutup daftar autocomplete variable, bukan panel.
                        if ((e.target as HTMLElement | null)?.getAttribute?.('aria-controls')) e.preventDefault()
                      }}
                    >
                      <DialogTitle className="sr-only">{selectedStep ? `Step ${selectedIndex + 1}` : 'Step'}</DialogTitle>
                      <DialogDescription className="sr-only">Detail step. Esc kembali ke daftar.</DialogDescription>
                      {panel}
                    </SheetContent>
                  </Dialog>
                )}
              </TabsContent>
              <TabsContent value="variables">
                <VariablesTab draft={draft} update={update} readOnly={readOnly} />
              </TabsContent>
              <TabsContent value="info">
                <InfoTab
                  projectKey={projectKey}
                  draft={draft}
                  update={update}
                  readOnly={readOnly}
                  meta={
                    server
                      ? { created_at: server.created_at, created_by: server.created_by.name, updated_at: server.updated_at, updated_by: server.updated_by.name }
                      : undefined
                  }
                />
              </TabsContent>
              {caseKey && (
                <>
                  <TabsContent value="revisions">
                    <RevisionsTab
                      caseKey={caseKey}
                      draft={draft}
                      currentRevision={baseRevision}
                      dirty={dirty}
                      readOnly={readOnly}
                      onRestore={(snap: TestCaseInput, rev: number) => {
                        update((d) => draftFromInput(snap, d))
                        toast(`Revisi ${rev} dipulihkan ke draft`, { description: 'Simpan untuk menjadikannya revisi baru.' })
                        setTab('steps')
                      }}
                    />
                  </TabsContent>
                  <TabsContent value="runs">
                    <RunsTab projectKey={projectKey} caseKey={caseKey} />
                  </TabsContent>
                </>
              )}
            </>
          )}
        </Tabs>

        {caseKey && canRun && (
          <RunDialog projectKey={projectKey} target={{ kind: 'test_case', key: caseKey, title: draft.title, manualOnly: manual }} open={runOpen} onOpenChange={setRunOpen} />
        )}

        <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(o) => !o && blocker.reset?.()}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Buang perubahan?</AlertDialogTitle>
              <AlertDialogDescription>
                {isCreate ? 'Test case baru ini belum disimpan dan akan hilang.' : `Perubahan di ${caseKey} belum disimpan dan akan hilang.`}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel autoFocus onClick={() => blocker.reset?.()}>
                Tetap di sini
              </AlertDialogCancel>
              <AlertDialogAction destructive onClick={() => blocker.proceed?.()}>
                Buang perubahan
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </PageContainer>
    </VarSuggestionsContext.Provider>
  )
}

function ShortcutsPopover({ open, onOpenChange, readOnly, manual }: { open: boolean; onOpenChange: (o: boolean) => void; readOnly: boolean; manual: boolean }) {
  const rows: [string, string][] = [
    ['↑ ↓', 'Pilih step'],
    ['Enter', 'Buka detail step'],
    ['Esc', 'Kembali ke daftar'],
    ...(readOnly
      ? []
      : ([
          ['Alt ↑ ↓', 'Pindah step'],
          ['Spasi', 'Mulai drag (lalu ↑ ↓, Spasi lepas)'],
          ['N', manual ? 'Tambah langkah' : 'Tambah step (palette)'],
          ['D', 'Duplikat'],
          ['E', 'Aktif / nonaktif'],
          ['Del', 'Hapus (bisa diurungkan)'],
          [`${MOD_LABEL} S`, 'Simpan'],
        ] as [string, string][])),
    ['?', 'Daftar pintasan ini'],
  ]
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground" aria-keyshortcuts="Shift+?">
          <Keyboard /> Pintasan
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <h3 className="mb-2 text-sm font-semibold">Pintasan keyboard</h3>
        <p className="mb-2 text-xs text-muted-foreground">Aktif saat fokus di daftar step, tidak di dalam field teks.</p>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5 text-sm">
          {rows.map(([k, label]) => (
            <React.Fragment key={k}>
              <dt className="flex gap-1">
                {k.split(' ').map((p) => (
                  <Kbd key={p}>{p}</Kbd>
                ))}
              </dt>
              <dd>{label}</dd>
            </React.Fragment>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  )
}
