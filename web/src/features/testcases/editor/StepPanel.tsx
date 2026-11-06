import { ChevronRight, CircleAlert, Ellipsis, MousePointerClick, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceCategory, FieldError, Step, StepStatus } from '@/api/types'
import { DeviceIcon } from '@/components/devices'
import { StatusBadge } from '@/components/status'
import { Checkbox } from '@/components/ui/checkbox'
import { DropdownMenu, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { i18n } from '@/i18n'
import { DEVICE_CATEGORIES, categoryLabel, onlyOnLabel } from '@/lib/devices'
import { SECTION_HELP, SECTION_LABELS, getAction, type ParamDef, type ParamSection } from '@/lib/steps'
import { cn } from '@/lib/utils'
import { actionIcon, setStepField } from '../lib'
import { KeyValueEditor } from './KeyValueEditor'
import { StepMenuContent } from './StepList'
import { VarField } from './VarField'

const MONO_TYPES = new Set(['selector', 'url', 'textarea', 'number', 'int-list', 'text'])

export interface StepPanelProps {
  step: Step
  index: number
  total: number
  readOnly: boolean
  errors: FieldError[]
  warnings: FieldError[]
  runStatus?: StepStatus
  onChange: (next: Step) => void
  onDuplicate: () => void
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
  onDelete: () => void
  /** Esc di dalam panel → kembali ke baris step. */
  onEscape: () => void
  className?: string
  /** dipakai di Sheet: header tanpa border kartu */
  bare?: boolean
}

export const StepPanel = React.forwardRef<HTMLElement, StepPanelProps>(function StepPanel(
  { step, index, total, readOnly, errors, warnings, runStatus, onChange, onDuplicate, onToggle, onMove, onDelete, onEscape, className, bare },
  ref,
) {
  const def = getAction(step.action)
  const Icon = actionIcon(step.action)
  const manual = step.action === 'manual'
  const rootRef = React.useRef<HTMLElement | null>(null)
  const fieldErr = (name: string) => errors.filter((e) => e.path.endsWith(`].${name}`))
  const general = errors.filter((e) => /\]\.(action|id)$/.test(e.path) || /^steps\[\d+\]$/.test(e.path))
  const set = (name: string, value: unknown) => onChange(setStepField(step, name, value))
  const fid = (name: string) => `step-${step.id}-${name}`

  const advancedSet = step.timeout_ms !== undefined || step.continue_on_failure || step.screenshot || step.only_on !== undefined || fieldErr('only_on').length > 0
  const [advOpen, setAdvOpen] = React.useState(!!advancedSet)
  const { t } = useTranslation('testcases')

  const title = manual ? t('panel.manualStepN', { n: String(index + 1) }) : t('stepList.stepN', { n: String(index + 1) })

  return (
    <section
      ref={(el) => {
        rootRef.current = el
        if (typeof ref === 'function') ref(el)
        else if (ref) ref.current = el
      }}
      aria-label={`${title}${manual ? '' : ` · ${step.action}`}`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape' || e.defaultPrevented) return
        if (!rootRef.current?.contains(e.target as Node)) return
        e.preventDefault()
        onEscape()
      }}
      className={cn('flex min-h-0 flex-col', !bare && 'rounded-md border border-border bg-card', className)}
    >
      <header className={cn('flex h-11 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4', bare && 'pr-12')}>
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <h2 className="min-w-0 truncate text-sm font-semibold">
          {title}
          {!manual && (
            <>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span className="font-mono text-xs font-normal text-muted-foreground">{step.action}</span>
            </>
          )}
        </h2>
        {step.enabled === false && <span className="rounded-sm bg-secondary px-1.5 text-xs text-muted-foreground">{t('stepList.disabledBadge')}</span>}
        <span className="ml-auto flex items-center gap-2">
          {runStatus && runStatus !== 'pending' && <StatusBadge status={runStatus} className="hidden sm:inline-flex" />}
          {!readOnly && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={t('panel.actionsFor', { title })}
                  className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <Ellipsis className="size-4" />
                </button>
              </DropdownMenuTrigger>
              <StepMenuContent step={step} isFirst={index === 0} isLast={index === total - 1} onDuplicate={onDuplicate} onToggle={onToggle} onMove={onMove} onDelete={onDelete} />
            </DropdownMenu>
          )}
        </span>
      </header>

      <div className="relative flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
        {!manual && <p className="-mt-1 text-xs text-muted-foreground">{def?.description}</p>}
        {general.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md bg-status-failed-bg px-3 py-2 text-xs text-status-failed" role="alert">
            {general.map((e) => (
              <li key={e.path + e.message} className="flex gap-1.5">
                <CircleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {e.message}
              </li>
            ))}
          </ul>
        )}
        {warnings.length > 0 && (
          <ul className="flex flex-col gap-1 rounded-md bg-status-blocked-bg px-3 py-2 text-xs text-status-blocked">
            {warnings.map((w) => (
              <li key={w.path + w.message} className="flex gap-1.5">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {w.message}
              </li>
            ))}
          </ul>
        )}

        {readOnly ? (
          <ReadOnlyStep step={step} />
        ) : manual ? (
          <>
            <Field id={fid('description')} label={t('panel.instruction')} errors={fieldErr('description')} help={t('panel.instructionHelp', { example: '{{env.BASE_URL}}' })}>
              {(a) => <VarField {...a} multiline rows={4} value={step.description ?? ''} onValueChange={(v) => set('description', v)} placeholder={t('panel.instructionPlaceholder')} />}
            </Field>
            <Field id={fid('expected')} label={t('panel.expected')} optional errors={[]}>
              {(a) => <VarField {...a} multiline rows={3} value={step.expected ?? ''} onValueChange={(v) => set('expected', v)} placeholder={t('panel.expectedPlaceholder')} />}
            </Field>
            <OnlyOnField id={fid('only_on')} value={step.only_on} errors={fieldErr('only_on')} onChange={(v) => set('only_on', v)} />
          </>
        ) : (
          <>
            {groupParams(def?.params ?? []).map((g) =>
              g.section ? (
                <ParamSectionBlock key={`section-${g.section}`} section={g.section} id={fid(`section-${g.section}`)} params={g.params} step={step} hasErrors={g.params.some((p) => fieldErr(p.name).length > 0)}>
                  {g.params.map((p) => (
                    <ParamField key={p.name} param={p} step={step} id={fid(p.name)} errors={fieldErr(p.name)} onSet={set} />
                  ))}
                </ParamSectionBlock>
              ) : (
                g.params.map((p) => <ParamField key={p.name} param={p} step={step} id={fid(p.name)} errors={fieldErr(p.name)} onSet={set} />)
              ),
            )}
            <div className="flex flex-col gap-4 border-t border-border pt-4">
              <Field id={fid('description')} label={t('panel.description')} optional errors={[]} help={t('panel.descriptionHelp')}>
                {(a) => <VarField {...a} value={step.description ?? ''} onValueChange={(v) => set('description', v)} />}
              </Field>
              <Field id={fid('expected')} label={t('panel.expected')} optional errors={[]}>
                {(a) => <VarField {...a} value={step.expected ?? ''} onValueChange={(v) => set('expected', v)} />}
              </Field>
            </div>
            <div className="flex flex-col gap-3">
              <button
                type="button"
                aria-expanded={advOpen}
                aria-controls={fid('advanced')}
                onClick={() => setAdvOpen((o) => !o)}
                className="-ml-1 flex h-7 items-center gap-1 self-start rounded-md px-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
              >
                <ChevronRight className={cn('size-4 transition-transform duration-150', advOpen && 'rotate-90')} aria-hidden />
                {t('panel.advanced')}
                {!advOpen && advancedSet && <span className="text-xs font-normal">· {t('panel.advancedSet')}</span>}
              </button>
              {advOpen && (
                <div id={fid('advanced')} className="flex flex-col gap-3 pl-5">
                  <Field id={fid('timeout_ms')} label={t('panel.timeout')} optional errors={fieldErr('timeout_ms')} help={t('panel.timeoutHelp')}>
                    {(a) => (
                      <Input
                        {...a}
                        type="number"
                        inputMode="numeric"
                        min={0}
                        className="w-40 font-mono text-[12px]"
                        placeholder="10000"
                        value={step.timeout_ms ?? ''}
                        onChange={(e) => set('timeout_ms', e.target.value === '' ? undefined : Number(e.target.value))}
                      />
                    )}
                  </Field>
                  <CheckField id={fid('continue_on_failure')} label={t('panel.continueOnFailure')} help={t('panel.continueOnFailureHelp')} checked={!!step.continue_on_failure} onChange={(v) => set('continue_on_failure', v || undefined)} />
                  <CheckField id={fid('screenshot')} label={t('panel.alwaysScreenshot')} help={t('panel.alwaysScreenshotHelp')} checked={!!step.screenshot} onChange={(v) => set('screenshot', v || undefined)} />
                  <OnlyOnField id={fid('only_on')} value={step.only_on} errors={fieldErr('only_on')} onChange={(v) => set('only_on', v)} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  )
})

type FieldA11y = { id: string; 'aria-invalid'?: boolean; 'aria-describedby'?: string }

function Field({
  id,
  label,
  optional,
  errors,
  help,
  children,
}: {
  id: string
  label: string
  optional?: boolean
  errors: FieldError[]
  help?: string
  children: (a: FieldA11y) => React.ReactNode
}) {
  const describedBy = [errors.length ? `${id}-err` : null, help ? `${id}-help` : null].filter(Boolean).join(' ') || undefined
  const { t } = useTranslation('testcases')
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="flex items-baseline gap-1.5">
        {label}
        {optional && <span className="text-xs font-normal text-muted-foreground">{t('panel.optional')}</span>}
      </Label>
      {children({ id, 'aria-invalid': errors.length ? true : undefined, 'aria-describedby': describedBy })}
      {errors.length > 0 && (
        <p id={`${id}-err`} className="flex items-center gap-1 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden /> {errors.map((e) => e.message).join(' · ')}
        </p>
      )}
      {help && (
        <p id={`${id}-help`} className="text-xs text-muted-foreground">
          {help}
        </p>
      )}
    </div>
  )
}

function CheckField({ id, label, help, checked, onChange }: { id: string; label: string; help?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-start gap-2">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" aria-describedby={help ? `${id}-help` : undefined} />
      <div className="flex flex-col gap-0.5">
        <Label htmlFor={id} className="font-normal">
          {label}
        </Label>
        {help && (
          <p id={`${id}-help`} className="text-xs text-muted-foreground">
            {help}
          </p>
        )}
      </div>
    </div>
  )
}

/**
 * Common step field `only_on` (docs/14): run the step only on these device categories; none ticked = the
 * field is removed (every device). Order follows desktop → tablet → mobile.
 */
function OnlyOnField({ id, value, errors, onChange }: { id: string; value: Step['only_on']; errors: FieldError[]; onChange: (v: DeviceCategory[] | undefined) => void }) {
  const { t } = useTranslation(['devices', 'testcases'])
  const selected = new Set(value ?? [])
  const toggle = (c: DeviceCategory, on: boolean) => {
    const next = DEVICE_CATEGORIES.filter((x) => (x === c ? on : selected.has(x)))
    onChange(next.length ? next : undefined)
  }
  const helpId = `${id}-help`
  const errId = `${id}-err`
  return (
    <fieldset className="flex flex-col gap-1.5" aria-describedby={[errors.length ? errId : null, helpId].filter(Boolean).join(' ')} aria-invalid={errors.length ? true : undefined}>
      <legend className="mb-1.5 flex items-baseline gap-1.5 text-sm font-medium">
        {t('devices:onlyOn.label')}
        <span className="text-xs font-normal text-muted-foreground">{onlyOnLabel(value) ?? t('devices:onlyOn.all')}</span>
      </legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {DEVICE_CATEGORIES.map((c) => (
          <div key={c} className="flex items-center gap-2">
            <Checkbox id={`${id}-${c}`} checked={selected.has(c)} onCheckedChange={(v) => toggle(c, v === true)} />
            <Label htmlFor={`${id}-${c}`} className="flex items-center gap-1.5 font-normal">
              <DeviceIcon category={c} className="text-muted-foreground" />
              {categoryLabel(c)}
            </Label>
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <p id={errId} className="flex items-center gap-1 text-xs text-destructive">
          <CircleAlert className="size-3.5 shrink-0" aria-hidden /> {errors.map((e) => e.message).join(' · ')}
        </p>
      )}
      <p id={helpId} className="text-xs text-muted-foreground">
        {t('devices:onlyOn.help')}
      </p>
    </fieldset>
  )
}

/** Param berurutan dengan `section` yang sama dikelompokkan; sisanya tetap satu per satu. */
function groupParams(params: ParamDef[]): { section?: ParamSection; params: ParamDef[] }[] {
  const out: { section?: ParamSection; params: ParamDef[] }[] = []
  for (const p of params) {
    const last = out.at(-1)
    if (p.section && last?.section === p.section) last.params.push(p)
    else out.push({ section: p.section, params: [p] })
  }
  return out
}

/** Section param yang bisa dilipat (mis. Polling); terbuka bila ada nilai atau error di dalamnya. */
function ParamSectionBlock({
  section,
  id,
  params,
  step,
  hasErrors,
  children,
}: {
  section: ParamSection
  id: string
  params: ParamDef[]
  step: Step
  hasErrors: boolean
  children: React.ReactNode
}) {
  const { t } = useTranslation('testcases')
  const isSet = params.some((p) => (step as unknown as Record<string, unknown>)[p.name] !== undefined)
  const [open, setOpen] = React.useState(isSet)
  const shown = open || hasErrors
  return (
    <div className="flex flex-col gap-3">
      <button
        type="button"
        aria-expanded={shown}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="-ml-1 flex h-7 items-center gap-1 self-start rounded-md px-1 text-sm font-medium text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ChevronRight className={cn('size-4 transition-transform duration-150', shown && 'rotate-90')} aria-hidden />
        {SECTION_LABELS[section]}
        {!shown && isSet && <span className="text-xs font-normal">· {t('panel.advancedSet')}</span>}
      </button>
      {shown && (
        <div id={id} role="group" aria-label={SECTION_LABELS[section]} className="flex flex-col gap-4 pl-5">
          <p className="-mt-1 text-xs text-muted-foreground">{SECTION_HELP[section]}</p>
          {children}
        </div>
      )}
    </div>
  )
}

function ParamField({ param, step, id, errors, onSet }: { param: ParamDef; step: Step; id: string; errors: FieldError[]; onSet: (name: string, v: unknown) => void }) {
  const raw = (step as unknown as Record<string, unknown>)[param.name]
  const mono = MONO_TYPES.has(param.type)
  const { t } = useTranslation('testcases')
  const help = param.type === 'selector' ? param.help ?? t('panel.selectorHelp') : param.help
  switch (param.type) {
    case 'boolean':
      return <CheckField id={id} label={param.label} help={help} checked={raw === true} onChange={(v) => onSet(param.name, v || undefined)} />
    case 'select':
      return (
        <Field id={id} label={param.label} optional={!param.required} errors={errors} help={help}>
          {(a) => (
            <Select value={raw === undefined ? undefined : String(raw)} onValueChange={(v) => onSet(param.name, v)}>
              <SelectTrigger {...a} className="w-full">
                <SelectValue placeholder={t('panel.selectPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {param.options?.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label === o.value ? <span className="font-mono text-[12px]">{o.label}</span> : <>{o.label} <span className="ml-1 font-mono text-xs text-muted-foreground">{o.value}</span></>}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </Field>
      )
    case 'keyvalue':
      return (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 flex items-baseline gap-1.5 text-sm font-medium">
            {param.label}
            {!param.required && <span className="text-xs font-normal text-muted-foreground">{t('panel.optional')}</span>}
          </legend>
          <KeyValueEditor
            idPrefix={id}
            value={raw as Record<string, string> | undefined}
            onChange={(v) => onSet(param.name, v)}
            keyLabel={param.name === 'save' || param.name === 'save_regex' ? t('panel.kv.variableName') : t('panel.kv.name')}
            valueLabel={param.name === 'save' ? 'JSONPath' : param.name === 'save_regex' ? 'Regex' : t('panel.kv.value')}
            keyPlaceholder={param.name === 'save' ? 'token' : param.name === 'save_regex' ? 'otp' : param.name === 'headers' ? 'Authorization' : 'page'}
            valuePlaceholder={param.name === 'save' ? '$.data.token' : param.name === 'save_regex' ? 'code: (\\d{6})' : param.name === 'headers' ? 'Bearer {{vars.token}}' : '1'}
            addLabel={param.name === 'headers' ? t('panel.kv.addHeader') : param.name === 'query' ? t('panel.kv.addParam') : t('panel.kv.addVariable')}
          />
          {help && <p className="text-xs text-muted-foreground">{help}</p>}
        </fieldset>
      )
    case 'number':
      return (
        <Field id={id} label={param.label} optional={!param.required} errors={errors} help={help}>
          {(a) => (
            <Input
              {...a}
              type="number"
              inputMode="numeric"
              className="w-40 font-mono text-[12px]"
              placeholder={example(param.placeholder)}
              value={raw === undefined ? '' : String(raw)}
              onChange={(e) => onSet(param.name, e.target.value === '' ? undefined : Number(e.target.value))}
            />
          )}
        </Field>
      )
    case 'int-list':
      return (
        <Field id={id} label={param.label} optional={!param.required} errors={errors} help={help ?? t('panel.intListHelp')}>
          {(a) => (
            <Input
              {...a}
              className="font-mono text-[12px]"
              value={Array.isArray(raw) ? raw.join(', ') : ''}
              onChange={(e) => {
                const list = e.target.value
                  .split(',')
                  .map((x) => Number(x.trim()))
                  .filter((n) => Number.isFinite(n) && n > 0)
                onSet(param.name, list.length ? list : undefined)
              }}
            />
          )}
        </Field>
      )
    default:
      return (
        <Field id={id} label={param.label} optional={!param.required} errors={errors} help={help}>
          {(a) => (
            <VarField
              {...a}
              mono={mono}
              multiline={param.type === 'textarea'}
              rows={param.type === 'textarea' ? 6 : undefined}
              placeholder={example(param.placeholder)}
              value={raw === undefined ? '' : String(raw)}
              onValueChange={(v) => onSet(param.name, v)}
            />
          )}
        </Field>
      )
  }
}

function ReadOnlyStep({ step }: { step: Step }) {
  const def = getAction(step.action)
  const { t } = useTranslation(['testcases', 'devices'])
  const rows: { label: string; value: React.ReactNode; mono?: boolean }[] = []
  if (step.action === 'manual') {
    rows.push({ label: t('panel.instruction'), value: step.description || '—' })
    rows.push({ label: t('panel.expected'), value: step.expected || '—' })
  } else {
    for (const p of def?.params ?? []) {
      const v = (step as unknown as Record<string, unknown>)[p.name]
      if (v === undefined) continue
      rows.push({
        label: p.label,
        mono: true,
        value:
          typeof v === 'object' ? (
            <span className="flex flex-col">
              {Object.entries(v as Record<string, string>).map(([k, x]) => (
                <span key={k}>
                  {k}: {x}
                </span>
              ))}
            </span>
          ) : typeof v === 'boolean' ? (
            v ? t('panel.yes') : t('panel.no')
          ) : (
            String(v)
          ),
      })
    }
    if (step.description) rows.push({ label: t('panel.description'), value: step.description })
    if (step.expected) rows.push({ label: t('panel.expected'), value: step.expected })
    if (step.timeout_ms !== undefined) rows.push({ label: t('panel.timeoutShort'), value: `${step.timeout_ms} ms`, mono: true })
    if (step.continue_on_failure) rows.push({ label: t('panel.continueOnFailureShort'), value: t('panel.yes') })
    if (step.screenshot) rows.push({ label: t('panel.screenshot'), value: t('panel.always') })
  }
  const onlyOn = onlyOnLabel(step.only_on)
  if (onlyOn) rows.push({ label: t('devices:onlyOn.label'), value: onlyOn })
  return (
    <dl className="grid grid-cols-[7rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-sm">
      {rows.map((r) => (
        <React.Fragment key={r.label}>
          <dt className="text-muted-foreground">{r.label}</dt>
          <dd className={cn('break-words whitespace-pre-wrap', r.mono && 'font-mono text-[12px] leading-5')}>{r.value}</dd>
        </React.Fragment>
      ))}
    </dl>
  )
}

export function EmptyPanel({ hasSteps, readOnly }: { hasSteps: boolean; readOnly: boolean }) {
  const { t } = useTranslation('testcases')
  return (
    <div className="flex flex-col items-start gap-2 rounded-md border border-dashed border-border px-4 py-6">
      <MousePointerClick className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{hasSteps ? t('panel.empty.pickTitle') : readOnly ? t('editor.empty.title') : t('panel.empty.addTitle')}</p>
      <p className="text-sm text-muted-foreground">
        {hasSteps ? t('panel.empty.pickHint') : readOnly ? t('panel.empty.readOnlyHint') : t('panel.empty.addHint')}
      </p>
    </div>
  )
}


/** Placeholder katalog ditandai sebagai contoh agar tidak terbaca seperti nilai yang sudah terisi. */
function example(p: string | undefined) {
  return p ? i18n.t('testcases:panel.example', { value: p }) : undefined
}
