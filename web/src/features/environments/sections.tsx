import { CircleDashed, Copy, KeyRound, Plus, Trash2, Variable } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useEnvironmentMutations } from '@/api/queries'
import type { Environment } from '@/api/types'
import { useCopy } from '@/components/misc'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tip } from '@/components/ui/tooltip'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn, uid } from '@/lib/utils'
import { fieldErrorsOf, relativeTime, useRefocusAfterPending } from '@/features/settings/shared'
import { DeleteSecretDialog, FormAlert, SecretDialog } from './dialogs'

const VAR_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/* ------------------------------------------------------------------ shared bits */

function SectionHeader({ id, title, count, description, action }: {
  id: string
  title: string
  count: number
  description: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <h3 id={id} className="text-sm font-semibold">
          {title} <span className="tabular font-normal text-muted-foreground">{count}</span>
        </h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      {action}
    </header>
  )
}

export function CopyRefButton({ text }: { text: string }) {
  const { t } = useTranslation('environments')
  const { copy } = useCopy()
  return (
    <Tip label={t('copyRef', { text })}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label={t('copyRef', { text })}
        onClick={() => copy(text, t('copiedRef', { text }))}
        className="text-muted-foreground hover:text-foreground"
      >
        <Copy />
      </Button>
    </Tip>
  )
}

/* ------------------------------------------------------------------ variables */

interface Row {
  id: string
  key: string
  value: string
}

const toRows = (vars: Record<string, string>): Row[] => Object.entries(vars).map(([key, value]) => ({ id: uid('v'), key, value }))
const signature = (rows: { key: string; value: string }[]) => JSON.stringify(rows.filter((r) => r.key || r.value).map((r) => [r.key.trim(), r.value]))
const serverSignature = (vars: Record<string, string>) => JSON.stringify(Object.entries(vars))

export function VariablesSection({ projectKey, env, canManage, onDirtyChange }: {
  projectKey: string
  env: Environment
  canManage: boolean
  onDirtyChange: (dirty: boolean) => void
}) {
  const { t } = useTranslation('environments')
  const count = Object.keys(env.variables).length
  return (
    <section aria-labelledby="vars-title" className="rounded-md border border-border bg-card">
      <SectionHeader
        id="vars-title"
        title={t('variables.title')}
        count={count}
        description={<Trans t={t} i18nKey="variables.description" values={{ ref: '{{env.KEY}}' }} components={{ code: <code className="font-mono" /> }} />}
      />
      {canManage ? (
        <VariablesEditor key={env.id} projectKey={projectKey} env={env} onDirtyChange={onDirtyChange} />
      ) : count === 0 ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Variable className="size-5" aria-hidden /> {t('variables.emptyReadOnly')}
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[38%] pl-4">{t('variables.key')}</TableHead>
              <TableHead>{t('variables.value')}</TableHead>
              <TableHead className="w-10 pr-4">
                <span className="sr-only">{t('variables.actions')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {Object.entries(env.variables).map(([k, v]) => (
              <TableRow key={k}>
                <TableCell className="pl-4 font-mono text-xs font-medium break-all">{k}</TableCell>
                <TableCell className="font-mono text-xs break-all text-muted-foreground">{v || <span className="italic">{t('variables.emptyValue')}</span>}</TableCell>
                <TableCell className="py-0 pr-4 text-right">
                  <CopyRefButton text={`{{env.${k}}}`} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  )
}

function VariablesEditor({ projectKey, env, onDirtyChange }: { projectKey: string; env: Environment; onDirtyChange: (d: boolean) => void }) {
  const { t } = useTranslation(['environments', 'common'])
  const { update } = useEnvironmentMutations(projectKey)
  const [rows, setRows] = React.useState<Row[]>(() => toRows(env.variables))
  const [base, setBase] = React.useState(() => serverSignature(env.variables))
  // signature yang baru saja tersimpan, menunggu refetch environment selesai
  const [savedSig, setSavedSig] = React.useState<string | null>(null)
  const [errors, setErrors] = React.useState<Record<string, string>>({})
  const listRef = React.useRef<HTMLDivElement>(null)
  const saveRef = React.useRef<HTMLButtonElement>(null)
  useRefocusAfterPending(update.isPending, saveRef)
  const focusId = React.useRef<string | null>(null)

  // Data server berubah (setelah simpan, atau diubah orang lain): ambil versi server
  // hanya bila draft belum disentuh, supaya ketikan user tidak tertimpa.
  const incoming = serverSignature(env.variables)
  if (incoming !== base) {
    setBase(incoming)
    setSavedSig(null)
    if (signature(rows) === base) setRows(toRows(env.variables))
  }

  const current = signature(rows)
  const dirty = current !== base && current !== savedSig
  React.useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange])
  React.useEffect(() => () => onDirtyChange(false), [onDirtyChange])

  React.useEffect(() => {
    if (!focusId.current) return
    const el = listRef.current?.querySelector<HTMLInputElement>(`[data-row="${focusId.current}"][data-field="key"]`)
    el?.focus()
    focusId.current = null
  })

  const patch = (id: string, field: 'key' | 'value', v: string) => {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [field]: v } : r)))
    if (errors[id]) setErrors((e) => ({ ...e, [id]: '' }))
    if (update.isError) update.reset()
  }

  const addRow = () => {
    const id = uid('v')
    focusId.current = id
    setRows((rs) => [...rs, { id, key: '', value: '' }])
  }

  const removeRow = (id: string) => {
    const idx = rows.findIndex((r) => r.id === id)
    setRows((rs) => rs.filter((r) => r.id !== id))
    // fokus pindah ke baris sebelahnya agar keyboard user tidak kehilangan posisi
    const neighbour = rows[idx + 1] ?? rows[idx - 1]
    focusId.current = neighbour?.id ?? null
  }

  const discard = () => {
    setRows(toRows(env.variables))
    setErrors({})
  }

  const save = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || update.isPending) return
    const kept = rows.filter((r) => r.key.trim() || r.value)
    const errs: Record<string, string> = {}
    const seen = new Map<string, string>()
    for (const r of kept) {
      const k = r.key.trim()
      if (!k) errs[r.id] = t('variables.keyRequired')
      else if (!VAR_KEY_RE.test(k)) errs[r.id] = t('variables.keyFormat')
      else if (seen.has(k)) errs[r.id] = t('variables.keyDuplicate', { key: k })
      seen.set(k, r.id)
    }
    setErrors(errs)
    const firstBad = kept.find((r) => errs[r.id])
    if (firstBad) {
      listRef.current?.querySelector<HTMLInputElement>(`[data-row="${firstBad.id}"][data-field="key"]`)?.focus()
      return
    }
    const variables = Object.fromEntries(kept.map((r) => [r.key.trim(), r.value]))
    update.mutate(
      { id: env.id, variables },
      {
        onSuccess: () => {
          const next = kept.map((r) => ({ ...r, key: r.key.trim() }))
          setRows(next)
          setSavedSig(signature(next))
          toast.success(t('variables.saved', { name: env.name }))
        },
      },
    )
  }

  const server = fieldErrorsOf(update.error)

  return (
    <form onSubmit={save} noValidate>
      {rows.length > 0 && (
        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem] gap-2 border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground sm:grid" aria-hidden>
          <span>{t('variables.key')}</span>
          <span>{t('variables.value')}</span>
          <span />
        </div>
      )}
      <div ref={listRef} role="list" aria-label={t('variables.listLabel')} className="divide-y divide-border">
        {rows.map((r, i) => {
          const err = errors[r.id]
          const label = r.key.trim() || t('variables.rowFallback', { index: String(i + 1) })
          return (
            <div key={r.id} role="listitem" className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-1.5 px-4 py-2 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_4.5rem]">
              <div className="min-w-0">
                <Input
                  data-row={r.id}
                  data-field="key"
                  aria-label={t('variables.keyAria', { index: String(i + 1) })}
                  aria-invalid={err ? true : undefined}
                  aria-describedby={err ? `${r.id}-error` : undefined}
                  value={r.key}
                  placeholder="BASE_URL"
                  onChange={(e) => patch(r.id, 'key', e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                {err && (
                  <p id={`${r.id}-error`} className="mt-1 text-xs text-destructive">
                    {err}
                  </p>
                )}
              </div>
              <Input
                aria-label={t('variables.valueAria', { label })}
                value={r.value}
                placeholder="https://staging.tokoku.id"
                onChange={(e) => patch(r.id, 'value', e.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="col-start-1 row-start-2 font-mono text-xs sm:col-start-auto sm:row-start-auto"
              />
              <div className="col-start-2 row-span-2 row-start-1 flex items-start justify-end gap-0.5 pt-0.5 sm:col-start-3 sm:row-span-1">
                {r.key.trim() && VAR_KEY_RE.test(r.key.trim()) ? <CopyRefButton text={`{{env.${r.key.trim()}}}`} /> : <span className="size-7" />}
                <Tip label={t('variables.removeRow')}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('variables.removeAria', { label })}
                    onClick={() => removeRow(r.id)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 />
                  </Button>
                </Tip>
              </div>
            </div>
          )
        })}
      </div>
      {rows.length === 0 && (
        <p className="flex items-center gap-2 px-4 py-5 text-sm text-muted-foreground">
          <Variable className="size-5" aria-hidden /> <Trans t={t} i18nKey="variables.emptyEditor" components={{ code: <code className="font-mono text-xs" /> }} />
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={addRow}>
          <Plus /> {t('variables.add')}
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <span id={`${env.id}-vars-hint`} className="text-xs text-muted-foreground">
            {dirty ? t('variables.unsaved') : t('common:states.noChanges')}
          </span>
          {dirty && (
            <Button type="button" variant="outline" size="sm" onClick={discard} disabled={update.isPending}>
              {t('variables.discard')}
            </Button>
          )}
          {/* tetap ter-mount agar fokus tidak hilang setelah simpan; aria-disabled saat bersih (§6) */}
          <Button ref={saveRef} type="submit" size="sm" loading={update.isPending} aria-disabled={!dirty || undefined} aria-describedby={`${env.id}-vars-hint`}>
            {t('variables.save')}
          </Button>
        </div>
      </div>
      {update.isError && (
        <div className="px-4 pb-3">
          <FormAlert error={update.error} />
          {Object.keys(server).length > 0 && (
            <ul className="mt-1 text-xs text-destructive">
              {Object.entries(server).map(([p, m]) => (
                <li key={p}>
                  <code className="font-mono">{p}</code>: {m}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </form>
  )
}

/* ------------------------------------------------------------------ secrets */

type SecretDialogState = { kind: 'set'; name?: string } | { kind: 'delete'; name: string } | null

export function SecretsSection({ projectKey, env, allEnvs, canManage }: {
  projectKey: string
  env: Environment
  allEnvs: Environment[]
  canManage: boolean
}) {
  const { t } = useTranslation('environments')
  const [dialog, setDialog] = React.useState<SecretDialogState>(null)
  const [lastName, setLastName] = React.useState<string | undefined>(undefined)

  // Secret yang ada di environment lain tapi belum diisi di sini → tampil "Belum diisi" agar paritas terlihat.
  const rows = React.useMemo(() => {
    const own = new Map(env.secrets.map((s) => [s.name, s]))
    const missing = new Map<string, string[]>()
    for (const other of allEnvs) {
      if (other.id === env.id) continue
      for (const s of other.secrets) if (!own.has(s.name)) missing.set(s.name, [...(missing.get(s.name) ?? []), other.name])
    }
    return [
      ...env.secrets.map((s) => ({ name: s.name, updated_at: s.updated_at as string | null, elsewhere: [] as string[] })),
      ...[...missing.entries()].map(([name, envs]) => ({ name, updated_at: null, elsewhere: envs })),
    ].sort((a, b) => a.name.localeCompare(b.name))
  }, [env, allEnvs])

  const openSet = (name?: string) => {
    setLastName(name)
    setDialog({ kind: 'set', name })
  }

  return (
    <section aria-labelledby="secrets-title" className="rounded-md border border-border bg-card">
      <SectionHeader
        id="secrets-title"
        title={t('secrets.title')}
        count={env.secrets.length}
        description={<Trans t={t} i18nKey="secrets.description" values={{ ref: '{{secret.KEY}}' }} components={{ code: <code className="font-mono" /> }} />}
        action={
          canManage && (
            <Button size="sm" variant="outline" onClick={() => openSet(undefined)}>
              <Plus /> {t('secrets.add')}
            </Button>
          )
        }
      />
      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-4 py-6">
          <KeyRound className="size-5 text-muted-foreground" aria-hidden />
          <p className="text-sm text-muted-foreground">{t('secrets.empty')}</p>
          {canManage && (
            <Button size="sm" onClick={() => openSet(undefined)}>
              <Plus /> {t('secrets.addSecret')}
            </Button>
          )}
        </div>
      ) : (
        <ul className="divide-y divide-border" aria-label={t('secrets.listLabel')}>
          {rows.map((s) => (
            <li key={s.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 sm:min-h-11 sm:flex-nowrap">
              <span className="min-w-0 flex-1 basis-full font-mono text-xs font-medium break-all sm:basis-auto">{s.name}</span>
              <span className="min-w-0 flex-1 text-xs">
                {s.updated_at ? (
                  <span className="text-foreground">
                    {t('secrets.set')}
                    <span className="text-muted-foreground">
                      <Trans
                        t={t}
                        i18nKey="secrets.updated"
                        values={{ time: relativeTime(s.updated_at, formatRelative) }}
                        components={{ time: <time dateTime={s.updated_at} title={formatDateTime(s.updated_at)} /> }}
                      />
                    </span>
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-status-blocked">
                    <CircleDashed className="size-3.5" aria-hidden />
                    {t('secrets.notSet')}
                    <span className="text-muted-foreground">{t('secrets.elsewhere', { envs: s.elsewhere.join(', ') })}</span>
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <CopyRefButton text={`{{secret.${s.name}}}`} />
                {canManage && (
                  <>
                    <Button size="sm" variant="outline" className="min-w-[5.75rem]" onClick={() => openSet(s.name)} aria-label={s.updated_at ? t('secrets.replaceAria', { name: s.name }) : t('secrets.fillAria', { name: s.name })}>
                      {s.updated_at ? t('secrets.replace') : t('secrets.fill')}
                    </Button>
                    {s.updated_at ? (
                      <Tip label={t('secrets.delete')}>
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={t('secrets.deleteAria', { name: s.name })}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setDialog({ kind: 'delete', name: s.name })}
                        >
                          <Trash2 />
                        </Button>
                      </Tip>
                    ) : (
                      <span className="size-7" aria-hidden />
                    )}
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canManage && (
        <>
          <SecretDialog
            projectKey={projectKey}
            env={env}
            name={dialog?.kind === 'set' ? dialog.name : lastName}
            open={dialog?.kind === 'set'}
            onOpenChange={(o) => !o && setDialog(null)}
          />
          {dialog?.kind === 'delete' && (
            <DeleteSecretDialog projectKey={projectKey} env={env} name={dialog.name} open onOpenChange={(o) => !o && setDialog(null)} />
          )}
        </>
      )}
    </section>
  )
}

export function SecretCountHint({ env, className }: { env: Environment; className?: string }) {
  const { t } = useTranslation('environments')
  const v = Object.keys(env.variables).length
  return (
    <span className={cn('tabular text-xs text-muted-foreground', className)}>
      {t('counts.variables', { count: v })} · {t('counts.secrets', { count: env.secrets.length })}
    </span>
  )
}
