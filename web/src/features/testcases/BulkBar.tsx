import { Check, ChevronDown, FolderInput, Inbox, Minus, Plus, Tag, Trash2, X } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useBulkTestCases } from '@/api/queries'
import type { BulkTestCaseAction, Folder, TestCaseStatus, TestCaseSummary } from '@/api/types'
import { TC_STATUS_LABELS } from '@/components/misc'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { buildFolderTree, flattenTree, folderPath } from './lib'

export function normalizeTag(t: string): string {
  return t.trim().toLowerCase().replace(/\s+/g, '-')
}

export function BulkBar({
  projectKey,
  selected,
  folders,
  tags,
  onClear,
}: {
  projectKey: string
  selected: TestCaseSummary[]
  folders: Folder[]
  tags: { tag: string; count: number }[]
  onClear: () => void
}) {
  const bulk = useBulkTestCases(projectKey)
  const { t } = useTranslation(['testcases', 'common'])
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const ids = selected.map((s) => s.id)
  const n = selected.length
  const { roots, byId } = React.useMemo(() => buildFolderTree(folders), [folders])

  const run = (body: Omit<BulkTestCaseAction, 'ids'>, message: (count: number) => string, after?: () => void) =>
    bulk.mutate(
      { ids, ...body },
      {
        onSuccess: (res) => {
          toast.success(message(res.updated))
          after?.()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )

  return (
    <div
      className="sticky bottom-4 z-20 mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-overlay"
      role="region"
      aria-label={t('bulk.region')}
    >
      <span className="px-1.5 text-sm font-medium tabular" role="status" aria-live="polite">
        {t('bulk.selected', { count: n })}
      </span>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <MovePopover
        disabled={bulk.isPending}
        options={[{ id: null, label: t('list.noFolder'), depth: 0 }, ...flattenTree(roots).map((node) => ({ id: node.folder.id, label: node.folder.name, depth: node.depth + 1, path: folderPath(byId, node.folder.id) }))]}
        onPick={(id, label) => run({ action: 'move', folder_id: id }, (count) => t('bulk.moved', { count, folder: label }))}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={bulk.isPending}>
            {t('bulk.status')} <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(['draft', 'ready', 'deprecated'] as TestCaseStatus[]).map((s) => (
            <DropdownMenuItem key={s} onSelect={() => run({ action: 'set_status', status: s }, (count) => t('bulk.statusSet', { count, status: TC_STATUS_LABELS[s] }))}>
              {TC_STATUS_LABELS[s]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <TagPopover
        disabled={bulk.isPending}
        selected={selected}
        tags={tags}
        onAdd={(tag) => run({ action: 'add_tags', tags: [tag] }, (count) => t('bulk.tagAdded', { count, tag }))}
        onRemove={(tag) => run({ action: 'remove_tags', tags: [tag] }, (count) => t('bulk.tagRemoved', { count, tag }))}
      />
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={bulk.isPending} onClick={() => setConfirmDelete(true)}>
        <Trash2 /> {t('common:actions.delete')}
      </Button>
      <span className="ml-auto flex items-center gap-1.5">
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label={t('bulk.clear')} title={t('bulk.clearTitle')}>
          <X />
        </Button>
      </span>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('bulk.deleteTitle', { count: n })}</AlertDialogTitle>
            <AlertDialogDescription>
              {n === 1 ? (
                <Trans t={t} i18nKey="bulk.deleteOne" values={{ key: selected[0].key }} components={{ mono: <span className="font-mono" /> }} />
              ) : (
                t('bulk.deleteMany', { count: n })
              )}{' '}
              {t('bulk.deleteHistoryKept')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {n > 1 && (
            <ul className="max-h-40 overflow-y-auto rounded-md border border-border px-3 py-2 text-sm">
              {selected.map((s) => (
                <li key={s.id} className="flex gap-2 py-0.5">
                  <span className="w-20 shrink-0 font-mono text-xs leading-5 text-muted-foreground">{s.key}</span>
                  <span className="truncate">{s.title}</span>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t('common:actions.cancel')}</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={bulk.isPending}
              onClick={() =>
                run({ action: 'delete' }, (count) => t('bulk.deleted', { count }), () => {
                  setConfirmDelete(false)
                  onClear()
                })
              }
            >
              {t('bulk.deleteConfirm', { count: n })}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function MovePopover({
  options,
  onPick,
  disabled,
}: {
  options: { id: string | null; label: string; depth: number; path?: string }[]
  onPick: (id: string | null, label: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const { t } = useTranslation('testcases')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <FolderInput /> {t('bulk.move')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="top">
        <Command>
          <CommandInput placeholder={t('bulk.folderSearchPlaceholder')} aria-label={t('bulk.folderSearchLabel')} />
          <CommandList>
            <CommandEmpty>{t('bulk.folderNotFound')}</CommandEmpty>
            <CommandGroup heading={t('bulk.moveHeading')}>
              {options.map((o) => (
                <CommandItem
                  key={o.id ?? 'none'}
                  value={o.path ?? o.label}
                  onSelect={() => {
                    setOpen(false)
                    onPick(o.id, o.path ?? o.label)
                  }}
                  style={{ paddingLeft: 8 + Math.max(0, o.depth - 1) * 12 }}
                >
                  {o.id === null ? <Inbox aria-hidden /> : null}
                  <span className="truncate">{o.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TagPopover({
  selected,
  tags,
  onAdd,
  onRemove,
  disabled,
}: {
  selected: TestCaseSummary[]
  tags: { tag: string; count: number }[]
  onAdd: (t: string) => void
  onRemove: (t: string) => void
  disabled: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const { t } = useTranslation('testcases')
  const [query, setQuery] = React.useState('')
  const normalized = normalizeTag(query)
  const exists = tags.some((t) => t.tag === normalized)
  const stateOf = (tag: string): 'all' | 'some' | 'none' => {
    const has = selected.filter((s) => s.tags.includes(tag)).length
    return has === 0 ? 'none' : has === selected.length ? 'all' : 'some'
  }
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <Tag /> {t('bulk.tags')}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="top">
        <Command>
          <CommandInput placeholder={t('bulk.tagSearchPlaceholder')} aria-label={t('bulk.tagSearchLabel')} value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{normalized ? null : t('bulk.noTags')}</CommandEmpty>
            {normalized && !exists && (
              <CommandGroup>
                <CommandItem
                  value={`__create ${normalized}`}
                  onSelect={() => {
                    onAdd(normalized)
                    setQuery('')
                  }}
                >
                  <Plus aria-hidden />{' '}
                  <Trans t={t} i18nKey="bulk.addTag" values={{ tag: normalized }} components={{ b: <span className="font-medium" /> }} />
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading={t('bulk.tagGroupHeading')}>
              {tags.map(({ tag }) => {
                const st = stateOf(tag)
                return (
                  <CommandItem
                    key={tag}
                    value={tag}
                    onSelect={() => (st === 'all' ? onRemove(tag) : onAdd(tag))}
                    aria-label={`${tag}, ${st === 'all' ? t('bulk.tagStateAll') : st === 'some' ? t('bulk.tagStateSome') : t('bulk.tagStateNone')}`}
                  >
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-sm border border-input',
                        st !== 'none' && 'border-primary bg-primary [&_svg]:!text-primary-foreground',
                      )}
                      aria-hidden
                    >
                      {st === 'all' && <Check className="size-3" />}
                      {st === 'some' && <Minus className="size-3" />}
                    </span>
                    <span className="truncate">{tag}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
