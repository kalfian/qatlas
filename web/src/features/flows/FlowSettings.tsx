import { Braces, ChevronDown, Plus, X } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
  const { t } = useTranslation('flows')
  const sessionHint = draft.shared_session ? t('settings.sharedHint') : t('settings.isolatedHint')
  const stopHint = draft.stop_on_failure ? t('settings.stopHint') : t('settings.noStopHint')

  if (readOnly) {
    return (
      <section aria-label={t('settings.label')} className="rounded-md border border-border">
        <dl className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
          <ReadField label={t('settings.session')} value={draft.shared_session ? t('session.shared') : t('session.isolated')} hint={sessionHint} />
          <ReadField label={t('settings.stopOnFailure')} value={draft.stop_on_failure ? t('list.yes') : t('list.no')} hint={stopHint} />
          <div className="px-4 py-3">
            <dt className="text-xs font-medium text-muted-foreground">{t('settings.variablesCount', { count: varCount })}</dt>
            <dd className="mt-1">
              {varCount === 0 ? (
                <span className="text-sm text-muted-foreground">{t('settings.none')}</span>
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
              <dt className="text-xs font-medium text-muted-foreground">{t('settings.description')}</dt>
              <dd className="mt-1 text-sm whitespace-pre-line">{draft.description || <span className="text-muted-foreground">{t('settings.none')}</span>}</dd>
            </div>
            <div>
              <dt className="text-xs font-medium text-muted-foreground">{t('settings.tags')}</dt>
              <dd className="mt-1 flex flex-wrap gap-1">
                {draft.tags.length ? draft.tags.map((tag) => <TagChip key={tag} tag={tag} />) : <span className="text-sm text-muted-foreground">{t('settings.none')}</span>}
              </dd>
            </div>
          </dl>
        )}
      </section>
    )
  }

  return (
    <section aria-label={t('settings.label')} className="rounded-md border border-border">
      <div className="grid divide-y divide-border md:grid-cols-3 md:divide-x md:divide-y-0">
        <SwitchField
          id="flow-shared"
          label={t('session.shared')}
          hint={sessionHint}
          checked={draft.shared_session}
          onChange={(v) => patch((d) => ({ ...d, shared_session: v }))}
        />
        <SwitchField
          id="flow-stop"
          label={t('settings.stopOnFailure')}
          hint={stopHint}
          checked={draft.stop_on_failure}
          onChange={(v) => patch((d) => ({ ...d, stop_on_failure: v }))}
        />
        <div className="flex flex-col items-start gap-1 px-4 py-3">
          <VariablesPopover variables={draft.variables} errors={variableErrors} patch={patch} count={varCount} errorCount={varErrorCount} />
          <p className="text-xs text-muted-foreground">
            <Trans t={t} i18nKey="settings.variablesHint" values={{ token: `{{vars.${t('settings.tokenName')}}}` }} components={{ code: <code className="font-mono" /> }} />
          </p>
        </div>
      </div>
      <div className="grid gap-4 border-t border-border px-4 py-3 md:grid-cols-3">
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <Label htmlFor="flow-desc" className="text-xs">
            {t('settings.description')}
          </Label>
          <Textarea
            id="flow-desc"
            rows={2}
            className="min-h-0 resize-y"
            value={draft.description}
            onChange={(e) => patch((d) => ({ ...d, description: e.target.value }))}
            placeholder={t('settings.descriptionPlaceholder')}
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
  const { t } = useTranslation('flows')
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
          <Braces /> {t('settings.variablesCount', { count })}
          {errorCount > 0 && <span className="text-destructive">· {t('builder.errorCount', { count: errorCount })}</span>}
          <ChevronDown className="text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" collisionPadding={16} className="w-[min(calc(100vw-2rem),28rem)] p-0" aria-label={t('settings.variablesTitle')}>
        <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
          <h3 className="text-sm font-semibold">{t('settings.variablesTitle')}</h3>
          <span className="text-xs text-muted-foreground">{t('settings.overridesEnv')}</span>
        </div>
        <div className="flex max-h-72 flex-col gap-2 overflow-y-auto p-3">
          {variables.length > 0 && (
            <div className="grid grid-cols-[1fr_1fr_1.75rem] gap-2 text-xs font-medium text-muted-foreground" aria-hidden>
              <span>{t('settings.name')}</span>
              <span>{t('settings.value')}</span>
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
                    aria-label={t('settings.varNameLabel', { n: String(i + 1) })}
                    aria-invalid={!!err || undefined}
                    aria-describedby={err ? `var-err-${v.uid}` : undefined}
                    className="h-7 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Input
                    value={v.value}
                    onChange={(e) => update(v.uid, 'value', e.target.value)}
                    placeholder={t('settings.valuePlaceholder')}
                    aria-label={t('settings.varValueLabel', { name: v.key || String(i + 1) })}
                    className="h-7 font-mono text-xs"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <Button variant="ghost" size="icon-sm" onClick={() => remove(v.uid)} aria-label={t('settings.varRemoveLabel', { name: v.key || String(i + 1) })}>
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
            <Plus /> {t('settings.addVariable')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function TagsField({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [value, setValue] = React.useState('')
  const { t } = useTranslation('flows')
  const commit = () => {
    const parts = value
      .split(',')
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, '-'))
      .filter((x) => x && !tags.includes(x))
    if (parts.length) onChange([...tags, ...new Set(parts)])
    setValue('')
  }
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="flow-tags" className="text-xs">
        {t('settings.tags')}
      </Label>
      <div className="flex min-h-8 flex-wrap items-center gap-1 rounded-md border border-input bg-background px-1.5 py-1 focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background">
        {tags.map((tag) => (
          <TagChip key={tag} tag={tag} onRemove={() => onChange(tags.filter((x) => x !== tag))} />
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
        {t('settings.tagsHint')}
      </p>
    </div>
  )
}
