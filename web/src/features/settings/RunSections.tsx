import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { useUpdateProject } from '@/api/queries'
import type { Device, Project, RunOptions, RunOptionsInput } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { DevicePicker } from '@/features/runs/DevicePicker'
import { DEFAULT_DEVICE, deviceIdentity, devicesOf, sortDevices, toDeviceInput } from '@/lib/devices'
import { FieldHint, SaveBar, SettingsCard } from './SettingsCard'
import { fieldErrorsOf, invalidProps } from './shared'

/* ------------------------------------------------------------------ default run */

/** Nilai bawaan sistem (docs/06-runner.md §Opsi run). */
const SYSTEM_DEFAULTS: RunOptions = {
  browser: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 720 },
  devices: [DEFAULT_DEVICE],
  screenshot: 'on_failure',
  video: 'off',
  step_timeout_ms: 10000,
  retries: 0,
}

/** Input angka disimpan sebagai string agar user bisa mengosongkan field saat mengetik. */
interface Draft extends Omit<RunOptions, 'viewport' | 'devices' | 'step_timeout_ms'> {
  devices: Device[]
  timeout: string
}

const toDraft = (o: RunOptions): Draft => ({
  browser: o.browser,
  headless: o.headless,
  // project saved before devices existed → its viewport maps through the legacy rule
  devices: sortDevices(devicesOf(o)),
  screenshot: o.screenshot,
  video: o.video,
  retries: o.retries,
  timeout: String(o.step_timeout_ms),
})

/** Dirty check on what is saved: device identity + label, not object shape. */
const draftKey = (d: Draft) => JSON.stringify({ ...d, devices: d.devices.map((x) => `${deviceIdentity(x)}|${x.label}`) })

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
  const formRef = React.useRef<HTMLFormElement>(null)

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }))

  const errors = {
    timeout: intIn(draft.timeout, 1000, 600000, t('runDefaults.timeoutLabel'), t),
  }
  const server = fieldErrorsOf(update.error)
  const deviceError = Object.entries(server).find(([path]) => path.startsWith('default_run_options.devices'))?.[1]
  const dirty = draftKey(draft) !== draftKey(toDraft(saved))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || update.isPending) return
    if (errors.timeout) {
      requestAnimationFrame(() => formRef.current?.querySelector<HTMLInputElement>('#run-def-timeout')?.focus())
      return
    }
    const opts: RunOptionsInput = {
      browser: draft.browser,
      headless: draft.headless,
      screenshot: draft.screenshot,
      video: draft.video,
      retries: draft.retries,
      devices: draft.devices.map(toDeviceInput),
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
              onClick={() => setDraft(toDraft(SYSTEM_DEFAULTS))}
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
          <Label id="run-def-devices-label" htmlFor="run-def-devices">{t('runDefaults.devices')}</Label>
          <DevicePicker
            id="run-def-devices"
            labelId="run-def-devices-label"
            value={draft.devices}
            onChange={(devices) => set('devices', devices)}
            browser={draft.browser}
            error={deviceError}
            className="sm:max-w-md"
          />
          <p className="text-xs text-muted-foreground">{t('runDefaults.devicesHint')}</p>
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
