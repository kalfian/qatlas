import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { useUpdateProject } from '@/api/queries'
import type { Project, RunOptions } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { FieldHint, SaveBar, SettingsCard } from './SettingsCard'
import { fieldErrorsOf, invalidProps } from './shared'

/* ------------------------------------------------------------------ default run */

/** Nilai bawaan sistem (docs/06-runner.md §Opsi run). */
const SYSTEM_DEFAULTS: RunOptions = {
  browser: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 720 },
  screenshot: 'on_failure',
  video: 'off',
  step_timeout_ms: 10000,
  retries: 0,
}

// Sama dengan preset di RunDialog agar pilihan konsisten.
const VIEWPORTS = {
  desktop: { width: 1280, height: 720, label: 'Desktop 1280×720' },
  laptop: { width: 1440, height: 900, label: 'Laptop 1440×900' },
  mobile: { width: 390, height: 844, label: 'Mobile 390×844' },
} as const
type Preset = keyof typeof VIEWPORTS | 'custom'
const presetOf = (v: { width: number; height: number }): Preset =>
  (Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).find((k) => VIEWPORTS[k].width === v.width && VIEWPORTS[k].height === v.height) ?? 'custom'

/** Input angka disimpan sebagai string agar user bisa mengosongkan field saat mengetik. */
interface Draft extends Omit<RunOptions, 'viewport' | 'step_timeout_ms'> {
  width: string
  height: string
  timeout: string
}

const toDraft = (o: RunOptions): Draft => ({
  browser: o.browser,
  headless: o.headless,
  screenshot: o.screenshot,
  video: o.video,
  retries: o.retries,
  width: String(o.viewport.width),
  height: String(o.viewport.height),
  timeout: String(o.step_timeout_ms),
})

function intIn(raw: string, min: number, max: number, label: string, t: TFunction<'settings'>): string | undefined {
  if (!raw.trim()) return t('validation.required', { label })
  const n = Number(raw)
  if (!Number.isInteger(n)) return t('validation.integer', { label })
  if (n < min || n > max) return t('validation.range', { label, min, max })
  return undefined
}

export function RunDefaultsSection({ project }: { project: Project }) {
  const { t } = useTranslation('settings')
  const update = useUpdateProject(project.key)
  const saved = { ...SYSTEM_DEFAULTS, ...project.default_run_options }
  const [draft, setDraft] = React.useState<Draft>(() => toDraft(saved))
  const [preset, setPreset] = React.useState<Preset>(() => presetOf(saved.viewport))
  const formRef = React.useRef<HTMLFormElement>(null)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const errors = {
    width: intIn(draft.width, 320, 3840, t('runDefaults.width'), t),
    height: intIn(draft.height, 320, 2160, t('runDefaults.height'), t),
    timeout: intIn(draft.timeout, 1000, 600000, t('runDefaults.timeoutLabel'), t),
  }
  const server = fieldErrorsOf(update.error)
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(saved))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || update.isPending) return
    const firstBad = (['width', 'height', 'timeout'] as const).find((k) => errors[k])
    if (firstBad) {
      if (firstBad !== 'timeout' && preset !== 'custom') setPreset('custom')
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>(`#run-def-${firstBad}`)?.focus())
      return
    }
    const opts: RunOptions = {
      browser: draft.browser,
      headless: draft.headless,
      screenshot: draft.screenshot,
      video: draft.video,
      retries: draft.retries,
      viewport: { width: Number(draft.width), height: Number(draft.height) },
      step_timeout_ms: Number(draft.timeout),
    }
    update.mutate(
      { default_run_options: opts },
      { onSuccess: () => toast.success(t('runDefaults.saved')) },
    )
  }

  const timeoutSeconds = Number(draft.timeout) / 1000

  return (
    <form ref={formRef} onSubmit={submit} noValidate>
      <SettingsCard
        id="settings-run-defaults"
        title={t('runDefaults.title')}
        description={t('runDefaults.description')}
        bodyClassName="grid gap-5"
        footer={
          <>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="order-first"
              onClick={() => {
                setDraft(toDraft(SYSTEM_DEFAULTS))
                setPreset(presetOf(SYSTEM_DEFAULTS.viewport))
              }}
            >
              {t('runDefaults.useSystem')}
            </Button>
            <SaveBar id="run-defaults" dirty={dirty} pending={update.isPending} error={update.isError ? update.error : undefined} />
          </>
        }
      >
        <Field label={t('runDefaults.browser')} labelId="run-def-browser-label">
          <Segmented
            ariaLabel={t('runDefaults.browser')}
            value={draft.browser}
            onChange={(v) => set('browser', v)}
            options={[
              { value: 'chromium', label: 'Chromium' },
              { value: 'firefox', label: 'Firefox' },
              { value: 'webkit', label: 'WebKit' },
            ]}
            className="w-full sm:w-auto sm:justify-self-start"
          />
        </Field>

        <div className="grid gap-1.5">
          <Label htmlFor="run-def-viewport">{t('runDefaults.viewport')}</Label>
          <div className="flex flex-wrap gap-2">
            <Select
              value={preset}
              onValueChange={(v) => {
                const p = v as Preset
                setPreset(p)
                if (p !== 'custom') setDraft((d) => ({ ...d, width: String(VIEWPORTS[p].width), height: String(VIEWPORTS[p].height) }))
              }}
            >
              <SelectTrigger id="run-def-viewport" className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {VIEWPORTS[k].label}
                  </SelectItem>
                ))}
                <SelectItem value="custom">{t('runDefaults.custom')}</SelectItem>
              </SelectContent>
            </Select>
            {preset === 'custom' && (
              <div className="flex items-center gap-1.5">
                <Input
                  {...invalidProps('run-def-width', errors.width)}
                  aria-label={t('runDefaults.widthAria')}
                  inputMode="numeric"
                  className="w-20 font-mono"
                  value={draft.width}
                  onChange={(e) => set('width', e.target.value.replace(/\D/g, ''))}
                />
                <span className="text-muted-foreground" aria-hidden>
                  ×
                </span>
                <Input
                  {...invalidProps('run-def-height', errors.height)}
                  aria-label={t('runDefaults.heightAria')}
                  inputMode="numeric"
                  className="w-20 font-mono"
                  value={draft.height}
                  onChange={(e) => set('height', e.target.value.replace(/\D/g, ''))}
                />
                <span className="text-xs text-muted-foreground">px</span>
              </div>
            )}
          </div>
          {preset === 'custom' && (
            <>
              <FieldHint id="run-def-width" error={errors.width} />
              <FieldHint id="run-def-height" error={errors.height} />
            </>
          )}
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label={t('runDefaults.screenshot')} labelId="run-def-screenshot-label">
            <Segmented
              ariaLabel={t('runDefaults.screenshot')}
              value={draft.screenshot}
              onChange={(v) => set('screenshot', v)}
              options={[
                { value: 'off', label: t('runDefaults.off') },
                { value: 'on_failure', label: t('runDefaults.onFailure') },
                { value: 'every_step', label: t('runDefaults.everyStep') },
              ]}
              className="w-full"
            />
          </Field>
          <Field
            label={t('runDefaults.video')}
            labelId="run-def-video-label"
            hint={draft.video === 'on_failure' ? t('runDefaults.videoHint') : undefined}
          >
            <Segmented
              ariaLabel={t('runDefaults.video')}
              value={draft.video}
              onChange={(v) => set('video', v)}
              options={[
                { value: 'off', label: t('runDefaults.off') },
                { value: 'on_failure', label: t('runDefaults.onFailure') },
                { value: 'always', label: t('runDefaults.always') },
              ]}
              className="w-full"
            />
          </Field>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <div className="grid content-start gap-1.5">
            <Label htmlFor="run-def-timeout">{t('runDefaults.timeout')}</Label>
            <div className="flex items-center gap-2">
              <Input
                {...invalidProps('run-def-timeout', errors.timeout ?? server['default_run_options.step_timeout_ms'], 'run-def-timeout-hint')}
                inputMode="numeric"
                className="w-32 font-mono"
                value={draft.timeout}
                onChange={(e) => set('timeout', e.target.value.replace(/\D/g, ''))}
              />
              <span className="text-xs text-muted-foreground">ms</span>
            </div>
            <FieldHint id="run-def-timeout" error={errors.timeout ?? server['default_run_options.step_timeout_ms']}>
              {t('runDefaults.timeoutHint', { count: timeoutSeconds })}
            </FieldHint>
          </div>
          <Field label={t('runDefaults.retries')} labelId="run-def-retries-label" hint={t('runDefaults.retriesHint')}>
            <Segmented
              ariaLabel={t('runDefaults.retries')}
              value={String(draft.retries)}
              onChange={(v) => set('retries', Number(v))}
              options={[
                { value: '0', label: '0' },
                { value: '1', label: '1' },
                { value: '2', label: '2' },
              ]}
              className="w-40 justify-self-start"
            />
          </Field>
        </div>

        <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
          <div>
            <Label htmlFor="run-def-headless">{t('runDefaults.headless')}</Label>
            <p id="run-def-headless-hint" className="mt-1 text-xs text-muted-foreground">
              {t('runDefaults.headlessHint')}
            </p>
          </div>
          <Switch id="run-def-headless" aria-describedby="run-def-headless-hint" checked={draft.headless} onCheckedChange={(v) => set('headless', v)} />
        </div>
      </SettingsCard>
    </form>
  )
}

/** Label visual untuk kontrol grup (Segmented sudah punya aria-label sendiri). */
function Field({ label, labelId, hint, children }: { label: string; labelId: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="grid content-start gap-1.5">
      <span id={labelId} className="text-sm font-medium leading-none">
        {label}
      </span>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

/* ------------------------------------------------------------------ retention */

export function RetentionSection({ project }: { project: Project }) {
  const { t } = useTranslation('settings')
  const update = useUpdateProject(project.key)
  const [days, setDays] = React.useState(String(project.artifact_retention_days))
  const inputRef = React.useRef<HTMLInputElement>(null)
  const error = intIn(days, 1, 365, t('retention.label'), t) ?? fieldErrorsOf(update.error).artifact_retention_days
  const dirty = days !== String(project.artifact_retention_days)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || update.isPending) return
    if (error) return inputRef.current?.focus()
    update.mutate(
      { artifact_retention_days: Number(days) },
      { onSuccess: (p) => toast.success(t('retention.saved', { count: p.artifact_retention_days })) },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <SettingsCard
        id="settings-retention"
        title={t('retention.title')}
        description={t('retention.description')}
        footer={<SaveBar id="retention" dirty={dirty} pending={update.isPending} error={update.isError ? update.error : undefined} />}
        bodyClassName="grid gap-1.5"
      >
        <Label htmlFor="retention-days">{t('retention.keepFor')}</Label>
        <div className="flex items-center gap-2">
          <Input
            ref={inputRef}
            {...invalidProps('retention-days', error, 'retention-days-hint')}
            inputMode="numeric"
            className="w-24 font-mono"
            value={days}
            onChange={(e) => setDays(e.target.value.replace(/\D/g, ''))}
          />
          <span className="text-sm text-muted-foreground">{t('retention.days')}</span>
        </div>
        <FieldHint id="retention-days" error={error}>
          {t('retention.hint')}
        </FieldHint>
      </SettingsCard>
    </form>
  )
}
