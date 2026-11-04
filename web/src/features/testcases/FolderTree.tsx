import { ChevronRight, Ellipsis, Folder as FolderIcon, FolderOpen, FolderPlus, Inbox, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useFolderMutations } from '@/api/queries'
import type { Folder } from '@/api/types'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { buildFolderTree, flattenTree, folderPath, type FolderNode } from './lib'

export const CASE_DRAG_TYPE = 'application/x-qatlas-cases'

/** Nilai filter folder di URL: undefined = semua, 'root' = tanpa folder, selain itu id folder. */
export type FolderValue = string | undefined

type Row =
  | { kind: 'all'; id: 'all' }
  | { kind: 'root'; id: 'root' }
  | { kind: 'folder'; id: string; node: FolderNode }
  | { kind: 'new'; id: string; parentId: string | null; depth: number }

export function FolderTree({
  projectKey,
  folders,
  loading,
  selected,
  onSelect,
  canEdit,
  totalCount,
  rootCount,
  onDropCases,
}: {
  projectKey: string
  folders: Folder[] | undefined
  loading: boolean
  selected: FolderValue
  onSelect: (v: FolderValue) => void
  canEdit: boolean
  totalCount: number | undefined
  rootCount: number
  onDropCases?: (folderId: string | null, ids: string[]) => void
}) {
  const { roots, byId } = React.useMemo(() => buildFolderTree(folders ?? []), [folders])
  const mutations = useFolderMutations(projectKey)
  const { t } = useTranslation('testcases')

  // Folder dari path terpilih selalu terbuka; sisanya mengikuti toggle user.
  const [toggled, setToggled] = React.useState<Record<string, boolean>>({})
  const expanded = React.useMemo(() => {
    const set = new Set<string>()
    for (const n of byId.values()) if (toggled[n.folder.id] ?? false) set.add(n.folder.id)
    let cur = selected && selected !== 'root' ? byId.get(selected) : undefined
    while (cur?.folder.parent_id) {
      if (toggled[cur.folder.parent_id] !== false) set.add(cur.folder.parent_id)
      cur = byId.get(cur.folder.parent_id)
    }
    return set
  }, [byId, toggled, selected])

  const [creating, setCreating] = React.useState<{ parentId: string | null } | null>(null)
  const [renaming, setRenaming] = React.useState<string | null>(null)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [deleting, setDeleting] = React.useState<FolderNode | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)

  const rows: Row[] = React.useMemo(() => {
    const out: Row[] = [{ kind: 'all', id: 'all' }]
    const visible = flattenTree(roots, expanded)
    for (const node of visible) out.push({ kind: 'folder', id: node.folder.id, node })
    if (creating) {
      const row: Row = { kind: 'new', id: '__new', parentId: creating.parentId, depth: 0 }
      if (creating.parentId) {
        const parent = byId.get(creating.parentId)
        const idx = out.findIndex((r) => r.id === creating.parentId)
        // sisipkan setelah turunan terakhir yang terlihat
        let end = idx + 1
        while (end < out.length && out[end].kind === 'folder' && isDescendant(byId, (out[end] as { id: string }).id, creating.parentId)) end++
        out.splice(end, 0, { ...row, depth: (parent?.depth ?? 0) + 1 })
      } else out.push(row)
    }
    if (rootCount > 0 || selected === 'root') out.push({ kind: 'root', id: 'root' })
    return out
  }, [roots, expanded, creating, byId, rootCount, selected])

  const selectedId = selected === undefined ? 'all' : selected
  const [focusId, setFocusId] = React.useState<string>(selectedId)
  const activeFocus = rows.some((r) => r.id === focusId) ? focusId : selectedId
  const itemRefs = React.useRef(new Map<string, HTMLElement>())

  const focusRow = (id: string) => {
    setFocusId(id)
    requestAnimationFrame(() => itemRefs.current.get(id)?.focus())
  }

  const toggle = (id: string, open?: boolean) => setToggled((t) => ({ ...t, [id]: open ?? !expanded.has(id) }))

  const valueOf = (row: Row): FolderValue => (row.kind === 'all' ? undefined : row.kind === 'root' ? 'root' : row.id)

  const startCreate = (parentId: string | null) => {
    if (parentId) toggle(parentId, true)
    setCreating({ parentId })
  }

  const onKeyDown = (e: React.KeyboardEvent, row: Row) => {
    if (row.kind === 'new') return
    const nav = rows.filter((r) => r.kind !== 'new')
    const i = nav.findIndex((r) => r.id === row.id)
    const node = row.kind === 'folder' ? row.node : undefined
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        if (nav[i + 1]) focusRow(nav[i + 1].id)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (nav[i - 1]) focusRow(nav[i - 1].id)
        break
      case 'Home':
        e.preventDefault()
        focusRow(nav[0].id)
        break
      case 'End':
        e.preventDefault()
        focusRow(nav[nav.length - 1].id)
        break
      case 'ArrowRight':
        if (node?.children.length) {
          e.preventDefault()
          if (!expanded.has(node.folder.id)) toggle(node.folder.id, true)
          else focusRow(node.children[0].folder.id)
        }
        break
      case 'ArrowLeft':
        if (node) {
          e.preventDefault()
          if (node.children.length && expanded.has(node.folder.id)) toggle(node.folder.id, false)
          else if (node.folder.parent_id) focusRow(node.folder.parent_id)
          else focusRow('all')
        }
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        onSelect(valueOf(row))
        break
      case 'F2':
        if (canEdit && node) {
          e.preventDefault()
          setRenaming(node.folder.id)
        }
        break
      case 'Delete':
        if (canEdit && node) {
          e.preventDefault()
          setDeleting(node)
        }
        break
      case 'ContextMenu':
        if (canEdit && node) {
          e.preventDefault()
          setMenuFor(node.folder.id)
        }
        break
      case 'F10':
        if (e.shiftKey && canEdit && node) {
          e.preventDefault()
          setMenuFor(node.folder.id)
        }
        break
    }
  }

  const dropProps = (row: Row) => {
    if (!onDropCases || !canEdit || row.kind === 'all' || row.kind === 'new') return {}
    const folderId = row.kind === 'root' ? null : row.id
    return {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(CASE_DRAG_TYPE)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setDropTarget(row.id)
      },
      onDragLeave: () => setDropTarget((t) => (t === row.id ? null : t)),
      onDrop: (e: React.DragEvent) => {
        e.preventDefault()
        setDropTarget(null)
        try {
          const ids = JSON.parse(e.dataTransfer.getData(CASE_DRAG_TYPE)) as string[]
          if (ids.length) onDropCases(folderId, ids)
        } catch {
          // data drag bukan dari tabel test case
        }
      },
    }
  }

  if (loading) {
    return (
      <div className="flex flex-col gap-1.5" aria-hidden>
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-7" style={{ marginLeft: i === 0 ? 0 : 12, width: `${80 - i * 6}%` }} />
        ))}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex h-7 items-center justify-between">
        <h2 className="text-xs font-medium text-muted-foreground" id="folder-tree-label">
          {t('folders.heading')}
        </h2>
        {canEdit && (
          <Button variant="ghost" size="icon-sm" aria-label={t('folders.new')} title={t('folders.new')} onClick={() => startCreate(null)}>
            <FolderPlus />
          </Button>
        )}
      </div>
      <ul role="tree" aria-labelledby="folder-tree-label" className="flex flex-col gap-px">
        {rows.map((row) => {
          if (row.kind === 'new') {
            return (
              <li key="__new" role="none" style={{ paddingLeft: 8 + row.depth * 12 }} className="py-0.5 pr-1">
                <FolderNameInput
                  label={row.parentId ? t('folders.newSubfolderName', { parent: byId.get(row.parentId)?.folder.name ?? '' }) : t('folders.newFolderName')}
                  initial=""
                  pending={mutations.create.isPending}
                  onCancel={() => setCreating(null)}
                  onSubmit={(name) =>
                    mutations.create.mutate(
                      { name, parent_id: row.parentId },
                      {
                        onSuccess: (f) => {
                          setCreating(null)
                          toast.success(t('folders.created', { name: f.name }))
                        },
                        onError: (err) => toast.error(errorMessage(err)),
                      },
                    )
                  }
                />
              </li>
            )
          }
          const isSelected = row.id === selectedId
          const node = row.kind === 'folder' ? row.node : undefined
          const depth = node ? node.depth : 0
          const label = row.kind === 'all' ? t('folders.allCases') : row.kind === 'root' ? t('list.noFolder') : node!.folder.name
          const count = row.kind === 'all' ? totalCount : row.kind === 'root' ? rootCount : node!.total
          const hasChildren = !!node?.children.length
          const isOpen = node ? expanded.has(node.folder.id) : undefined
          const Icon = row.kind === 'all' ? Layers : row.kind === 'root' ? Inbox : isOpen ? FolderOpen : FolderIcon

          if (node && renaming === node.folder.id) {
            return (
              <li key={row.id} role="none" style={{ paddingLeft: 8 + depth * 12 }} className="py-0.5 pr-1">
                <FolderNameInput
                  label={t('folders.renameLabel', { name: node.folder.name })}
                  initial={node.folder.name}
                  pending={mutations.update.isPending}
                  onCancel={() => {
                    setRenaming(null)
                    focusRow(node.folder.id)
                  }}
                  onSubmit={(name) => {
                    if (name === node.folder.name) {
                      setRenaming(null)
                      focusRow(node.folder.id)
                      return
                    }
                    mutations.update.mutate(
                      { id: node.folder.id, name },
                      {
                        onSuccess: () => {
                          setRenaming(null)
                          focusRow(node.folder.id)
                        },
                        onError: (err) => toast.error(errorMessage(err)),
                      },
                    )
                  }}
                />
              </li>
            )
          }

          return (
            <li
              key={row.id}
              role="treeitem"
              aria-level={row.kind === 'folder' ? depth + 1 : 1}
              aria-selected={isSelected}
              aria-expanded={hasChildren ? isOpen : undefined}
              aria-label={t('folders.itemLabel', { label: row.kind === 'all' ? t('list.allFolders') : label, count: count ?? 0 })}
              tabIndex={row.id === activeFocus ? 0 : -1}
              ref={(el) => {
                if (el) itemRefs.current.set(row.id, el)
                else itemRefs.current.delete(row.id)
              }}
              onFocus={(e) => {
                if (e.target === e.currentTarget) setFocusId(row.id)
              }}
              onKeyDown={(e) => {
                if (e.target === e.currentTarget) onKeyDown(e, row)
              }}
              onClick={() => {
                setFocusId(row.id)
                onSelect(valueOf(row))
              }}
              onContextMenu={(e) => {
                if (!canEdit || !node) return
                e.preventDefault()
                setMenuFor(node.folder.id)
              }}
              {...dropProps(row)}
              className={cn(
                'group relative flex h-8 cursor-pointer items-center gap-1.5 rounded-md pr-1 text-sm outline-none select-none transition-colors duration-150 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
                isSelected && 'bg-accent font-medium text-accent-foreground',
                dropTarget === row.id && 'bg-accent ring-2 ring-ring ring-inset',
                row.kind === 'root' && 'mt-1',
              )}
              style={{ paddingLeft: 4 + depth * 12 }}
            >
              <span className="flex size-4 shrink-0 items-center justify-center">
                {hasChildren && (
                  <button
                    type="button"
                    tabIndex={-1}
                    aria-hidden
                    onClick={(e) => {
                      e.stopPropagation()
                      toggle(node!.folder.id)
                    }}
                    className="flex size-4 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                  >
                    <ChevronRight className={cn('size-3.5 transition-transform duration-150', isOpen && 'rotate-90')} />
                  </button>
                )}
              </span>
              <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{row.kind === 'all' ? t('list.allFolders') : label}</span>
              <span className={cn('text-xs tabular text-muted-foreground', canEdit && node && 'group-hover:hidden group-focus-within:hidden', menuFor === row.id && 'hidden')}>
                {count ?? '–'}
              </span>
              {canEdit && node && (
                <DropdownMenu open={menuFor === node.folder.id} onOpenChange={(o) => setMenuFor(o ? node.folder.id : null)}>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-hidden
                      onClick={(e) => e.stopPropagation()}
                      className={cn(
                        'hidden size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground group-hover:flex group-focus-within:flex',
                        menuFor === node.folder.id && 'flex',
                      )}
                    >
                      <Ellipsis className="size-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="start"
                    onClick={(e) => e.stopPropagation()}
                    onCloseAutoFocus={(e) => {
                      e.preventDefault()
                      if (!renaming && !deleting && !creating) itemRefs.current.get(node.folder.id)?.focus()
                    }}
                  >
                    <DropdownMenuItem onSelect={() => startCreate(node.folder.id)}>
                      <Plus /> {t('folders.newSubfolder')}
                    </DropdownMenuItem>
                    <DropdownMenuItem onSelect={() => setRenaming(node.folder.id)}>
                      <Pencil /> {t('folders.rename')} <DropdownMenuShortcut>F2</DropdownMenuShortcut>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem destructive onSelect={() => setDeleting(node)}>
                      <Trash2 /> {t('folders.deleteEllipsis')} <DropdownMenuShortcut>Del</DropdownMenuShortcut>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
            </li>
          )
        })}
      </ul>
      {canEdit && !creating && (
        <Button variant="ghost" size="sm" className="mt-1 justify-start px-2 text-muted-foreground" onClick={() => startCreate(null)}>
          <Plus /> {t('folders.add')}
        </Button>
      )}
      {roots.length === 0 && !creating && (
        <p className="px-2 py-1 text-xs text-muted-foreground">{canEdit ? t('folders.emptyEditable') : t('folders.empty')}</p>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          {deleting && (
            <DeleteFolderBody
              node={deleting}
              target={deleting.folder.parent_id ? folderPath(byId, deleting.folder.parent_id) : null}
              pending={mutations.remove.isPending}
              onConfirm={() =>
                mutations.remove.mutate(deleting.folder.id, {
                  onSuccess: () => {
                    toast.success(t('folders.deleted', { name: deleting.folder.name }))
                    if (selected && (selected === deleting.folder.id || isDescendant(byId, selected, deleting.folder.id))) {
                      onSelect(deleting.folder.parent_id ?? undefined)
                    }
                    setDeleting(null)
                  },
                  onError: (err) => toast.error(errorMessage(err)),
                })
              }
            />
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function DeleteFolderBody({ node, target, pending, onConfirm }: { node: FolderNode; target: string | null; pending: boolean; onConfirm: () => void }) {
  const direct = node.folder.test_case_count
  const subs = node.children.length
  const { t } = useTranslation(['testcases', 'common'])
  const where = target ? t('folders.deleteTargetFolder', { folder: target }) : t('folders.deleteTargetRoot')
  const contents = subs
    ? t('folders.deleteContentsWithSubs', { count: direct, subs: t('folders.subfolderCount', { count: subs }) })
    : t('folders.deleteContents', { count: direct })
  return (
    <>
      <AlertDialogHeader>
        <AlertDialogTitle>{t('folders.deleteTitle', { name: node.folder.name })}</AlertDialogTitle>
        <AlertDialogDescription>
          {direct === 0 && subs === 0 ? t('folders.deleteEmpty') : t('folders.deleteBody', { contents, target: where })}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel autoFocus>{t('common:actions.cancel')}</AlertDialogCancel>
        <Button variant="destructive" loading={pending} onClick={onConfirm}>
          {t('folders.delete')}
        </Button>
      </AlertDialogFooter>
    </>
  )
}

function FolderNameInput({
  label,
  initial,
  pending,
  onSubmit,
  onCancel,
}: {
  label: string
  initial: string
  pending: boolean
  onSubmit: (name: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = React.useState(initial)
  const { t } = useTranslation('testcases')
  const done = React.useRef(false)
  const submit = () => {
    if (done.current || pending) return
    const name = value.trim()
    if (!name) {
      done.current = true
      onCancel()
      return
    }
    onSubmit(name)
  }
  return (
    <Input
      autoFocus
      aria-label={label}
      value={value}
      disabled={pending}
      onFocus={(e) => e.currentTarget.select()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          submit()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          done.current = true
          onCancel()
        }
      }}
      onBlur={submit}
      placeholder={t('folders.namePlaceholder')}
      className="h-7"
    />
  )
}

function isDescendant(byId: Map<string, FolderNode>, id: string, ancestorId: string): boolean {
  let cur = byId.get(id)?.folder.parent_id
  while (cur) {
    if (cur === ancestorId) return true
    cur = byId.get(cur)?.folder.parent_id
  }
  return false
}
