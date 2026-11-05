import { Check, CircleCheck, CircleMinus, Copy, ExternalLink, Trash2, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useDeleteGoogleAuthSettings, useGoogleAuthSettings } from '@/api/queries'
import type { GoogleAuthSettings } from '@/api/types'
import { useCopy } from '@/components/misc'
import { ErrorState, PageContainer, PageHeader } from '@/components/page'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Banner, Delayed } from '@/features/auth/shared'
import { SettingsCard } from '@/features/settings/SettingsCard'
import { relativeTime } from '@/features/settings/shared'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CHOOSE_ID, ClientIdText, CREDENTIALS_ID, ENV_NOTE_ID, GoogleSignInForm } from './GoogleSignInForm'

const CONSOLE_URL = 'https://console.cloud.google.com/apis/credentials'

export function GoogleSignInPage() {
  const { t } = useTranslation('googleAuth')
  const q = useGoogleAuthSettings()
  return (
    <PageContainer narrow>
      <PageHeader title={t('title')} description={t('description')} />
      {q.isPending ? (
        <GoogleSkeleton />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <>
          {q.data.env_override && (
            <div id={ENV_NOTE_ID}>
              <Banner tone="warning" role="note" title={t('envOverride.title')}>
                {t('envOverride.body')}
              </Banner>
            </div>
          )}
          <StatusSection settings={q.data} />
          <SetupSection settings={q.data} />
          <GoogleSignInForm settings={q.data} readOnly={q.data.env_override} />
          {!q.data.env_override && q.data.source === 'database' && <RemoveSection />}
        </>
      )}
    </PageContainer>
  )
}

/* ------------------------------------------------------------------ status */

function StatusRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-6">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

function StatusSection({ settings: s }: { settings: GoogleAuthSettings }) {
  const { t } = useTranslation('googleAuth')
  const { copied, copy } = useCopy()
  return (
    <SettingsCard id="google-status" title={t('status.title')} bodyClassName="grid gap-4">
      <dl className="grid gap-3 text-sm">
        <StatusRow label={t('status.state')}>
          <span className="inline-flex items-center gap-1.5 font-medium" data-testid="google-state">
            {s.enabled ? (
              <CircleCheck className="size-4 text-status-passed" aria-hidden />
            ) : (
              <CircleMinus className="size-4 text-muted-foreground" aria-hidden />
            )}
            {s.enabled ? t('status.enabled') : t('status.disabled')}
          </span>
        </StatusRow>
        <StatusRow label={t('status.source')}>
          <span className="block" data-testid="google-source">
            {t(`status.sourceLabel.${s.source}`)}
          </span>
          <span className="block text-xs text-muted-foreground">{t(`status.sourceHint.${s.source}`)}</span>
        </StatusRow>
        <StatusRow label={t('status.clientId')}>
          {s.client_id ? (
            <span className="flex items-start gap-1">
              <ClientIdText id={s.client_id} className="min-w-0 pt-0.5" data-testid="google-client-id" />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="-my-0.5 text-muted-foreground"
                onClick={() => copy(s.client_id!, t('status.clientIdCopied'))}
                aria-label={t('status.copyClientId')}
                title={t('status.copyClientId')}
              >
                {copied ? <Check className="text-status-passed" /> : <Copy />}
              </Button>
            </span>
          ) : (
            <span className="text-muted-foreground">{t('status.notSet')}</span>
          )}
        </StatusRow>
        <StatusRow label={t('status.project')}>
          {s.project_id ? <code className="font-mono text-xs leading-5">{s.project_id}</code> : <span className="text-muted-foreground">{t('status.notSet')}</span>}
        </StatusRow>
        <StatusRow label={t('status.lastChanged')}>
          {s.updated_by && s.updated_at ? (
            <span>
              <Trans
                t={t}
                i18nKey="status.changedBy"
                values={{ name: s.updated_by.name, time: relativeTime(s.updated_at, formatRelative) }}
                components={{ who: <span />, time: <time dateTime={s.updated_at} title={formatDateTime(s.updated_at)} className="text-muted-foreground" /> }}
              />
            </span>
          ) : (
            <span className="text-muted-foreground">{t('status.never')}</span>
          )}
        </StatusRow>
      </dl>
      {s.warning && (
        <Banner tone="warning" role="note">
          {s.warning}
        </Banner>
      )}
    </SettingsCard>
  )
}

/* ------------------------------------------------------------------ setup steps */

function Step({ n, done, children }: { n: number; done: boolean; children: React.ReactNode }) {
  const { t } = useTranslation('googleAuth')
  return (
    <li className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-3">
      <span
        className={cn(
          'flex size-6 items-center justify-center rounded-full border text-xs font-medium tabular',
          done ? 'border-transparent bg-status-passed-bg text-status-passed' : 'border-border text-muted-foreground',
        )}
        aria-hidden
      >
        {done ? <Check className="size-3.5" /> : n}
      </span>
      <div className="min-w-0 pt-0.5 text-sm">
        {children}
        {done && <span className="sr-only"> ({t('setup.done')})</span>}
      </div>
    </li>
  )
}

function CopyValue({ id, label, value, copyLabel, copiedToast }: { id: string; label: string; value: string; copyLabel: string; copiedToast: string }) {
  const { t } = useTranslation()
  const { copied, copy } = useCopy()
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium text-muted-foreground">
        {label}
      </span>
      <div className="flex items-start gap-2">
        <code id={id} className="min-h-8 min-w-0 flex-1 rounded-md border border-border bg-muted px-2.5 py-1.5 font-mono text-xs leading-5 break-all">
          {value}
        </code>
        <Button type="button" variant="outline" className="w-22 shrink-0" onClick={() => copy(value, copiedToast)} aria-label={copied ? undefined : copyLabel}>
          {copied ? <Check /> : <Copy />}
          {copied ? t('actions.copied') : t('actions.copy')}
        </Button>
      </div>
    </div>
  )
}

function SetupSection({ settings: s }: { settings: GoogleAuthSettings }) {
  const { t } = useTranslation('googleAuth')
  const hasClient = s.client_secret_set
  // Langkah unduh/unggah hanya "selesai" bila file memang diunggah di sini (bukan dari env).
  const uploaded = hasClient && s.source === 'database'
  return (
    <SettingsCard id="google-setup" title={t('setup.title')} description={t('setup.description')}>
      <ol aria-label={t('setup.stepsLabel')} className="grid gap-4">
        <Step n={1} done={hasClient}>
          <p>
            <Trans
              t={t}
              i18nKey="setup.create"
              components={{
                console: <ExternalAnchor href={CONSOLE_URL} newTabLabel={t('setup.newTab')} />,
                strong: <span className="font-medium" />,
              }}
            />
          </p>
        </Step>
        <Step n={2} done={s.redirect_uri_registered === true}>
          <p>{t('setup.register')}</p>
          <div className="mt-2 grid gap-3">
            <CopyValue id="google-origin" label={t('setup.origin')} value={s.javascript_origin} copyLabel={t('setup.copyOrigin')} copiedToast={t('setup.originCopied')} />
            <CopyValue id="google-redirect" label={t('setup.redirect')} value={s.redirect_uri} copyLabel={t('setup.copyRedirect')} copiedToast={t('setup.redirectCopied')} />
          </div>
          {s.redirect_uri_registered === true && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-status-passed" data-testid="google-redirect-status">
              <CircleCheck className="size-3.5 shrink-0" aria-hidden />
              {t('setup.registered')}
            </p>
          )}
          {s.redirect_uri_registered === false && (
            <div className="mt-2 flex gap-2 rounded-md bg-status-blocked-bg px-3 py-2.5 text-sm" data-testid="google-redirect-status">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-blocked" aria-hidden />
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium">{t('setup.notRegisteredTitle')}</p>
                <p className="text-foreground/85">{t('setup.notRegisteredBody')}</p>
              </div>
            </div>
          )}
        </Step>
        <Step n={3} done={uploaded}>
          <p>
            <Trans t={t} i18nKey="setup.download" components={{ strong: <span className="font-medium" /> }} />
          </p>
        </Step>
        <Step n={4} done={uploaded && s.enabled}>
          <p>
            <Trans
              t={t}
              i18nKey="setup.upload"
              components={{
                jump: (
                  <a
                    href={`#${CREDENTIALS_ID}`}
                    onClick={(e) => {
                      e.preventDefault()
                      document.getElementById(CREDENTIALS_ID)?.scrollIntoView({ block: 'start' })
                      document.getElementById(CHOOSE_ID)?.focus({ preventScroll: true })
                    }}
                    className="rounded-sm text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                ),
              }}
            />
          </p>
        </Step>
      </ol>
    </SettingsCard>
  )
}

/** Link keluar: ikon kecil + "(tab baru)" untuk pembaca layar. Teks link diisi Trans lewat children. */
function ExternalAnchor({ href, newTabLabel, children }: { href: string; newTabLabel: string; children?: React.ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="rounded-sm text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
      <ExternalLink className="ml-0.5 inline size-3 align-baseline" aria-hidden />
      <span className="sr-only"> {newTabLabel}</span>
    </a>
  )
}

/* ------------------------------------------------------------------ remove */

function RemoveSection() {
  const { t } = useTranslation(['googleAuth', 'common'])
  const remove = useDeleteGoogleAuthSettings()
  const [open, setOpen] = React.useState(false)
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const removed = React.useRef(false)

  const confirm = () =>
    remove.mutate(undefined, {
      onSuccess: () => {
        removed.current = true
        setOpen(false)
        toast.success(t('remove.removed'))
      },
    })

  return (
    <SettingsCard id="google-remove" title={t('remove.title')} description={t('remove.description')} tone="danger">
      <Button
        ref={buttonRef}
        type="button"
        variant="outline"
        className="border-destructive/60 text-destructive hover:bg-status-failed-bg hover:text-destructive"
        onClick={() => {
          remove.reset()
          setOpen(true)
        }}
      >
        <Trash2 aria-hidden />
        {t('remove.button')}
      </Button>
      <AlertDialog open={open} onOpenChange={(o) => !remove.isPending && setOpen(o)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Dibuka dari state: kembalikan fokus sendiri. Setelah dihapus kartu ini hilang → fokus ke unggah JSON.
            e.preventDefault()
            if (removed.current) requestAnimationFrame(() => document.getElementById(CHOOSE_ID)?.focus())
            else buttonRef.current?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('remove.dialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('remove.dialogBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          {remove.isError && <Banner>{t('remove.failed', { message: errorMessage(remove.error) })}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={remove.isPending}>{t('common:actions.cancel')}</AlertDialogCancel>
            <Button variant="destructive" onClick={confirm} loading={remove.isPending}>
              {t('remove.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

/* ------------------------------------------------------------------ skeleton */

function GoogleSkeleton() {
  const { t } = useTranslation('googleAuth')
  return (
    <>
      <span className="sr-only" role="status">
        {t('loading')}
      </span>
      <Delayed>
        <div className="grid gap-5" aria-hidden>
          <div className="grid gap-3 rounded-md border border-border p-4">
            <Skeleton className="h-5 w-24" />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex gap-6">
                <Skeleton className="h-4 w-28" />
                <Skeleton className="h-4 w-56 max-w-full" />
              </div>
            ))}
          </div>
          <div className="grid gap-4 rounded-md border border-border p-4">
            <Skeleton className="h-5 w-40" />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex gap-3">
                <Skeleton className="size-6 rounded-full" />
                <Skeleton className="h-4 w-full max-w-md" />
              </div>
            ))}
          </div>
        </div>
      </Delayed>
    </>
  )
}

