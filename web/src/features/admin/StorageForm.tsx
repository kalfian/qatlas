import { useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { CircleCheck, CircleX, Info, KeyRound, PlugZap } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { qk, useTestStorageSettings, useUpdateStorageSettings } from '@/api/queries'
import type { StorageBackend, StorageCheck, StorageSettings } from '@/api/types'
import { StatusBadge } from '@/components/status'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Switch } from '@/components/ui/switch'
import { Banner, PasswordInput } from '@/features/auth/shared'
import { SettingsCard } from '@/features/settings/SettingsCard'
import { relativeTime, useRefocusAfterPending } from '@/features/settings/shared'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  CHECK_ORDER,
  draftFromSettings,
  firstError,
  inputSignature,
  isDirty,
  mapServerDetails,
  orderedChecks,
  toInput,
  validateDraft,
  type CheckName,
  type DraftField,
  type StorageDraft,
  type ValidationCode,
} from './storage-form'

export const ENV_NOTE_ID = 'storage-env-note'

const FIELD_ID: Record<DraftField, string> = {
  endpoint: 'storage-endpoint',
  region: 'storage-region',
  bucket: 'storage-bucket',
  accessKeyId: 'storage-access-key',
  secret: 'storage-secret',
  prefix: 'storage-prefix',
}

/** Hasil probe yang ditampilkan: dari "Tes koneksi" atau dari 422 saat menyimpan. */
interface ProbeView {
  origin: 'test' | 'save'
  backend: StorageBackend
  ok: boolean
  latencyMs: number | null
  checks: StorageCheck[]
  signature: string
}

function useBackendLabel() {
  const { t } = useTranslation('storage')
  return (b: StorageBackend) => (b === 's3' ? t('backend.s3') : t('backend.local'))
}

export function StorageForm({ settings, readOnly }: { settings: StorageSettings; readOnly: boolean }) {
  const { t } = useTranslation(['storage', 'common'])
  const backendLabel = useBackendLabel()
  const qc = useQueryClient()
  const update = useUpdateStorageSettings()
  const test = useTestStorageSettings()

  const [draft, setDraft] = React.useState<StorageDraft>(() => draftFromSettings(settings))
  const [base, setBase] = React.useState(settings)
  const [touched, setTouched] = React.useState<ReadonlySet<DraftField>>(() => new Set())
  const [submitted, setSubmitted] = React.useState(false)
  const [serverFields, setServerFields] = React.useState<Partial<Record<DraftField, string>>>({})
  const [probe, setProbe] = React.useState<ProbeView | null>(null)
  const [live, setLive] = React.useState('')
  const secretRef = React.useRef<HTMLInputElement>(null)
  const saveRef = React.useRef<HTMLButtonElement>(null)
  const testRef = React.useRef<HTMLButtonElement>(null)
  useRefocusAfterPending(update.isPending, saveRef)
  useRefocusAfterPending(test.isPending, testRef)

  // Konfigurasi tersimpan berubah dari luar (admin lain, env override): ikuti bila belum ada edit lokal.
  if (configSignature(settings) !== configSignature(base)) {
    setBase(settings)
    if (!isDirty(draft, base)) setDraft(draftFromSettings(settings))
  }

  const view = readOnly ? draftFromSettings(settings) : draft
  const secretSet = settings.s3.secret_set
  const dirty = !readOnly && isDirty(draft, settings)
  const clientErrors = readOnly ? {} : validateDraft(draft, secretSet)
  const currentSig = inputSignature(toInput(view, secretSet))

  const errorText = (field: DraftField, code: ValidationCode): string => {
    switch (code) {
      case 'required':
        return {
          endpoint: t('form.errors.endpointRequired'),
          region: t('form.errors.regionRequired'),
          bucket: t('form.errors.bucketRequired'),
          accessKeyId: t('form.errors.accessKeyRequired'),
          secret: t('form.errors.secretRequired'),
          prefix: t('form.errors.required'),
        }[field]
      case 'missingScheme':
        return t('form.errors.missingScheme', { host: draft.endpoint.trim() || 'garage.kalfian.work' })
      case 'invalidUrl':
        return t('form.errors.invalidUrl')
      case 'protocol':
        return t('form.errors.protocol')
      case 'hasPath':
        return t('form.errors.hasPath')
      case 'bucketFormat':
        return t('form.errors.bucketFormat')
      case 'prefixSlash':
        return t('form.errors.prefixSlash')
    }
  }

  /** Error yang tampil: format salah langsung setelah blur; "wajib" baru setelah Tes/Simpan; lalu error server. */
  const shownError = (field: DraftField): string | undefined => {
    const code = clientErrors[field]
    if (code && (submitted || (touched.has(field) && code !== 'required'))) return errorText(field, code)
    return serverFields[field]
  }

  const dropServerError = (field: DraftField) =>
    setServerFields((s) => {
      const next = { ...s }
      delete next[field]
      return next
    })
  const set = <K extends keyof StorageDraft>(key: K, value: StorageDraft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }))
    if (key in FIELD_ID && serverFields[key as DraftField]) dropServerError(key as DraftField)
    if (update.isError) update.reset()
  }
  const touch = (field: DraftField) => setTouched((s) => (s.has(field) ? s : new Set(s).add(field)))

  const focusField = (field: DraftField) => {
    const id = field === 'secret' && secretSet && !draft.replacingSecret ? 'storage-secret-replace' : FIELD_ID[field]
    document.getElementById(id)?.focus()
  }

  const announce = (msg: string) => setLive((prev) => (prev === msg ? `${msg}\u00a0` : msg))

  const checkLabel = (name: CheckName) => t(`test.checks.${name}`)

  /* ---------------- unsaved-changes guard */
  const dirtyRef = React.useRef(dirty)
  React.useLayoutEffect(() => {
    dirtyRef.current = dirty
  }, [dirty])
  const blocker = useBlocker({
    shouldBlockFn: () => dirtyRef.current,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  })

  /* ---------------- actions */
  const runTest = () => {
    if (readOnly || test.isPending) return
    setSubmitted(true)
    const first = firstError(clientErrors)
    if (first) return focusField(first)
    const input = toInput(draft, secretSet)
    const signature = inputSignature(input)
    test.mutate(input, {
      onSuccess: (r) => {
        setProbe({ origin: 'test', backend: input.backend, ok: r.ok, latencyMs: r.latency_ms, checks: r.checks, signature })
        const failed = r.checks.find((c) => !c.ok)
        announce(r.ok ? t('test.announcePassed') : t('test.announceFailed', { check: failed ? checkLabel(failed.name) : r.message }))
      },
    })
  }

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || !dirty || update.isPending) return
    setSubmitted(true)
    const first = firstError(clientErrors)
    if (first) return focusField(first)
    const input = toInput(draft, secretSet)
    const signature = inputSignature(input)
    update.mutate(input, {
      onSuccess: (saved) => {
        setDraft(draftFromSettings(saved))
        setSubmitted(false)
        setTouched(new Set())
        setServerFields({})
        setProbe(null)
        test.reset()
        toast.success(t('save.saved', { backend: backendLabel(saved.active_backend) }))
      },
      onError: (err) => {
        if (!(err instanceof ApiError)) return
        if (err.status === 409) {
          void qc.invalidateQueries({ queryKey: qk.adminStorage })
          return
        }
        if (err.status !== 422) return
        const mapped = mapServerDetails(err.details)
        setServerFields(mapped.fields)
        const failedChecks = Object.keys(mapped.checks) as CheckName[]
        if (failedChecks.length) {
          // 422 hanya membawa cek yang gagal; probe berurutan, jadi cek sebelum yang pertama gagal dianggap lolos.
          const firstFailed = Math.min(...failedChecks.map((n) => CHECK_ORDER.indexOf(n)))
          const checks: StorageCheck[] = CHECK_ORDER.flatMap((name, i): StorageCheck[] => {
            if (mapped.checks[name]) return [{ name, ok: false, message: mapped.checks[name]! }]
            if (i < firstFailed && (input.backend === 's3' || (name !== 'connect' && name !== 'bucket'))) return [{ name, ok: true, message: '' }]
            return []
          })
          setProbe({ origin: 'save', backend: input.backend, ok: false, latencyMs: null, checks, signature })
          announce(t('test.announceFailed', { check: checkLabel(CHECK_ORDER[firstFailed]) }))
        }
        const field = firstError(mapped.fields)
        if (field) requestAnimationFrame(() => focusField(field))
      },
    })
  }

  const startReplace = () => {
    if (readOnly) return
    set('replacingSecret', true)
    requestAnimationFrame(() => secretRef.current?.focus())
  }
  const keepSecret = () => {
    setDraft((d) => ({ ...d, replacingSecret: false, secret: '' }))
    dropServerError('secret')
    requestAnimationFrame(() => document.getElementById('storage-secret-replace')?.focus())
  }

  /* ---------------- render helpers */
  const readOnlyDescribed = readOnly ? ENV_NOTE_ID : undefined
  const describe = (field: DraftField, hint: boolean) =>
    [shownError(field) ? `${FIELD_ID[field]}-error` : null, hint ? `${FIELD_ID[field]}-hint` : null, readOnlyDescribed].filter(Boolean).join(' ') || undefined

  const textInput = (field: Exclude<DraftField, 'secret'>, opts: { hint?: boolean; placeholder?: string; mono?: boolean; autoComplete?: string; inputMode?: 'url' } = {}) => {
    const key = field as 'endpoint' | 'region' | 'bucket' | 'accessKeyId' | 'prefix'
    return (
      <Input
        id={FIELD_ID[field]}
        value={view[key]}
        onChange={(e) => set(key, e.target.value)}
        onBlur={() => touch(field)}
        readOnly={readOnly}
        aria-invalid={shownError(field) ? true : undefined}
        aria-describedby={describe(field, !!opts.hint)}
        placeholder={opts.placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete={opts.autoComplete ?? 'off'}
        inputMode={opts.inputMode}
        className={cn(opts.mono && 'font-mono text-[13px]', readOnly && 'bg-muted')}
      />
    )
  }

  const saveError = update.isError && !(update.error instanceof ApiError && update.error.status === 409) ? update.error : null
  const footerHint = readOnly
    ? t('save.readOnly')
    : saveError
      ? saveError instanceof ApiError && saveError.code !== 'validation_failed' && probe?.origin === 'save'
        ? t('save.probeFailed')
        : t('save.failed', { message: errorMessage(saveError) })
      : dirty
        ? t('save.unsaved')
        : t('save.noChanges')

  return (
    <form onSubmit={submit} noValidate autoComplete="off">
      <SettingsCard
        id="storage-config"
        title={t('form.title')}
        description={t('form.description')}
        bodyClassName="grid gap-5"
        footer={
          <>
            <p id="storage-save-hint" className={cn('mr-auto text-xs', saveError ? 'text-destructive' : 'text-muted-foreground')} role={saveError ? 'alert' : undefined}>
              {dirty && !saveError && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-status-blocked align-middle" aria-hidden />}
              {footerHint}
            </p>
            <Button
              ref={testRef}
              type="button"
              size="sm"
              variant="outline"
              onClick={runTest}
              loading={test.isPending}
              aria-disabled={readOnly || undefined}
              aria-describedby={readOnlyDescribed}
            >
              {!test.isPending && <PlugZap aria-hidden />}
              {t('test.button')}
            </Button>
            <Button ref={saveRef} type="submit" size="sm" loading={update.isPending} aria-disabled={!dirty || undefined} aria-describedby="storage-save-hint">
              {t('save.button')}
            </Button>
          </>
        }
      >
        <div className="grid gap-1.5">
          <span id="storage-backend-label" className="text-sm font-medium leading-none">
            {t('form.backendLabel')}
          </span>
          <Segmented<StorageBackend>
            ariaLabel={t('form.backendLabel')}
            value={view.backend}
            onChange={(v) => set('backend', v)}
            options={[
              { value: 'local', label: t('backend.local') },
              { value: 's3', label: t('backend.s3') },
            ]}
            disabled={readOnly}
            className="w-full sm:w-80"
          />
          <p className="text-xs text-muted-foreground">
            {view.backend === 'local' ? (
              <Trans t={t} i18nKey="form.localHint" components={{ code: <code className="font-mono" /> }} />
            ) : (
              t('form.s3Hint')
            )}
          </p>
          {!readOnly && view.backend !== settings.active_backend && settings.artifacts[settings.active_backend] > 0 && (
            <p className="text-xs text-foreground">{t('form.switchingAway', { from: backendLabel(settings.active_backend) })}</p>
          )}
        </div>

        {view.backend === 's3' && (
          <fieldset className="grid min-w-0 gap-4 border-t border-border pt-4">
            <legend className="sr-only">{t('form.s3Group')}</legend>
            <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
              <Info className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>{t('form.garageHelp')}</span>
            </p>

            <FieldBlock field="endpoint" label={t('form.endpoint')} error={shownError('endpoint')} hint={t('form.endpointHint')}>
              {textInput('endpoint', { hint: true, placeholder: 'https://garage.kalfian.work', mono: true, inputMode: 'url' })}
            </FieldBlock>

            <div className="grid gap-4 sm:grid-cols-2">
              <FieldBlock field="region" label={t('form.region')} error={shownError('region')} hint={t('form.regionHint')}>
                {textInput('region', { hint: true, placeholder: 'us-east-1', mono: true })}
              </FieldBlock>
              <FieldBlock field="bucket" label={t('form.bucket')} error={shownError('bucket')}>
                {textInput('bucket', { placeholder: 'qatlas-artifacts', mono: true })}
              </FieldBlock>
            </div>

            <FieldBlock field="accessKeyId" label={t('form.accessKeyId')} error={shownError('accessKeyId')}>
              {textInput('accessKeyId', { mono: true })}
            </FieldBlock>

            {/* Secret: write-only. Nilai tersimpan tidak pernah dikirim server; tampil/sembunyi hanya untuk yang sedang diketik. */}
            {secretSet && !view.replacingSecret ? (
              <div role="group" aria-labelledby="storage-secret-label" className="grid gap-1.5">
                <span id="storage-secret-label" className="text-sm font-medium leading-none">
                  {t('form.secret')}
                </span>
                <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md border border-border px-3 py-1.5">
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-sm" id="storage-secret-status">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span>
                      {t('form.secretSet')}
                      {settings.s3.secret_updated_at && (
                        <span className="text-muted-foreground">
                          <Trans
                            t={t}
                            i18nKey="form.secretUpdated"
                            values={{ time: relativeTime(settings.s3.secret_updated_at, formatRelative) }}
                            components={{ time: <time dateTime={settings.s3.secret_updated_at} title={formatDateTime(settings.s3.secret_updated_at)} /> }}
                          />
                        </span>
                      )}
                    </span>
                  </span>
                  <Button
                    id="storage-secret-replace"
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={startReplace}
                    aria-disabled={readOnly || undefined}
                    aria-describedby={['storage-secret-status', shownError('secret') ? 'storage-secret-error' : null, readOnlyDescribed].filter(Boolean).join(' ')}
                  >
                    {t('form.replaceSecret')}
                  </Button>
                </div>
                <FieldMessage id="storage-secret" error={shownError('secret')} hint={t('form.secretNeverShown')} />
              </div>
            ) : (
              <div className="grid gap-1.5">
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="storage-secret">{secretSet ? t('form.newSecret') : t('form.secret')}</Label>
                  {secretSet && (
                    <Button type="button" variant="link" size="sm" className="h-auto text-xs" onClick={keepSecret}>
                      {t('form.keepSecret')}
                    </Button>
                  )}
                </div>
                <PasswordInput
                  ref={secretRef}
                  id="storage-secret"
                  value={view.secret}
                  onChange={(e) => set('secret', e.target.value)}
                  onBlur={() => touch('secret')}
                  autoComplete="new-password"
                  spellCheck={false}
                  aria-invalid={shownError('secret') ? true : undefined}
                  aria-describedby={describe('secret', true)}
                  readOnly={readOnly}
                  className={cn('font-mono text-[13px]', readOnly && 'bg-muted')}
                />
                <FieldMessage id="storage-secret" error={shownError('secret')} hint={secretSet ? t('form.secretReplaceHint') : t('form.secretFirstHint')} />
              </div>
            )}

            <FieldBlock
              field="prefix"
              label={
                <>
                  {t('form.prefix')} <span className="font-normal text-muted-foreground">({t('form.optional')})</span>
                </>
              }
              error={shownError('prefix')}
              hint={t('form.prefixHint')}
            >
              {textInput('prefix', { hint: true, mono: true })}
            </FieldBlock>

            <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
              <div>
                <Label htmlFor="storage-path-style">{t('form.pathStyle')}</Label>
                <p id="storage-path-style-hint" className="mt-1 text-xs text-muted-foreground">
                  {t('form.pathStyleHint')}
                </p>
              </div>
              <Switch
                id="storage-path-style"
                checked={view.forcePathStyle}
                onCheckedChange={(v) => set('forcePathStyle', v)}
                disabled={readOnly}
                aria-describedby="storage-path-style-hint"
              />
            </div>
          </fieldset>
        )}

        {test.isError && (
          <Banner>{t('test.requestFailed', { message: errorMessage(test.error) })}</Banner>
        )}
        {probe && <ProbeResults probe={probe} stale={probe.signature !== currentSig} checkLabel={checkLabel} />}
        <p className="sr-only" role="status" aria-live="polite">
          {live}
        </p>
      </SettingsCard>

      <AlertDialog open={blocker.status === 'blocked'} onOpenChange={(o) => !o && blocker.reset?.()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('leave.title')}</AlertDialogTitle>
            <AlertDialogDescription>{t('leave.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.reset?.()}>{t('leave.stay')}</AlertDialogCancel>
            <AlertDialogAction destructive onClick={() => blocker.proceed?.()}>
              {t('leave.discard')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </form>
  )
}

function configSignature(s: StorageSettings): string {
  return JSON.stringify([s.active_backend, s.env_override, s.s3])
}

/** Error menggantikan hint secara visual; hint tetap ada (hidden) agar aria-describedby selalu menunjuk elemen yang ada. */
function FieldMessage({ id, error, hint }: { id: string; error?: string; hint?: React.ReactNode }) {
  return (
    <>
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1 text-xs text-status-failed">
          <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {hint && (
        <p id={`${id}-hint`} hidden={!!error} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </>
  )
}

function FieldBlock({ field, label, error, hint, children }: {
  field: DraftField
  label: React.ReactNode
  error?: string
  hint?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="grid min-w-0 content-start gap-1.5">
      <Label htmlFor={FIELD_ID[field]}>{label}</Label>
      {children}
      <FieldMessage id={FIELD_ID[field]} error={error} hint={hint} />
    </div>
  )
}

function ProbeResults({ probe, stale, checkLabel }: { probe: ProbeView; stale: boolean; checkLabel: (n: CheckName) => string }) {
  const { t } = useTranslation('storage')
  const rows = orderedChecks(probe.checks, probe.backend)
  const firstFailed = probe.checks.find((c) => !c.ok)
  const ms = probe.latencyMs !== null ? formatDuration(probe.latencyMs) : null
  const passedCount = probe.checks.filter((c) => c.ok).length
  return (
    <section aria-labelledby="storage-probe-title" className="rounded-md border border-border" data-testid="storage-probe">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-border px-3 py-2">
        <h3 id="storage-probe-title" className="text-sm font-semibold">
          {probe.origin === 'test' ? t('test.title') : t('test.saveTitle')}
        </h3>
        {probe.ok ? (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-status-passed">
            <CircleCheck className="size-3.5" aria-hidden />
            {t('test.passed', { count: passedCount, ms: ms ?? '' })}
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-status-failed">
            <CircleX className="size-3.5" aria-hidden />
            {t('test.failed', { check: firstFailed ? checkLabel(firstFailed.name) : '' })}
            {ms && <span className="font-normal text-muted-foreground"> · {t('test.failedTotal', { ms })}</span>}
          </span>
        )}
      </header>
      <ul aria-label={t('test.resultsLabel')} className="divide-y divide-border">
        {rows.map(({ name, check }) => (
          <li key={name} className="flex items-start gap-3 px-3 py-2">
            <div className="w-20 shrink-0 pt-px">
              <StatusBadge status={check ? (check.ok ? 'passed' : 'failed') : 'skipped'} />
            </div>
            <div className="min-w-0 flex-1">
              <p className={cn('text-sm', !check && 'text-muted-foreground')}>{checkLabel(name)}</p>
              {check?.message && (
                <p className={cn('mt-0.5 font-mono text-xs break-words', check.ok ? 'text-muted-foreground' : 'text-status-failed')}>{check.message}</p>
              )}
            </div>
          </li>
        ))}
      </ul>
      {(stale || (!probe.ok && probe.origin === 'save')) && (
        <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{stale ? t('test.stale') : t('test.notSaved')}</p>
      )}
    </section>
  )
}
