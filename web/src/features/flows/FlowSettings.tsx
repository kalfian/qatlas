import { Braces, ChevronDown, Plus, X } from 'lucide-react'
import * as React from 'react'
import { TagChip } from '@/components/misc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { newDraftVariable, type DraftVariable, type FlowDraft } from './flow-draft'

type Patch = (fn: (d: FlowDraft) => FlowDraft) => void

const SHARED_HINT = 'Satu browser untuk semua test case: cookie, login, dan vars terbawa ke case berikutnya.'
const ISOLATED_HINT = 'Tiap test case jalan di browser baru; vars runtime di-reset. Boleh berisi test case manual.'
const STOP_HINT = 'Item berikutnya di-skip saat satu item gagal, kecuali item yang diberi continue on failure.'
const NOSTOP_HINT = 'Semua item tetap dijalankan walau ada yang gagal.'

export function FlowSettings({
  draft,
  patch,
  variableErrors,
  readOnly,
}: {
  draft: FlowDraft
  patch: Patch
  variableErrors: Record<string, string>
  readOnly: boolean
}) {
  const varCount = draft.variables.filter((v) => v.key.trim()).length
  const varErrorCount = Object.keys(variableErrors).length

  if (readOnly) {
    return (
      <section aria-label="Pengaturan flow" className="rounded-md border border-border">
        <dl className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          <ReadField label="Session" value={draft.shared_session ? 'Shared session' : 'Isolated'} hint={draft.shared_session ? SHARED_HINT : ISOLATED_HINT} />
          <ReadField label="Stop on failure" value={draft.stop_on_failure ? 'Ya' : 'Tidak'} hint={draft.stop_on_failure ? STOP_HINT : NOSTOP_HINT} />
          <div className="px-4 py-3">
            <dt className="text-xs font-medium text-muted-foreground">Variables ({varCount})</dt>
            <dd className="mt-1">
              {varCount === 0 ? (
                <span className="text-sm text-muted-foreground">Tidak ada</span>
              ) : (
                <ul className="flex flex-col gap-0.5">
                  {draft.variables.map((v) => (
                    <li key={v.uid} className="flex min-w-0 gap-2 font-mono text-xs">
                      <span className="shrink-0 font-medium">{v.key}</span>
                      <span className="truncate text-muted-foreground">{v.value || '""'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        </dl>
        {(draft.description || draft.tags.length > 0) && (
          <dl className="grid gap-3 border-t border-border px-4 py-3 md:grid-cols-3">
            <div className="md:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">Deskripsi</dt>
              <dd className="mt-1 text-sm whitespace-pre-line">{draft.description || <span className="text-muted-foreground">Tidak ada</span>}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">Tag</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {draft.tags.length ? draft.tags.map((t) => <TagChip key={t} tag={t} />) : <span className="text-sm text-muted-foreground">Tidak ada</span>}
              </dd>
            </div>
          </dl>
        )}
      </section>
    )
  }

  return (
    <section aria-label="Pengaturan flow" className="rounded-md border border-border">
      <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        <SwitchField
          id="flow-shared"
          label="Shared session"
          hint={draft.shared_session ? SHARED_HINT : ISOLATED_HINT}
          checked={draft.shared_session}
          onChange={(v) => patch((d) => ({ ...d, shared_session: v }))}
        />
        <SwitchField
          id="flow-stop"
          label="Stop on failure"
          hint={draft.stop_on_failure ? STOP_HINT : NOSTOP_HINT}
          checked={draft.stop_on_failure}
          onChange={(v) => patch((d) => ({ ...d, stop_on_failure: v }))}
        />
        <div className="flex flex-col items-start gap-1 px-4 py-3">
          <VariablesPopover variables={draft.variables} errors={variableErrors} patch={patch} count={varCount} errorCount={varErrorCount} />
          <p className="text-xs text-muted-foreground">
            Dipakai di step sebagai <code className="font-mono">{'{{vars.nama}}'}</code>. Variable test case dengan nama sama menimpanya.
          </p>
        </div>
      </div>
      <div className="grid gap-4 border-t border-border px-4 py-3 md:grid-cols-3">
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor="flow-desc" className="text-xs">
            Deskripsi
          </Label>
          <Textarea
            id="flow-desc"
            rows={2}
            className="min-h-0 resize-y"
            value={draft.description}
            onChange={(e) => patch((d) => ({ ...d, description: e.target.value }))}
            placeholder="Tujuan flow ini, mis. cek checkout end-to-end tiap rilis."
          />
        </div>
        <TagsField tags={draft.tags} onChange={(tags) => patch((d) => ({ ...d, tags }))} />
      </div>
    </section>
  )
}

function ReadField({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="px-4 py-3">
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted-foreground">{hint}</dd>
    </div>
  )
}

function SwitchField({ id, label, hint, checked, onChange }: { id: string; label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-describedby={`${id}-hint`} className="mt-px" />
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      </div>
    </div>
  )
}

function VariablesPopover({
  variables,
  errors,
  patch,
  count,
  errorCount,
}: {
  variables: DraftVariable[]
  errors: Record<string, string>
  patch: Patch
  count: number
  errorCount: number
}) {
  const [open, setOpen] = React.useState(false)
  const focusUid = React.useRef<string | null>(null)

  const add = () => {
    const v = newDraftVariable()
    focusUid.current = v.uid
    patch((d) => ({ ...d, variables: [...d.variables, v] }))
  }
  const update = (uid: string, field: 'key' | 'value', value: string) =>
    patch((d) => ({ ...d, variables: d.variables.map((v) => (v.uid === uid ? { ...v, [field]: value } : v)) }))
  const remove = (uid: string) => patch((d) => ({ ...d, variables: d.variables.filter((v) => v.uid !== uid) }))

  React.useEffect(() => {
    if (!focusUid.current) return
    document.getElementById(`var-key-${focusUid.current}`)?.focus()
    focusUid.current = null
  })

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o && variables.length === 0) add()
      }}
    >
      <PopoverTrigger asChild>
        <Button id="flow-vars-trigger" variant="outline" size="sm" aria-invalid={errorCount > 0 || undefined} className={cn(errorCount > 0 && 'border-destructive')}>
          <Braces /> Variables ({count})
          {errorCount > 0 && <span className="text-destructive">· {errorCount} error</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-[min(calc(100vw-2rem),28rem)] p-0" aria-label="Variables flow">
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h3 className="text-sm font-semibold">Variables flow</h3>
          <span className="text-xs text-muted-foreground">Menimpa variable environment</span>
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto p-3">
          {variables.length > 0 && (
            <div className="grid grid-cols-[1fr_1fr_1.75rem] gap-2 text-xs font-medium text-muted-foreground" aria-hidden>
              <span>Nama</span>
              <span>Nilai</span>
            </div>
          )}
          {variables.map((v, i) => {
            const err = errors[v.uid]
            return (
              <div key={v.uid} className="flex flex-col gap-1">
                <div className="grid grid-cols-[1fr_1fr_1.75rem] items-center gap-2">
                  <Input
                    id={`var-key-${v.uid}`}
                    value={v.key}
                    onChange={(e) => update(v.uid, 'key', e.target.value)}
                    placeholder="product"
                    aria-label={`Nama variable ${i + 1}`}
                    aria-invalid={!!err || undefined}
                    aria-describedby={err ? `var-err-${v.uid}` : undefined}
                    className="h-7 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Input
                    value={v.value}
                    onChange={(e) => update(v.uid, 'value', e.target.value)}
                    placeholder="Kaos Polos"
                    aria-label={`Nilai variable ${v.key || i + 1}`}
                    className="h-7 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Button variant="ghost" size="icon-sm" onClick={() => remove(v.uid)} aria-label={`Hapus variable ${v.key || i + 1}`}>
                    <X />
                  </Button>
                </div>
                {err && (
                  <p id={`var-err-${v.uid}`} className="text-xs text-destructive">
                    {err}
                  </p>
                )}
              </div>
            )
          })}
          <Button variant="ghost" size="sm" onClick={add} className="self-start">
            <Plus /> Tambah variable
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TagsField({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [value, setValue] = React.useState('')
  const commit = () => {
    const parts = value
      .split(',')
      .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter((t) => t && !tags.includes(t))
    if (parts.length) onChange([...tags, ...new Set(parts)])
    setValue('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="flow-tags" className="text-xs">
        Tag
      </Label>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
        {tags.map((t) => (
          <TagChip key={t} tag={t} onRemove={() => onChange(tags.filter((x) => x !== t))} />
        ))}
        <input
          id="flow-tags"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              commit()
            } else if (e.key === 'Backspace' && !value && tags.length) {
              onChange(tags.slice(0, -1))
            }
          }}
          onBlur={commit}
          placeholder={tags.length ? '' : 'smoke, checkout'}
          aria-describedby="flow-tags-hint"
          className="h-6 min-w-20 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-muted-foreground"
        />
      </div>
      <p id="flow-tags-hint" className="sr-only">
        Tekan Enter atau koma untuk menambah tag.
      </p>
    </div>
  )
}
