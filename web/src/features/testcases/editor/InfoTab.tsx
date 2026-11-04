import { Plus } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
  const { t } = useTranslation(['testcases', 'common'])

  const applyExecution = (exec: Execution) => {
    update((d) => {
      if (exec === d.execution) return d
      if (exec === 'manual') return { ...d, execution: exec, steps: toManualSteps(d.steps) }
      const text = d.steps.length ? manualStepsAsText(d.steps) : ''
      return {
        ...d,
        execution: exec,
        steps: [],
        description: text ? `${d.description ? `${d.description}\n\n` : ''}${t('info.previousManualSteps')}\n${text}` : d.description,
      }
    })
  }

  if (readOnly) {
    return (
      <dl className="grid max-w-3xl grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[10rem_minmax(0,1fr)]">
        <Dt>{t('fields.description')}</Dt>
        <Dd>{draft.description || <Muted>{t('info.noDescription')}</Muted>}</Dd>
        <Dt>{t('fields.preconditions')}</Dt>
        <Dd>{draft.preconditions || <Muted>{t('info.none')}</Muted>}</Dd>
        <Dt>{t('fields.priority')}</Dt>
        <Dd>
          <PriorityLabel priority={draft.priority} />
        </Dd>
        <Dt>{t('fields.status')}</Dt>
        <Dd>
          <TestCaseStatusLabel status={draft.status} />
        </Dd>
        <Dt>{t('fields.execution')}</Dt>
        <Dd>{t(`common:execution.${draft.execution}`)}</Dd>
        <Dt>{t('fields.tags')}</Dt>
        <Dd>{draft.tags.length ? <span className="flex flex-wrap gap-1">{draft.tags.map((tag) => <TagChip key={tag} tag={tag} />)}</span> : <Muted>{t('info.noTags')}</Muted>}</Dd>
        <Dt>{t('info.folder')}</Dt>
        <Dd>{draft.folder_id ? folderPath(byId, draft.folder_id) : <Muted>{t('list.noFolder')}</Muted>}</Dd>
        {meta && (
          <>
            <Dt>{t('info.created')}</Dt>
            <Dd>
              {meta.created_by} · {formatDateTime(meta.created_at)}
            </Dd>
            <Dt>{t('info.updated')}</Dt>
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
        <Label htmlFor="tc-description">{t('fields.description')}</Label>
        <VarField
          id="tc-description"
          multiline
          rows={3}
          value={draft.description}
          onValueChange={(v) => update((d) => ({ ...d, description: v }))}
          placeholder={t('info.descriptionPlaceholder')}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="tc-preconditions">{t('fields.preconditions')}</Label>
        <VarField
          id="tc-preconditions"
          multiline
          rows={2}
          value={draft.preconditions}
          onValueChange={(v) => update((d) => ({ ...d, preconditions: v }))}
          placeholder={t('info.preconditionsPlaceholder')}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="tc-priority">{t('fields.priority')}</Label>
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
          <Label htmlFor="tc-folder">{t('info.folder')}</Label>
          <Select value={draft.folder_id ?? NO_FOLDER} onValueChange={(v) => update((d) => ({ ...d, folder_id: v === NO_FOLDER ? null : v }))}>
            <SelectTrigger id="tc-folder">
              <SelectValue placeholder={t('list.noFolder')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_FOLDER}>{t('list.noFolder')}</SelectItem>
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
          {t('fields.status')}
        </span>
        <Segmented
          ariaLabel={t('info.statusLabel')}
          value={draft.status}
          onChange={(v) => update((d) => ({ ...d, status: v as TestCaseStatus }))}
          options={(['draft', 'ready', 'deprecated'] as TestCaseStatus[]).map((s) => ({ value: s, label: TC_STATUS_LABELS[s] }))}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground">{t('info.statusHint')}</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium">{t('fields.execution')}</span>
        <Segmented
          ariaLabel={t('fields.execution')}
          value={draft.execution}
          onChange={(v) => {
            const exec = v as Execution
            if (exec === draft.execution) return
            if (stepCount === 0) applyExecution(exec)
            else setPendingExec(exec)
          }}
          options={[
            { value: 'automated', label: t('common:execution.automated') },
            { value: 'manual', label: t('common:execution.manual') },
          ]}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground">
          {draft.execution === 'manual' ? t('info.manualHint') : t('list.newAutomatedHint')}
        </p>
      </div>

      <TagsEditor projectKey={projectKey} tags={draft.tags} onChange={(tags) => update((d) => ({ ...d, tags }))} />

      <AlertDialog open={!!pendingExec} onOpenChange={(o) => !o && setPendingExec(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{pendingExec === 'manual' ? t('info.convert.toManualTitle') : t('info.convert.toAutomatedTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingExec === 'manual'
                ? t('info.convert.toManualBody', { count: stepCount })
                : t('info.convert.toAutomatedBody', { count: stepCount })}{' '}
              {t('info.convert.savedOnSave')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel autoFocus>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingExec) applyExecution(pendingExec)
                setPendingExec(null)
              }}
            >
              {pendingExec === 'manual' ? t('info.convert.toManual') : t('info.convert.toAutomated')}
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
  const { t } = useTranslation('testcases')
  const options = (all.data?.data ?? []).filter((o) => !tags.includes(o.tag))
  const add = (tag: string) => {
    if (!tag || tags.includes(tag)) return
    onChange([...tags, tag])
    setQuery('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium" id="tc-tags-label">
        {t('fields.tags')}
      </span>
      <div className="flex flex-wrap items-center gap-1.5" aria-labelledby="tc-tags-label" role="group">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} onRemove={() => onChange(tags.filter((x) => x !== tag))} />
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
              <Plus /> {t('info.addTag')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-60 p-0">
            <Command>
              <CommandInput placeholder={t('bulk.tagSearchPlaceholder')} aria-label={t('bulk.tagSearchLabel')} value={query} onValueChange={setQuery} />
              <CommandList>
                <CommandEmpty>{normalized ? null : t('info.noOtherTags')}</CommandEmpty>
                {normalized && !tags.includes(normalized) && !options.some((o) => o.tag === normalized) && (
                  <CommandGroup>
                    <CommandItem value={`__create ${normalized}`} onSelect={() => add(normalized)}>
                      <Plus aria-hidden />{' '}
                      <Trans t={t} i18nKey="info.createTag" values={{ tag: normalized }} components={{ b: <span className="font-medium" /> }} />
                    </CommandItem>
                  </CommandGroup>
                )}
                <CommandGroup heading={t('info.projectTags')}>
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
