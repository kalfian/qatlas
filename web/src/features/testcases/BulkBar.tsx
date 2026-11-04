import { Check, ChevronDown, FolderInput, Inbox, Minus, Plus, Tag, Trash2, X } from 'lucide-react'
import * as React from 'react'
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
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const ids = selected.map((s) => s.id)
  const n = selected.length
  const { roots, byId } = React.useMemo(() => buildFolderTree(folders), [folders])

  const run = (body: Omit<BulkTestCaseAction, 'ids'>, message: string, after?: () => void) =>
    bulk.mutate(
      { ids, ...body },
      {
        onSuccess: (res) => {
          toast.success(message.replace('{n}', String(res.updated)))
          after?.()
        },
        onError: (err) => toast.error(errorMessage(err)),
      },
    )

  return (
    <div
      className="sticky bottom-4 z-20 mt-2 flex flex-wrap items-center gap-1 rounded-lg border border-border bg-popover px-2 py-1.5 text-popover-foreground shadow-overlay"
      role="region"
      aria-label="Aksi untuk test case terpilih"
    >
      <span className="px-1.5 text-sm font-medium tabular" role="status" aria-live="polite">
        {n} dipilih
      </span>
      <span className="mx-1 h-4 w-px bg-border" aria-hidden />
      <MovePopover
        disabled={bulk.isPending}
        options={[{ id: null, label: 'Tanpa folder', depth: 0 }, ...flattenTree(roots).map((node) => ({ id: node.folder.id, label: node.folder.name, depth: node.depth + 1, path: folderPath(byId, node.folder.id) }))]}
        onPick={(id, label) => run({ action: 'move', folder_id: id }, `{n} test case dipindah ke ${label}`)}
      />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" disabled={bulk.isPending}>
            Status <ChevronDown className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {(['draft', 'ready', 'deprecated'] as TestCaseStatus[]).map((s) => (
            <DropdownMenuItem key={s} onSelect={() => run({ action: 'set_status', status: s }, `Status {n} test case jadi ${TC_STATUS_LABELS[s]}`)}>
              {TC_STATUS_LABELS[s]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <TagPopover
        disabled={bulk.isPending}
        selected={selected}
        tags={tags}
        onAdd={(t) => run({ action: 'add_tags', tags: [t] }, `Tag "${t}" ditambahkan ke {n} test case`)}
        onRemove={(t) => run({ action: 'remove_tags', tags: [t] }, `Tag "${t}" dihapus dari {n} test case`)}
      />
      <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive" disabled={bulk.isPending} onClick={() => setConfirmDelete(true)}>
        <Trash2 /> Hapus
      </Button>
      <span className="ml-auto flex items-center gap-1.5">
        <Kbd className="hidden sm:inline-flex">Esc</Kbd>
        <Button variant="ghost" size="icon-sm" onClick={onClear} aria-label="Batalkan pilihan" title="Batalkan pilihan (Esc)">
          <X />
        </Button>
      </span>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Hapus {n} test case?</AlertDialogTitle>
            <AlertDialogDescription>
              {n === 1 ? <><span className="font-mono">{selected[0].key}</span> tidak bisa dipakai lagi di run atau flow baru.</> : `${n} test case ini tidak bisa dipakai lagi di run atau flow baru.`}{' '}
              Riwayat run yang sudah ada tetap tersimpan.
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
            <AlertDialogCancel autoFocus>Batal</AlertDialogCancel>
            <Button
              variant="destructive"
              loading={bulk.isPending}
              onClick={() =>
                run({ action: 'delete' }, '{n} test case dihapus', () => {
                  setConfirmDelete(false)
                  onClear()
                })
              }
            >
              Hapus {n} test case
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
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" disabled={disabled}>
          <FolderInput /> Pindah
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="top">
        <Command>
          <CommandInput placeholder="Cari folder…" aria-label="Cari folder tujuan" />
          <CommandList>
            <CommandEmpty>Folder tidak ditemukan.</CommandEmpty>
            <CommandGroup heading="Pindah ke folder">
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
  const [query, setQuery] = React.useState('')
  const normalized = normalizeTag(query)
  const exists = tags.some((t) => t.tag === normalized)
  const stateOf = (t: string): 'all' | 'some' | 'none' => {
    const has = selected.filter((s) => s.tags.includes(t)).length
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
          <Tag /> Tag
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" side="top">
        <Command>
          <CommandInput placeholder="Cari atau buat tag…" aria-label="Cari atau buat tag" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{normalized ? null : 'Belum ada tag.'}</CommandEmpty>
            {normalized && !exists && (
              <CommandGroup>
                <CommandItem
                  value={`__create ${normalized}`}
                  onSelect={() => {
                    onAdd(normalized)
                    setQuery('')
                  }}
                >
                  <Plus aria-hidden /> Tambah tag <span className="font-medium">"{normalized}"</span>
                </CommandItem>
              </CommandGroup>
            )}
            <CommandGroup heading="Klik untuk tambah / hapus dari pilihan">
              {tags.map(({ tag }) => {
                const st = stateOf(tag)
                return (
                  <CommandItem
                    key={tag}
                    value={tag}
                    onSelect={() => (st === 'all' ? onRemove(tag) : onAdd(tag))}
                    aria-label={`${tag}, ${st === 'all' ? 'semua punya, klik untuk hapus' : st === 'some' ? 'sebagian punya, klik untuk tambah ke semua' : 'klik untuk tambah'}`}
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
