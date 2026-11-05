import { useQueryClient } from '@tanstack/react-query'
import { useBlocker } from '@tanstack/react-router'
import { CircleCheck, CircleX, FileJson, KeyRound, TriangleAlert, Upload, X } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { ApiError, errorMessage } from '@/api/client'
import { qk, useUpdateGoogleAuthSettings } from '@/api/queries'
import type { FieldError, GoogleAuthSettings } from '@/api/types'
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
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Banner } from '@/features/auth/shared'
import { SettingsCard } from '@/features/settings/SettingsCard'
import { useRefocusAfterPending } from '@/features/settings/shared'
import { cn } from '@/lib/utils'
import {
  checkClientJson,
  configSignature,
  draftFromSettings,
  isDirty,
  mapServerDetails,
  MAX_CLIENT_JSON_BYTES,
  normalizeDomain,
  sameUri,
  shortClientId,
  splitClientId,
  splitDomains,
  toInput,
  validateDomain,
  validateDraft,
  type ClientJsonError,
  type GoogleDraft,
} from './google-auth-form'

export const ENV_NOTE_ID = 'google-env-note'
export const CREDENTIALS_ID = 'google-credentials'
/** Tombol "Pilih file JSON" — target fokus untuk error kredensial dan setelah Google sign-in dihapus. */
export const CHOOSE_ID = 'google-json-choose'
const FILE_INPUT_ID = 'google-json-input'
const DOMAINS_ID = 'google-domains'
const ENABLED_ID = 'google-enabled'

type FileProblem = { name: string; code: ClientJsonError | 'readFailed' | 'multiple' }

export function GoogleSignInForm({ settings, readOnly }: { settings: GoogleAuthSettings; readOnly: boolean }) {
  const { t } = useTranslation(['googleAuth', 'common'])
  const qc = useQueryClient()
  const update = useUpdateGoogleAuthSettings()

  const [draft, setDraft] = React.useState<GoogleDraft>(() => draftFromSettings(settings))
  const [base, setBase] = React.useState(settings)
  const [submitted, setSubmitted] = React.useState(false)
  const [fileProblem, setFileProblem] = React.useState<FileProblem | null>(null)
  const [serverCreds, setServerCreds] = React.useState<string>()
  /** Error 422 per domain, dikunci nilai domain (indeks bergeser saat chip dihapus). */
  const [serverDomains, setServerDomains] = React.useState<Record<string, string>>({})
  const [serverDomainsField, setServerDomainsField] = React.useState<string>()
  const [serverOther, setServerOther] = React.useState<FieldError[]>([])
  const [domainText, setDomainText] = React.useState('')
  const [domainError, setDomainError] = React.useState<string>()
  const [dragging, setDragging] = React.useState(false)
  const [live, setLive] = React.useState('')

  const saveRef = React.useRef<HTMLButtonElement>(null)
  const fileRef = React.useRef<HTMLInputElement>(null)
  const stagedRef = React.useRef<HTMLDivElement>(null)
  const domainRef = React.useRef<HTMLInputElement>(null)
  useRefocusAfterPending(update.isPending, saveRef)

  // Konfigurasi tersimpan berubah dari luar (admin lain, env, hapus): ikuti bila belum ada edit lokal.
  if (configSignature(settings) !== configSignature(base)) {
    setBase(settings)
    if (!isDirty(draft, base)) setDraft(draftFromSettings(settings))
  }

  const view = readOnly ? draftFromSettings(settings) : draft
  const secretSet = settings.client_secret_set
  const pendingDomain = !readOnly && domainText.trim() !== ''
  const dirty = !readOnly && (isDirty(draft, settings) || pendingDomain)
  const clientErrors = readOnly ? {} : validateDraft(draft, settings)
  const announce = (msg: string) => setLive((prev) => (prev === msg ? `${msg}\u00a0` : msg))

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

  const resetErrorsAfterEdit = () => {
    if (update.isError) update.reset()
  }

  /* ---------------- credentials file */
  const fileProblemText = (p: FileProblem): string => {
    const name = p.name
    switch (p.code) {
      case 'multiple':
        return t('form.errors.multiple')
      case 'readFailed':
        return t('form.errors.readFailed', { name })
      default:
        return t(`form.errors.${p.code}`, { name })
    }
  }

  const credentialsError: string | undefined = fileProblem
    ? fileProblemText(fileProblem)
    : (serverCreds ?? (submitted && clientErrors.credentials ? t('form.errors.credentialsRequired') : undefined))

  const focusLater = (fn: () => void) => requestAnimationFrame(() => requestAnimationFrame(fn))

  const readFiles = (files: File[]) => {
    if (readOnly || files.length === 0) return
    if (files.length > 1) return setFileProblem({ name: '', code: 'multiple' })
    const file = files[0]
    if (file.size > MAX_CLIENT_JSON_BYTES) return setFileProblem({ name: file.name, code: 'tooLarge' })
    const reader = new FileReader()
    reader.onload = () => {
      const text = typeof reader.result === 'string' ? reader.result : ''
      const result = checkClientJson(text)
      if (!result.ok) {
        setFileProblem({ name: file.name, code: result.error })
        return
      }
      setFileProblem(null)
      setServerCreds(undefined)
      resetErrorsAfterEdit()
      setDraft((d) => ({ ...d, file: { name: file.name, text, info: result.info } }))
      focusLater(() => stagedRef.current?.focus())
    }
    reader.onerror = () => setFileProblem({ name: file.name, code: 'readFailed' })
    reader.readAsText(file)
  }

  const chooseFile = () => {
    if (readOnly) return
    fileRef.current?.click()
  }

  const removeFile = () => {
    setDraft((d) => ({ ...d, file: null }))
    setServerCreds(undefined)
    setFileProblem(null)
    focusLater(() => document.getElementById(CHOOSE_ID)?.focus())
  }

  const startReplace = () => {
    if (readOnly) return
    setDraft((d) => ({ ...d, replacing: true }))
    focusLater(() => document.getElementById(CHOOSE_ID)?.focus())
  }

  const keepCurrent = () => {
    setDraft((d) => ({ ...d, replacing: false, file: null }))
    setFileProblem(null)
    setServerCreds(undefined)
    focusLater(() => document.getElementById('google-replace')?.focus())
  }

  /* ---------------- domains */
  const domainErrorText = (raw: string, code: 'email' | 'invalid') =>
    code === 'email' ? t('form.domainErrors.email', { domain: normalizeDomain(raw.split('@').pop() ?? '') || 'tokoku.id' }) : t('form.domainErrors.invalid', { value: raw })

  /** Tambahkan domain valid dari teks; sisa yang tidak valid tetap di input dengan pesan error. */
  const commitDomains = (raw: string): { ok: boolean; domains: string[] } => {
    const parts = splitDomains(raw)
    const next = [...draft.domains]
    const rejected: string[] = []
    let firstError: string | undefined
    for (const p of parts) {
      const code = validateDomain(p)
      if (code) {
        rejected.push(p)
        firstError ??= domainErrorText(p, code)
        continue
      }
      const d = normalizeDomain(p)
      if (!next.includes(d)) next.push(d)
    }
    const added = next.slice(draft.domains.length)
    if (added.length) {
      setDraft((d) => ({ ...d, domains: next }))
      resetErrorsAfterEdit()
      setServerDomainsField(undefined)
      announce(added.map((d) => t('form.domainAdded', { domain: d })).join('. '))
    }
    setDomainText(rejected.join(', '))
    setDomainError(firstError)
    return { ok: rejected.length === 0, domains: next }
  }

  const removeDomain = (domain: string) => {
    setDraft((d) => ({ ...d, domains: d.domains.filter((x) => x !== domain) }))
    setServerDomains((s) => {
      const next = { ...s }
      delete next[domain]
      return next
    })
    setServerDomainsField(undefined)
    resetErrorsAfterEdit()
    announce(t('form.domainRemoved', { domain }))
    domainRef.current?.focus()
  }

  /* ---------------- submit */
  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (readOnly || update.isPending) return
    let domains = draft.domains
    if (domainText.trim()) {
      const r = commitDomains(domainText)
      if (!r.ok) return domainRef.current?.focus()
      domains = r.domains
    }
    const next = { ...draft, domains }
    if (!isDirty(next, settings)) return
    setSubmitted(true)
    if (clientErrors.credentials) {
      document.getElementById(CHOOSE_ID)?.focus()
      return
    }
    const input = toInput(next)
    update.mutate(input, {
      onSuccess: (saved) => {
        setDraft(draftFromSettings(saved))
        setSubmitted(false)
        setServerCreds(undefined)
        setServerDomains({})
        setServerDomainsField(undefined)
        setServerOther([])
        setFileProblem(null)
        toast.success(saved.enabled ? t('save.savedOn') : t('save.savedOff'))
      },
      onError: (err) => {
        if (!(err instanceof ApiError)) return
        if (err.status === 409) {
          void qc.invalidateQueries({ queryKey: qk.adminGoogleAuth })
          return
        }
        if (err.status !== 422) return
        const mapped = mapServerDetails(err.details)
        setServerCreds(mapped.credentials)
        const byDomain: Record<string, string> = {}
        for (const [i, msg] of Object.entries(mapped.domains)) {
          const d = input.allowed_domains?.[Number(i)]
          if (d) byDomain[d] = msg
        }
        setServerDomains(byDomain)
        setServerDomainsField(mapped.domainsField)
        setServerOther(mapped.other)
        focusLater(() => {
          if (mapped.credentials) (stagedRef.current ?? document.getElementById(CHOOSE_ID))?.focus()
          else if (Object.keys(byDomain).length || mapped.domainsField) domainRef.current?.focus()
        })
      },
    })
  }

  /* ---------------- render */
  const readOnlyDescribed = readOnly ? ENV_NOTE_ID : undefined
  const saveError = update.isError && !(update.error instanceof ApiError && update.error.status === 409) ? update.error : null
  const blockedLocally = submitted && !!clientErrors.credentials
  const footerHint = readOnly
    ? t('save.readOnly')
    : saveError
      ? saveError instanceof ApiError && saveError.status === 422
        ? t('save.invalid')
        : t('save.failed', { message: errorMessage(saveError) })
      : blockedLocally
        ? t('save.invalid')
        : dirty
          ? t('save.unsaved')
          : t('save.noChanges')
  const footerAlert = !!saveError || blockedLocally

  const showStored = readOnly || (secretSet && !view.replacing && !view.file)
  const showZone = !readOnly && !view.file && (!secretSet || view.replacing)
  const domainChipErrors = Object.entries(serverDomains).filter(([d]) => view.domains.includes(d))
  const domainsInvalid = !!domainError || domainChipErrors.length > 0 || !!serverDomainsField
  const domainsDescribedBy =
    [domainError ? `${DOMAINS_ID}-error` : null, domainChipErrors.length || serverDomainsField ? `${DOMAINS_ID}-server` : null, `${DOMAINS_ID}-hint`, `${DOMAINS_ID}-keys`]
      .filter(Boolean)
      .join(' ')

  return (
    <form onSubmit={submit} noValidate autoComplete="off">
      <SettingsCard
        id="google-config"
        title={t('form.title')}
        description={t('form.description')}
        bodyClassName="grid gap-5"
        footer={
          <>
            <p id="google-save-hint" className={cn('mr-auto text-xs', footerAlert ? 'text-destructive' : 'text-muted-foreground')} role={footerAlert ? 'alert' : undefined}>
              {dirty && !footerAlert && <span className="mr-1.5 inline-block size-1.5 rounded-full bg-status-blocked align-middle" aria-hidden />}
              {footerHint}
            </p>
            <Button ref={saveRef} type="submit" size="sm" loading={update.isPending} aria-disabled={!dirty || undefined} aria-describedby="google-save-hint">
              {t('save.button')}
            </Button>
          </>
        }
      >
        {/* ---------------- credentials */}
        <section id={CREDENTIALS_ID} aria-labelledby="google-credentials-title" className="grid min-w-0 scroll-mt-16 gap-2">
          <div>
            <h3 id="google-credentials-title" className="text-sm font-semibold">
              {t('form.credentials')}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">{t('form.credentialsHint')}</p>
          </div>

          {!readOnly && (
            <input
              ref={fileRef}
              id={FILE_INPUT_ID}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              tabIndex={-1}
              aria-label={t('form.fileLabel')}
              onChange={(e) => {
                readFiles(Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          )}

          {showStored && (
            <div className="flex min-h-10 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-md border border-border px-3 py-1.5">
              <span id="google-credentials-status" className="inline-flex min-w-0 items-start gap-1.5 text-sm">
                <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0" data-testid="google-credentials-status">
                  {readOnly ? t('form.credentialsEnv') : t('form.credentialsSet')}
                  {settings.client_id && (
                    <span className="text-muted-foreground">
                      <Trans
                        t={t}
                        i18nKey="form.clientIdShort"
                        values={{ id: shortClientId(settings.client_id) }}
                        components={{ mono: <code className="font-mono text-xs" title={settings.client_id} /> }}
                      />
                    </span>
                  )}
                </span>
              </span>
              {!readOnly && (
                <Button id="google-replace" type="button" size="sm" variant="outline" onClick={startReplace} aria-describedby="google-credentials-status">
                  <Upload aria-hidden />
                  {t('form.replace')}
                </Button>
              )}
            </div>
          )}

          {showZone && (
            <div
              onDragEnter={(e) => {
                e.preventDefault()
                setDragging(true)
              }}
              onDragOver={(e) => {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragging(false)
                readFiles(Array.from(e.dataTransfer.files))
              }}
              className={cn(
                'grid gap-2 rounded-md border border-dashed px-4 py-4 transition-colors duration-150 motion-reduce:transition-none',
                dragging ? 'border-ring bg-muted' : credentialsError ? 'border-destructive' : 'border-input',
              )}
              data-testid="google-dropzone"
            >
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button
                  id={CHOOSE_ID}
                  type="button"
                  variant="outline"
                  onClick={chooseFile}
                  className="max-sm:w-full"
                  aria-invalid={credentialsError ? true : undefined}
                  aria-describedby={[credentialsError ? 'google-credentials-error' : null, 'google-drop-hint'].filter(Boolean).join(' ')}
                >
                  <FileJson aria-hidden />
                  {t('form.choose')}
                </Button>
                <span className={cn('text-sm max-sm:hidden', dragging ? 'text-foreground' : 'text-muted-foreground')}>
                  {dragging ? t('form.dropRelease') : t('form.drop')}
                </span>
                {view.replacing && (
                  <Button type="button" variant="link" size="sm" className="text-xs sm:ml-auto" onClick={keepCurrent}>
                    {t('form.keep')}
                  </Button>
                )}
              </div>
              <p id="google-drop-hint" className="text-xs text-muted-foreground">
                {t('form.dropHint')}
              </p>
            </div>
          )}

          {view.file && (
            <StagedFile
              ref={stagedRef}
              draft={view}
              settings={settings}
              error={!!credentialsError}
              onChoose={chooseFile}
              onRemove={removeFile}
              onKeep={view.replacing ? keepCurrent : undefined}
            />
          )}

          {credentialsError && (
            <p id="google-credentials-error" role="alert" className="flex items-start gap-1 text-xs text-status-failed">
              <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="break-words">{credentialsError}</span>
            </p>
          )}
          {showStored && !readOnly && <p className="text-xs text-muted-foreground">{t('form.secretNeverShown')}</p>}
        </section>

        {/* ---------------- options */}
        <section aria-labelledby="google-options-title" className="grid min-w-0 gap-4 border-t border-border pt-4">
          <h3 id="google-options-title" className="text-sm font-semibold">
            {t('form.options')}
          </h3>

          <div className="flex items-start justify-between gap-4 rounded-md border border-border px-3 py-2.5">
            <div>
              <Label htmlFor={ENABLED_ID}>{t('form.enabled')}</Label>
              <p id={`${ENABLED_ID}-hint`} className="mt-1 text-xs text-muted-foreground">
                {t('form.enabledHint')}
              </p>
            </div>
            <Switch
              id={ENABLED_ID}
              checked={view.enabled}
              onCheckedChange={(v) => {
                setDraft((d) => ({ ...d, enabled: v }))
                resetErrorsAfterEdit()
              }}
              disabled={readOnly}
              aria-describedby={[`${ENABLED_ID}-hint`, readOnlyDescribed].filter(Boolean).join(' ')}
            />
          </div>

          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor={readOnly ? undefined : DOMAINS_ID} id={`${DOMAINS_ID}-label`}>
              {t('form.domains')} <span className="font-normal text-muted-foreground">({t('form.optional')})</span>
            </Label>
            {readOnly ? (
              view.domains.length ? (
                <ul aria-labelledby={`${DOMAINS_ID}-label`} className="flex flex-wrap gap-1" data-testid="google-domains">
                  {view.domains.map((d) => (
                    <li key={d}>
                      <DomainChip domain={d} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground">{t('form.domainsAny')}</p>
              )
            ) : (
              <div
                className={cn(
                  'flex min-h-8 cursor-text flex-wrap items-center gap-1 rounded-md border bg-background px-1 py-[3px] transition-colors focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-1 focus-within:ring-offset-background',
                  domainsInvalid ? 'border-destructive' : 'border-input',
                )}
                onMouseDown={(e) => {
                  // Klik di area kosong field → fokus input (chip dan tombolnya tetap bekerja normal).
                  if (e.target === e.currentTarget) {
                    e.preventDefault()
                    domainRef.current?.focus()
                  }
                }}
              >
                {view.domains.length > 0 && (
                  <ul aria-label={t('form.domainsLabel')} className="flex flex-wrap gap-1" data-testid="google-domains">
                    {view.domains.map((d) => (
                      <li key={d}>
                        <DomainChip domain={d} invalid={!!serverDomains[d]} onRemove={() => removeDomain(d)} removeLabel={t('form.removeDomain', { domain: d })} />
                      </li>
                    ))}
                  </ul>
                )}
                <input
                  ref={domainRef}
                  id={DOMAINS_ID}
                  value={domainText}
                  onChange={(e) => {
                    setDomainText(e.target.value)
                    if (domainError) setDomainError(undefined)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',' || e.key === ';' || (e.key === ' ' && domainText.trim())) {
                      e.preventDefault()
                      if (domainText.trim()) commitDomains(domainText)
                    } else if (e.key === 'Backspace' && !domainText && view.domains.length) {
                      removeDomain(view.domains[view.domains.length - 1])
                    }
                  }}
                  onPaste={(e) => {
                    const text = e.clipboardData.getData('text')
                    if (/[\s,;]/.test(text.trim())) {
                      e.preventDefault()
                      commitDomains(`${domainText} ${text}`)
                    }
                  }}
                  onBlur={() => domainText.trim() && commitDomains(domainText)}
                  placeholder={view.domains.length ? '' : t('form.domainsPlaceholder')}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  inputMode="url"
                  aria-invalid={domainsInvalid || undefined}
                  aria-describedby={domainsDescribedBy}
                  className="h-6 min-w-32 flex-1 bg-transparent px-1.5 font-mono text-[13px] outline-none placeholder:font-sans placeholder:text-muted-foreground"
                />
              </div>
            )}
            {domainError && (
              <p id={`${DOMAINS_ID}-error`} className="flex items-start gap-1 text-xs text-status-failed">
                <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden />
                <span>{domainError}</span>
              </p>
            )}
            {(domainChipErrors.length > 0 || serverDomainsField) && (
              <ul id={`${DOMAINS_ID}-server`} className="grid gap-0.5 text-xs text-status-failed">
                {serverDomainsField && (
                  <li className="flex items-start gap-1">
                    <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>{serverDomainsField}</span>
                  </li>
                )}
                {domainChipErrors.map(([d, msg]) => (
                  <li key={d} className="flex items-start gap-1">
                    <CircleX className="mt-0.5 size-3 shrink-0" aria-hidden />
                    <span>
                      <code className="font-mono">{d}</code>: {msg}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <p id={`${DOMAINS_ID}-hint`} className="text-xs text-muted-foreground">
                {t('form.domainsHint')}
              </p>
            )}
            <p id={`${DOMAINS_ID}-keys`} className="sr-only">
              {t('form.domainsKeys')}
            </p>
          </div>
        </section>

        {serverOther.length > 0 && (
          <Banner>
            <ul className="grid gap-0.5">
              {serverOther.map((d, i) => (
                <li key={i}>
                  <code className="font-mono text-xs">{d.path}</code>: {d.message}
                </li>
              ))}
            </ul>
          </Banner>
        )}
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

/* ------------------------------------------------------------------ parts */

/** Client ID mono; baris dipatahkan sebelum `.apps.googleusercontent.com`, bukan di tengah kata. */
export function ClientIdText({ id, className, ...props }: { id: string; className?: string } & React.HTMLAttributes<HTMLElement>) {
  const [head, tail] = splitClientId(id)
  return (
    <code className={cn('font-mono text-xs leading-5 [overflow-wrap:anywhere]', className)} {...props}>
      {head}
      {tail && (
        <>
          <wbr />
          {tail}
        </>
      )}
    </code>
  )
}

function DomainChip({ domain, invalid, onRemove, removeLabel }: { domain: string; invalid?: boolean; onRemove?: () => void; removeLabel?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-6 items-center rounded-sm font-mono text-xs',
        onRemove ? 'pl-1.5' : 'px-1.5',
        invalid ? 'bg-status-failed-bg text-status-failed ring-1 ring-status-failed ring-inset' : 'bg-secondary text-secondary-foreground',
      )}
    >
      {domain}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="ml-0.5 flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors duration-150 hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="size-3" aria-hidden />
        </button>
      )}
    </span>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** File yang sudah lolos pre-check: isi yang aman ditampilkan (tanpa secret) + apakah redirect URI QAtlas terdaftar. */
const StagedFile = React.forwardRef<
  HTMLDivElement,
  { draft: GoogleDraft; settings: GoogleAuthSettings; error: boolean; onChoose: () => void; onRemove: () => void; onKeep?: () => void }
>(({ draft, settings, error, onChoose, onRemove, onKeep }, ref) => {
  const { t } = useTranslation('googleAuth')
  const file = draft.file!
  const { info } = file
  const matched = info.redirectUris.some((u) => sameUri(u, settings.redirect_uri))
  const replaces = settings.client_id && settings.client_id !== info.clientId ? settings.client_id : null
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="group"
      aria-label={`${t('form.staged.title')}: ${file.name}`}
      className={cn('min-w-0 rounded-md border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring', error ? 'border-destructive' : 'border-border')}
      data-testid="google-staged"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-3 py-2">
        <span className="flex min-w-48 flex-1 items-center gap-1.5">
          <FileJson className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate font-mono text-xs" title={file.name}>
            {file.name}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">· {t('form.staged.title')}</span>
        </span>
        <span className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onChoose}>
            {t('form.staged.chooseAnother')}
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={onRemove}>
            {t('form.staged.remove')}
          </Button>
        </span>
      </div>
      <dl className="grid gap-2 px-3 py-2.5 text-sm">
        <Row label={t('form.staged.clientId')}>
          <ClientIdText id={info.clientId} data-testid="google-staged-client-id" />
        </Row>
        <Row label={t('form.staged.project')}>
          {info.projectId ? <code className="font-mono text-xs leading-5">{info.projectId}</code> : <span className="text-muted-foreground">{t('status.notSet')}</span>}
        </Row>
        <Row label={t('form.staged.redirectUris')}>
          {info.redirectUris.length ? (
            <ul className="grid gap-1">
              {info.redirectUris.map((u) => {
                const match = sameUri(u, settings.redirect_uri)
                return (
                  <li key={u} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <code className="min-w-0 font-mono text-xs leading-5 break-all">{u}</code>
                    {match && (
                      <span className="inline-flex items-center gap-1 text-xs text-status-passed">
                        <CircleCheck className="size-3" aria-hidden />
                        {t('form.staged.matches')}
                      </span>
                    )}
                  </li>
                )
              })}
            </ul>
          ) : (
            <span className="text-muted-foreground">{t('form.staged.noRedirectUris')}</span>
          )}
        </Row>
      </dl>
      {!matched && (
        <p className="flex items-start gap-1.5 border-t border-border bg-status-blocked-bg px-3 py-2 text-xs text-foreground" data-testid="google-staged-redirect-missing">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-blocked" aria-hidden />
          <span>{t('form.staged.missing')}</span>
        </p>
      )}
      {(replaces || onKeep) && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-3 py-2 text-xs text-muted-foreground">
          {replaces ? (
            <span>
              <Trans t={t} i18nKey="form.staged.replacesClient" values={{ id: shortClientId(replaces) }} components={{ mono: <code className="font-mono" title={replaces} /> }} />
            </span>
          ) : (
            <span />
          )}
          {onKeep && (
            <Button type="button" variant="link" size="sm" className="text-xs" onClick={onKeep}>
              {t('form.keep')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
})
StagedFile.displayName = 'StagedFile'
