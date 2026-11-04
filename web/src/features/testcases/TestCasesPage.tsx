import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router'
import { Bot, ChevronDown, FilterX, Hand, ListChecks, Plus } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useBulkTestCases, useFolders, useTags, useTestCases } from '@/api/queries'
import type { TestCaseSummary } from '@/api/types'
import { useCan } from '@/app/auth'
import type { TestCasesSearch } from '@/app/router'
import { ManualBadge, PriorityLabel, TagChip, TestCaseStatusLabel } from '@/components/misc'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogDescription, DialogTitle, SheetContent } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import { BulkBar } from './BulkBar'
import { CASE_DRAG_TYPE, FolderTree, type FolderValue } from './FolderTree'
import { ActiveFilters, ListToolbar } from './ListToolbar'
import { buildFolderTree, folderPath, shortRelative } from './lib'
import { useDelayed } from './useDelayed'

const FROM = '/_app/p/$key/tests' as const

export function TestCasesPage() {
  const { key } = useParams({ from: FROM })
  const search = useSearch({ from: FROM })
  const navigate = useNavigate({ from: '/p/$key/tests' })
  const canEdit = useCan('edit_tests', key)
  const { t } = useTranslation('testcases')

  const folders = useFolders(key)
  const tags = useTags(key)
  const allCases = useTestCases(key)
  const list = useTestCases(key, search)
  const bulk = useBulkTestCases(key)

  const setSearch = React.useCallback(
    (patch: Partial<TestCasesSearch>) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true }),
    [navigate],
  )
  const hasFilters = !!(search.q || search.tags || search.status || search.priority || search.execution || search.last_run_status)
  const resetFilters = () => navigate({ search: (prev) => ({ folder: prev.folder }), replace: true })

  const { byId } = React.useMemo(() => buildFolderTree(folders.data?.data ?? []), [folders.data])
  const folderLabel =
    search.folder === undefined ? t('list.allFolders') : search.folder === 'root' ? t('list.noFolder') : folderPath(byId, search.folder) || t('list.folderFallback')
  const rootCount = allCases.data?.data.filter((t) => !t.folder_id).length ?? 0
  const totalCount = allCases.data?.data.length

  const [folderSheet, setFolderSheet] = React.useState(false)
  const folderButtonRef = React.useRef<HTMLButtonElement>(null)
  const selectFolder = (v: FolderValue) => {
    setSearch({ folder: v })
    setFolderSheet(false)
  }

  const rows = React.useMemo(() => list.data?.data ?? [], [list.data])

  /* ---------- selection */
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const anchor = React.useRef<number | null>(null)
  const visibleSelected = rows.filter((r) => selectedIds.has(r.id))
  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set())
    anchor.current = null
  }, [])

  React.useEffect(() => {
    if (!visibleSelected.length) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const t = e.target as HTMLElement | null
      if (t?.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],input,textarea')) return
      if (document.querySelector('[role="dialog"],[role="alertdialog"],[role="menu"]')) return
      clearSelection()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [visibleSelected.length, clearSelection])

  const toggleRow = (index: number, shift: boolean) => {
    const id = rows[index].id
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (shift && anchor.current !== null && rows[anchor.current]) {
        const [a, b] = anchor.current < index ? [anchor.current, index] : [index, anchor.current]
        const value = !prev.has(id)
        for (let i = a; i <= b; i++) {
          if (value) next.add(rows[i].id)
          else next.delete(rows[i].id)
        }
      } else if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
    anchor.current = index
  }
  const allChecked = rows.length > 0 && visibleSelected.length === rows.length
  const someChecked = visibleSelected.length > 0 && !allChecked

  const onDropCases = (folderId: string | null, ids: string[]) =>
    bulk.mutate(
      { ids, action: 'move', folder_id: folderId },
      {
        onSuccess: (res) => toast.success(t('bulk.moved', { count: res.updated, folder: folderId ? folderPath(byId, folderId) : t('list.noFolder') })),
        onError: (err) => toast.error(errorMessage(err)),
      },
    )

  const newFolder = search.folder && search.folder !== 'root' ? search.folder : undefined

  const tree = (
    <FolderTree
      projectKey={key}
      folders={folders.data?.data}
      loading={folders.isPending}
      selected={search.folder}
      onSelect={selectFolder}
      canEdit={canEdit}
      totalCount={totalCount}
      rootCount={rootCount}
      onDropCases={onDropCases}
    />
  )

  const showSkeleton = useDelayed(list.isPending, 150)
  const resultCount = rows.length

  return (
    <PageContainer>
      <PageHeader
        title={t('list.title')}
        description={
          list.data ? (
            <span>
              <Trans
                t={t}
                i18nKey={hasFilters ? 'list.summaryFiltered' : 'list.summary'}
                values={{ folder: folderLabel, count: resultCount }}
                components={{ num: <span className="tabular" /> }}
              />
            </span>
          ) : (
            ' '
          )
        }
        actions={canEdit ? <NewTestCaseButton projectKey={key} folder={newFolder} /> : undefined}
      />
      <div className="flex items-start gap-5">
        <aside className="sticky top-16 hidden max-h-[calc(100dvh-5rem)] w-60 shrink-0 overflow-y-auto border-r border-border pr-3 xl:block" aria-label={t('list.foldersLabel')}>
          {folders.isError ? <ErrorState error={folders.error} onRetry={() => folders.refetch()} /> : tree}
        </aside>
        <Dialog open={folderSheet} onOpenChange={setFolderSheet}>
          <SheetContent
            side="left"
            className="w-72 overflow-y-auto p-4 pt-12"
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              folderButtonRef.current?.focus()
            }}
          >
            <DialogTitle className="sr-only">{t('list.foldersLabel')}</DialogTitle>
            <DialogDescription className="sr-only">{t('list.foldersDescription')}</DialogDescription>
            {tree}
          </SheetContent>
        </Dialog>

        <section className={cn('flex min-w-0 flex-1 flex-col gap-3', visibleSelected.length > 0 && 'pb-2')} aria-label={t('list.listLabel')}>
          <ListToolbar
            search={search}
            setSearch={setSearch}
            tags={tags.data?.data ?? []}
            onOpenFolders={() => setFolderSheet(true)}
            folderButtonRef={folderButtonRef}
            folderLabel={folderLabel}
          />
          <ActiveFilters search={search} setSearch={setSearch} onReset={resetFilters} />

          {list.isError ? (
            <ErrorState error={list.error} onRetry={() => list.refetch()} />
          ) : list.isPending ? (
            showSkeleton ? <TableSkeleton /> : <div className="h-72" aria-busy />
          ) : rows.length === 0 ? (
            hasFilters ? (
              <EmptyState
                icon={FilterX}
                title={t('list.emptyFilteredTitle')}
                description={t('list.emptyFilteredDescription')}
                action={
                  <Button variant="outline" onClick={resetFilters}>
                    {t('filters.reset')}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ListChecks}
                title={search.folder === undefined ? t('list.emptyProjectTitle') : t('list.emptyFolderTitle')}
                description={canEdit ? t('list.emptyDescription') : undefined}
                action={
                  canEdit ? (
                    <Button asChild>
                      <Link to="/p/$key/tests/$caseKey" params={{ key, caseKey: 'new' }} search={{ execution: 'automated', folder: newFolder }}>
                        <Plus /> {t('list.create')}
                      </Link>
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <CaseTable
              projectKey={key}
              rows={rows}
              selectedIds={selectedIds}
              canEdit={canEdit}
              allChecked={allChecked}
              someChecked={someChecked}
              onToggleAll={() => (allChecked ? clearSelection() : setSelectedIds(new Set(rows.map((r) => r.id))))}
              onToggleRow={toggleRow}
              fetching={list.isFetching && !list.isPending}
            />
          )}

          {canEdit && visibleSelected.length > 0 && (
            <BulkBar projectKey={key} selected={visibleSelected} folders={folders.data?.data ?? []} tags={tags.data?.data ?? []} onClear={clearSelection} />
          )}
        </section>
      </div>
    </PageContainer>
  )
}

function CaseTable({
  projectKey,
  rows,
  selectedIds,
  canEdit,
  allChecked,
  someChecked,
  onToggleAll,
  onToggleRow,
  fetching,
}: {
  projectKey: string
  rows: TestCaseSummary[]
  selectedIds: Set<string>
  canEdit: boolean
  allChecked: boolean
  someChecked: boolean
  onToggleAll: () => void
  onToggleRow: (index: number, shift: boolean) => void
  fetching: boolean
}) {
  const { t } = useTranslation('testcases')
  const navigate = useNavigate()
  const open = (caseKey: string) => navigate({ to: '/p/$key/tests/$caseKey', params: { key: projectKey, caseKey } })
  return (
    <div className={cn('relative w-full overflow-x-auto rounded-md border border-border transition-opacity duration-150', fetching && 'opacity-70')} aria-busy={fetching || undefined}>
      <table className="w-full min-w-[40rem] table-fixed border-collapse text-sm">
        <caption className="sr-only">{t('list.tableCaption')}</caption>
        <thead>
          <tr className="h-8 border-b border-border">
            {canEdit && (
              <th scope="col" className="w-10 pl-3">
                <Checkbox
                  checked={allChecked ? true : someChecked ? 'indeterminate' : false}
                  onCheckedChange={onToggleAll}
                  aria-label={t('list.selectAll')}
                />
              </th>
            )}
            <Th className={cn('w-[5.5rem]', !canEdit && 'pl-3')}>{t('list.columns.key')}</Th>
            <Th>{t('list.columns.title')}</Th>
            <Th className="w-[5.5rem]">{t('list.columns.priority')}</Th>
            <Th className="w-[5.5rem]">{t('list.columns.status')}</Th>
            <Th className="hidden w-28 xl:table-cell">{t('list.columns.tags')}</Th>
            <Th className="w-40">{t('list.columns.lastRun')}</Th>
            <Th className="hidden w-24 xl:table-cell">{t('list.columns.updated')}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((tc, i) => {
            const selected = selectedIds.has(tc.id)
            return (
              <tr
                key={tc.id}
                data-selected={selected || undefined}
                onClick={() => open(tc.key)}
                draggable={canEdit}
                onDragStart={(e) => {
                  const ids = selected ? [...selectedIds] : [tc.id]
                  e.dataTransfer.setData(CASE_DRAG_TYPE, JSON.stringify(ids))
                  e.dataTransfer.setData('text/plain', tc.key)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                className="h-9 cursor-pointer border-b border-border transition-colors duration-150 last:border-0 hover:bg-muted/60 data-[selected]:bg-muted"
              >
                {canEdit && (
                  <td className="w-10 pl-3" onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selected}
                      onClick={(e) => {
                        e.preventDefault()
                        onToggleRow(i, e.shiftKey)
                      }}
                      aria-label={t('list.selectRow', { key: tc.key })}
                    />
                  </td>
                )}
                <td className={cn('px-3 font-mono text-xs whitespace-nowrap text-muted-foreground', !canEdit && 'pl-3')}>{tc.key}</td>
                <td className="px-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Link
                      to="/p/$key/tests/$caseKey"
                      params={{ key: projectKey, caseKey: tc.key }}
                      onClick={(e) => e.stopPropagation()}
                      className="truncate font-medium hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {tc.title}
                    </Link>
                    <ManualBadge execution={tc.execution} className="shrink-0" />
                  </div>
                </td>
                <td className="px-3">
                  <div className="flex items-center whitespace-nowrap">
                    <PriorityLabel priority={tc.priority} />
                  </div>
                </td>
                <td className="px-3">
                  <div className="flex items-center whitespace-nowrap">
                    <TestCaseStatusLabel status={tc.status} />
                  </div>
                </td>
                <td className="hidden px-3 xl:table-cell">
                  <div className="flex min-w-0 items-center gap-1" title={tc.tags.join(', ')}>
                    {tc.tags[0] && (
                      <span className="min-w-0 truncate">
                        <TagChip tag={tc.tags[0]} />
                      </span>
                    )}
                    {tc.tags.length > 1 && (
                      <span className="shrink-0 text-xs text-muted-foreground" aria-label={t('list.moreTags', { count: tc.tags.length - 1, tags: tc.tags.slice(1).join(', ') })}>
                        +{tc.tags.length - 1}
                      </span>
                    )}
                  </div>
                </td>
                <td className="overflow-hidden px-3 whitespace-nowrap">
                  {tc.last_run_status ? (
                    <span className="inline-flex items-center gap-1.5">
                      <StatusBadge status={tc.last_run_status} />
                      <time dateTime={tc.last_run_at ?? undefined} title={formatDateTime(tc.last_run_at)} className="text-xs text-muted-foreground">
                        {shortRelative(tc.last_run_at)}
                      </time>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t('list.neverRun')}</span>
                  )}
                </td>
                <td className="hidden px-3 xl:table-cell">
                  <span className="block truncate text-xs" title={t('list.updatedBy', { name: tc.updated_by.name, time: formatDateTime(tc.updated_at) })}>
                    {tc.updated_by.name.split(' ')[0]}{' '}
                    <time dateTime={tc.updated_at} className="text-muted-foreground">
                      {shortRelative(tc.updated_at)}
                    </time>
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function Th({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <th scope="col" className={cn('px-3 text-left align-middle text-xs font-medium whitespace-nowrap text-muted-foreground', className)}>
      {children}
    </th>
  )
}

function TableSkeleton() {
  const { t } = useTranslation('testcases')
  return (
    <div className="rounded-md border border-border" aria-busy aria-label={t('list.loading')}>
      <div className="h-8 border-b border-border" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-4 border-b border-border px-3 last:border-0">
          <Skeleton className="size-4" />
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${55 - (i % 3) * 10}%` }} />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-12" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  )
}

function NewTestCaseButton({ projectKey, folder }: { projectKey: string; folder?: string }) {
  const { t } = useTranslation(['testcases', 'common'])
  return (
    <div className="inline-flex">
      <Button asChild className="rounded-r-none">
        <Link to="/p/$key/tests/$caseKey" params={{ key: projectKey, caseKey: 'new' }} search={{ execution: 'automated', folder }}>
          <Plus /> {t('list.newButton')}
        </Link>
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button className="rounded-l-none border-l border-primary-foreground/25 px-2" aria-label={t('list.newTypeLabel')}>
            <ChevronDown />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-72">
          <DropdownMenuItem asChild className="h-auto items-start py-2">
            <Link to="/p/$key/tests/$caseKey" params={{ key: projectKey, caseKey: 'new' }} search={{ execution: 'automated', folder }}>
              <Bot className="mt-0.5" />
              <span className="flex flex-col">
                <span className="font-medium">{t('common:execution.automated')}</span>
                <span className="text-xs text-muted-foreground">{t('list.newAutomatedHint')}</span>
              </span>
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild className="h-auto items-start py-2">
            <Link to="/p/$key/tests/$caseKey" params={{ key: projectKey, caseKey: 'new' }} search={{ execution: 'manual', folder }}>
              <Hand className="mt-0.5" />
              <span className="flex flex-col">
                <span className="font-medium">{t('common:execution.manual')}</span>
                <span className="text-xs text-muted-foreground">{t('list.newManualHint')}</span>
              </span>
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
