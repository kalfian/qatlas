import { Plus } from 'lucide-react'
import * as React from 'react'
import { useFolders, useTags } from '@/api/queries'
import type { Execution, Priority, TestCaseStatus } from '@/api/types'
import { PRIORITY_LABELS, PriorityLabel, TagChip, TC_STATUS_LABELS, TestCaseStatusLabel } from '@/components/misc'
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
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatDateTime } from '@/lib/format'
import { normalizeTag } from '../BulkBar'
import { buildFolderTree, flattenTree, folderPath, manualStepsAsText, toManualSteps, type Draft } from '../lib'
import { VarField } from './VarField'

const NO_FOLDER = '__none'

export function InfoTab({
  projectKey,
  draft,
  update,
  readOnly,
  meta,
}: {
  projectKey: string
  draft: Draft
  update: (fn: (d: Draft) => Draft) => void
  readOnly: boolean
  meta?: { created_at: string; created_by: string; updated_at: string; updated_by: string }
}) {
  const folders = useFolders(projectKey)
  const { roots, byId } = React.useMemo(() => buildFolderTree(folders.data?.data ?? []), [folders.data])
  const [pendingExec, setPendingExec] = React.useState<Execution | null>(null)
  const stepCount = draft.steps.length

  const applyExecution = (exec: Execution) => {
    update((d) => {
      if (exec === d.execution) return d
      if (exec === 'manual') return { ...d, execution: exec, steps: toManualSteps(d.steps) }
      const text = d.steps.length ? manualStepsAsText(d.steps) : ''
      return {
        ...d,
        execution: exec,
        steps: [],
        description: text ? `${d.description ? `${d.description}\n\n` : ''}Langkah manual sebelumnya:\n${text}` : d.description,
      }
    })
  }

  if (readOnly) {
    return (
      <dl className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Dt>Deskripsi</Dt>
        <Dd>{draft.description || <Muted>Tidak ada deskripsi</Muted>}</Dd>
        <Dt>Prakondisi</Dt>
        <Dd>{draft.preconditions || <Muted>Tidak ada</Muted>}</Dd>
        <Dt>Prioritas</Dt>
        <Dd>
          <PriorityLabel priority={draft.priority} />
        </Dd>
        <Dt>Status</Dt>
        <Dd>
          <TestCaseStatusLabel status={draft.status} />
        </Dd>
        <Dt>Execution</Dt>
        <Dd>{draft.execution === 'manual' ? 'Manual' : 'Automated'}</Dd>
        <Dt>Tag</Dt>
        <Dd>{draft.tags.length ? <span className="flex flex-wrap gap-1">{draft.tags.map((t) => <TagChip key={t} tag={t} />)}</span> : <Muted>Tidak ada tag</Muted>}</Dd>
        <Dt>Folder</Dt>
        <Dd>{draft.folder_id ? folderPath(byId, draft.folder_id) : <Muted>Tanpa folder</Muted>}</Dd>
        {meta && (
          <>
            <Dt>Dibuat</Dt>
            <Dd>
              {meta.created_by} · {formatDateTime(meta.created_at)}
            </Dd>
            <Dt>Diubah</Dt>
            <Dd>
              {meta.updated_by} · {formatDateTime(meta.updated_at)}
            </Dd>
          </>
        )}
      </dl>
    )
  }

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tc-description">Deskripsi</Label>
        <VarField
          id="tc-description"
          multiline
          rows={3}
          value={draft.description}
          onValueChange={(v) => update((d) => ({ ...d, description: v }))}
          placeholder="Apa yang diverifikasi test case ini dan kenapa penting"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tc-preconditions">Prakondisi</Label>
        <VarField
          id="tc-preconditions"
          multiline
          rows={2}
          value={draft.preconditions}
          onValueChange={(v) => update((d) => ({ ...d, preconditions: v }))}
          placeholder="Mis. user qa.bot sudah terdaftar dan keranjang kosong"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-priority">Prioritas</Label>
          <Select value={draft.priority} onValueChange={(v) => update((d) => ({ ...d, priority: v as Priority }))}>
            <SelectTrigger id="tc-priority">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(['critical', 'high', 'medium', 'low'] as Priority[]).map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-folder">Folder</Label>
          <Select value={draft.folder_id ?? NO_FOLDER} onValueChange={(v) => update((d) => ({ ...d, folder_id: v === NO_FOLDER ? null : v }))}>
            <SelectTrigger id="tc-folder">
              <SelectValue placeholder="Tanpa folder" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FOLDER}>Tanpa folder</SelectItem>
              {flattenTree(roots).map((n) => (
                <SelectItem key={n.folder.id} value={n.folder.id}>
                  <span style={{ paddingLeft: n.depth * 12 }}>{n.folder.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium" id="tc-status-label">
          Status
        </span>
        <Segmented
          ariaLabel="Status test case"
          value={draft.status}
          onChange={(v) => update((d) => ({ ...d, status: v as TestCaseStatus }))}
          options={(['draft', 'ready', 'deprecated'] as TestCaseStatus[]).map((s) => ({ value: s, label: TC_STATUS_LABELS[s] }))}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground">Draft dan Deprecated tetap bisa di-run, tapi flow akan memberi peringatan.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">Execution</span>
        <Segmented
          ariaLabel="Execution"
          value={draft.execution}
          onChange={(v) => {
            const exec = v as Execution
            if (exec === draft.execution) return
            if (stepCount === 0) applyExecution(exec)
            else setPendingExec(exec)
          }}
          options={[
            { value: 'automated', label: 'Automated' },
            { value: 'manual', label: 'Manual' },
          ]}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground">
          {draft.execution === 'manual' ? 'Dikerjakan tester langkah demi langkah saat run.' : 'Dijalankan runner Playwright dari step DSL.'}
        </p>
      </div>

      <TagsEditor projectKey={projectKey} tags={draft.tags} onChange={(tags) => update((d) => ({ ...d, tags }))} />

      <AlertDialog open={!!pendingExec} onOpenChange={(o) => !o && setPendingExec(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingExec === 'manual' ? 'Ubah jadi test case manual?' : 'Ubah jadi test case automated?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingExec === 'manual'
                ? `${stepCount} step automated akan diubah jadi langkah manual: deskripsi (atau ringkasan action) menjadi instruksi, expected tetap. Selector dan parameter lain tidak dibawa.`
                : `Langkah manual tidak bisa dijalankan runner. ${stepCount} langkah akan dihapus dari daftar step dan teksnya disalin ke Deskripsi, supaya kamu bisa menulis ulang sebagai step automated.`}{' '}
              Perubahan ini baru tersimpan setelah kamu menekan Simpan.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>Batal</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingExec) applyExecution(pendingExec)
                setPendingExec(null)
              }}
            >
              {pendingExec === 'manual' ? 'Ubah jadi manual' : 'Ubah jadi automated'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function TagsEditor({ projectKey, tags, onChange }: { projectKey: string; tags: string[]; onChange: (t: string[]) => void }) {
  const all = useTags(projectKey)
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState('')
  const normalized = normalizeTag(query)
  const options = (all.data?.data ?? []).filter((t) => !tags.includes(t.tag))
  const add = (t: string) => {
    if (!t || tags.includes(t)) return
    onChange([...tags, t])
    setQuery('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id="tc-tags-label">
        Tag
      </span>
      <div className="flex flex-wrap items-center gap-1.5" aria-labelledby="tc-tags-label" role="group">
        {tags.map((t) => (
          <TagChip key={t} tag={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />
        ))}
        <Popover
          open={open}
          onOpenChange={(o) => {
            setOpen(o)
            if (!o) setQuery('')
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm">
              <Plus /> Tag
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-0">
            <Command>
              <CommandInput placeholder="Cari atau buat tag…" aria-label="Cari atau buat tag" value={query} onValueChange={setQuery} />
              <CommandList>
                <CommandEmpty>{normalized ? null : 'Belum ada tag lain.'}</CommandEmpty>
                {normalized && !tags.includes(normalized) && !options.some((o) => o.tag === normalized) && (
                  <CommandGroup>
                    <CommandItem value={`__create ${normalized}`} onSelect={() => add(normalized)}>
                      <Plus aria-hidden /> Buat tag <span className="font-medium">"{normalized}"</span>
                    </CommandItem>
                  </CommandGroup>
                )}
                <CommandGroup heading="Tag di project ini">
                  {options.map((o) => (
                    <CommandItem key={o.tag} value={o.tag} onSelect={() => add(o.tag)}>
                      <span className="flex-1 truncate">{o.tag}</span>
                      <span className="text-xs tabular text-muted-foreground">{o.count}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}

const Dt = ({ children }: { children: React.ReactNode }) => <dt className="text-sm text-muted-foreground">{children}</dt>
const Dd = ({ children }: { children: React.ReactNode }) => <dd className="text-sm whitespace-pre-wrap">{children}</dd>
const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>
