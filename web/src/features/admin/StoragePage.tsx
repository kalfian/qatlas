import { ArrowRightLeft, CircleCheck, Cloud, HardDrive, LoaderCircle } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '@/api/client'
import { storageMigrationActive, useMigrateArtifacts, useStorageSettings } from '@/api/queries'
import type { StorageBackend, StorageSettings } from '@/api/types'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Banner, Delayed } from '@/features/auth/shared'
import { SettingsCard } from '@/features/settings/SettingsCard'
import { relativeTime } from '@/features/settings/shared'
import { formatBytes, formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { endpointHost } from './storage-form'
import { ENV_NOTE_ID, StorageForm } from './StorageForm'

const BACKEND_ICON: Record<StorageBackend, typeof HardDrive> = { local: HardDrive, s3: Cloud }
const other = (b: StorageBackend): StorageBackend => (b === 'local' ? 's3' : 'local')

function useBackendLabel() {
  const { t } = useTranslation('storage')
  return (b: StorageBackend) => (b === 's3' ? t('backend.s3') : t('backend.local'))
}

export function StoragePage() {
  const { t } = useTranslation(['storage', 'common'])
  const q = useStorageSettings()
  return (
    <PageContainer narrow>
      <PageHeader title={t('title')} description={t('description')} />
      {q.isPending ? (
        <StorageSkeleton />
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
          <StorageForm settings={q.data} readOnly={q.data.env_override} />
          <MigrationSection settings={q.data} />
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

function StatusSection({ settings: s }: { settings: StorageSettings }) {
  const { t } = useTranslation('storage')
  const label = useBackendLabel()
  const Icon = BACKEND_ICON[s.active_backend]
  return (
    <SettingsCard id="storage-status" title={t('status.title')}>
      <dl className="grid gap-3 text-sm">
        <StatusRow label={t('status.activeBackend')}>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center gap-1.5 font-medium" data-testid="storage-active-backend">
              <Icon className="size-4 text-muted-foreground" aria-hidden />
              {label(s.active_backend)}
            </span>
            {s.active_backend === 's3' && s.s3.bucket && (
              <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                {s.s3.bucket} · {endpointHost(s.s3.endpoint)}
              </span>
            )}
          </span>
        </StatusRow>
        <StatusRow label={t('status.source')}>
          <span className="block">{t(`status.sourceLabel.${s.source}`)}</span>
          <span className="block text-xs text-muted-foreground">{t(`status.sourceHint.${s.source}`)}</span>
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
        <StatusRow label={t('status.artifacts')}>
          <ul aria-label={t('status.artifactsLabel')} className="grid gap-1">
            {(['local', 's3'] as const).map((b) => {
              const count = s.artifacts[b]
              const bytes = b === 'local' ? s.artifacts.bytes_local : s.artifacts.bytes_s3
              const active = b === s.active_backend
              return (
                <li key={b} className="flex flex-wrap items-center gap-x-2 gap-y-0.5" data-testid={`storage-count-${b}`}>
                  <span className={cn('w-28 shrink-0', !active && 'text-muted-foreground')}>{label(b)}</span>
                  <span className="tabular">
                    {t('status.files', { count })} <span className="text-muted-foreground">· {formatBytes(bytes)}</span>
                  </span>
                  {active && <Badge variant="outline">{t('status.active')}</Badge>}
                </li>
              )
            })}
          </ul>
        </StatusRow>
      </dl>
    </SettingsCard>
  )
}

/* ------------------------------------------------------------------ migration */

function MigrationSection({ settings: s }: { settings: StorageSettings }) {
  const { t } = useTranslation(['storage', 'common'])
  const label = useBackendLabel()
  const migrate = useMigrateArtifacts()
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [deleteSource, setDeleteSource] = React.useState(false)
  const [live, setLive] = React.useState('')
  const progressRef = React.useRef<HTMLDivElement>(null)
  const moveRef = React.useRef<HTMLButtonElement>(null)

  const to = s.active_backend
  const from = other(to)
  const pending = s.artifacts[from]
  const pendingBytes = from === 'local' ? s.artifacts.bytes_local : s.artifacts.bytes_s3
  const m = s.migration
  const active = storageMigrationActive(s)

  // Umumkan transisi status migrasi (bukan tiap tick progres).
  const [lastStatus, setLastStatus] = React.useState(m?.status ?? null)
  if ((m?.status ?? null) !== lastStatus) {
    setLastStatus(m?.status ?? null)
    if (m && lastStatus !== null && (m.status === 'done' || m.status === 'failed'))
      setLive(
        m.status === 'done'
          ? t('migration.announceDone', { copied: String(m.copied), failed: String(m.failed) })
          : t('migration.announceFailed', { error: m.error ?? '' }),
      )
  }

  const openConfirm = () => {
    setDeleteSource(false)
    migrate.reset()
    setConfirmOpen(true)
  }

  const start = () => {
    migrate.mutate(
      { delete_source: deleteSource },
      {
        onSuccess: (next) => {
          setConfirmOpen(false)
          if (next.migration) setLive(t('migration.announceStarted', { total: String(next.migration.total), to: label(next.migration.to) }))
        },
      },
    )
  }

  return (
    <SettingsCard id="storage-migration" title={t('migration.title')} description={t('migration.description')} bodyClassName="grid gap-3">
      {active && m ? (
        <div ref={progressRef} tabIndex={-1} className="grid gap-2 rounded-md focus-visible:outline-none" id="storage-migration-progress">
          <p className="flex items-start gap-1.5 text-sm font-medium">
            <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-status-running motion-reduce:animate-none" aria-hidden />
            {m.status === 'queued' ? t('migration.queued') : t('migration.running', { from: label(m.from), to: label(m.to) })}
          </p>
          <MigrationProgress copied={m.copied} failed={m.failed} total={m.total} />
          <p className="text-xs text-muted-foreground">{t('migration.keepWorking')}</p>
        </div>
      ) : (
        <>
          {m?.status === 'failed' && (
            <Banner title={t('migration.failedTitle')} role="note">
              <p className="font-mono text-xs break-words">{m.error}</p>
              <p className="mt-1">{t('migration.failedBody', { copied: String(m.copied), failed: String(m.failed) })}</p>
            </Banner>
          )}
          {pending > 0 ? (
            <div className="grid justify-items-start gap-3">
              <p className="text-sm">
                <Trans
                  t={t}
                  i18nKey="migration.pending"
                  count={pending}
                  values={{ size: formatBytes(pendingBytes), from: label(from) }}
                  components={{ strong: <span className="font-medium tabular" /> }}
                />
              </p>
              <Button ref={moveRef} variant="outline" size="sm" onClick={openConfirm}>
                <ArrowRightLeft aria-hidden />
                {t('migration.move', { count: pending, to: label(to) })}
              </Button>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-sm">
              <CircleCheck className="size-4 text-status-passed" aria-hidden />
              {t('migration.nothing', { backend: label(to) })}
            </p>
          )}
          {m?.status === 'done' && m.finished_at && m.total > 0 && (
            <p className="text-xs text-muted-foreground">
              <Trans
                t={t}
                i18nKey="migration.doneSummary"
                values={{ time: relativeTime(m.finished_at, formatRelative), copied: String(m.copied), failed: String(m.failed) }}
                components={{ time: <time dateTime={m.finished_at} title={formatDateTime(m.finished_at)} /> }}
              />
            </p>
          )}
        </>
      )}
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => !migrate.isPending && setConfirmOpen(o)}>
        <AlertDialogContent
          onCloseAutoFocus={(e) => {
            // Dialog dibuka dari state (tanpa Trigger) → Radix tidak tahu ke mana fokus kembali.
            // Batal: kembali ke tombol Move. Mulai: tombol itu hilang, fokus ke blok progres.
            e.preventDefault()
            ;(progressRef.current ?? moveRef.current)?.focus()
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('migration.dialog.title', { count: pending, to: label(to) })}</AlertDialogTitle>
            <AlertDialogDescription>{t('migration.dialog.body', { from: label(from) })}</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-start gap-2.5 rounded-md border border-border px-3 py-2.5">
            <Checkbox
              id="storage-delete-source"
              checked={deleteSource}
              onCheckedChange={(v) => setDeleteSource(v === true)}
              aria-describedby="storage-delete-source-hint"
              className="mt-0.5"
            />
            <div className="grid gap-1">
              <Label htmlFor="storage-delete-source" className="leading-5">
                {t('migration.dialog.deleteSource')}
              </Label>
              <p id="storage-delete-source-hint" className="text-xs text-muted-foreground">
                {t('migration.dialog.deleteSourceHint', { from: label(from) })}
              </p>
            </div>
          </div>
          {migrate.isError && <Banner>{t('migration.startFailed', { message: errorMessage(migrate.error) })}</Banner>}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={migrate.isPending}>{t('common:actions.cancel')}</AlertDialogCancel>
            <Button onClick={start} loading={migrate.isPending}>
              {t('migration.dialog.confirm')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

function MigrationProgress({ copied, failed, total }: { copied: number; failed: number; total: number }) {
  const { t } = useTranslation('storage')
  const done = copied + failed
  const pct = (n: number) => (total > 0 ? (n / total) * 100 : 0)
  return (
    <div className="grid gap-1.5">
      <div
        role="progressbar"
        aria-label={t('migration.progressLabel')}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-valuetext={t('migration.progressText', { done: String(done), total: String(total) })}
        className="flex h-2 w-full gap-px overflow-hidden rounded-sm bg-muted"
      >
        {copied > 0 && <div className="h-full bg-status-passed transition-[width] duration-150 ease-out motion-reduce:transition-none" style={{ width: `${pct(copied)}%` }} />}
        {failed > 0 && <div className="h-full bg-status-failed transition-[width] duration-150 ease-out motion-reduce:transition-none" style={{ width: `${pct(failed)}%` }} />}
      </div>
      <p className="text-xs text-muted-foreground tabular">
        {t('migration.progressCounts', { copied: String(copied), failed: String(failed), total: String(total) })}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ skeleton */

function StorageSkeleton() {
  const { t } = useTranslation('storage')
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
                <Skeleton className="h-4 w-48" />
              </div>
            ))}
          </div>
          <div className="grid gap-4 rounded-md border border-border p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-8 w-80 max-w-full" />
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-full" />
          </div>
        </div>
      </Delayed>
    </>
  )
}
