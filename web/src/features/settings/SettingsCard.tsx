import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useRefocusAfterPending } from './shared'

/** Kartu pengaturan ber-border: judul + deskripsi, isi, footer aksi. */
export function SettingsCard({ id, title, description, children, footer, tone, className, bodyClassName }: {
  id: string
  title: string
  description?: React.ReactNode
  children: React.ReactNode
  footer?: React.ReactNode
  tone?: 'danger'
  className?: string
  bodyClassName?: string
}) {
  return (
    <section aria-labelledby={id} className={cn('rounded-md border bg-card', tone === 'danger' ? 'border-destructive/50' : 'border-border', className)}>
      <header className="px-4 pt-4">
        <h2 id={id} className={cn('text-lg font-semibold', tone === 'danger' && 'text-destructive')}>
          {title}
        </h2>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </header>
      <div className={cn('p-4', bodyClassName)}>{children}</div>
      {footer && (
        <footer className="flex flex-wrap items-center justify-end gap-x-3 gap-y-2 rounded-b-md border-t border-border bg-muted/50 px-4 py-2.5">{footer}</footer>
      )}
    </section>
  )
}

/**
 * Tombol simpan di footer form. Saat belum ada perubahan, tombol tetap bisa difokus
 * (aria-disabled) dan alasannya dibacakan lewat aria-describedby (ui-direction §6).
 */
export function SaveBar({ id, dirty, pending, error, label }: { id: string; dirty: boolean; pending: boolean; error?: unknown; label?: string }) {
  const { t } = useTranslation(['settings', 'common'])
  const ref = React.useRef<HTMLButtonElement>(null)
  useRefocusAfterPending(pending, ref)
  return (
    <>
      <p id={`${id}-save-hint`} className={cn('mr-auto text-xs', error ? 'text-destructive' : 'text-muted-foreground')} role={error ? 'alert' : undefined}>
        {error
          ? t('common:errors.saveFailed', { message: errorMessage(error) })
          : dirty
            ? t('saveBar.unsaved')
            : t('common:states.noChanges')}
      </p>
      <Button ref={ref} type="submit" size="sm" loading={pending} aria-disabled={!dirty || undefined} aria-describedby={`${id}-save-hint`}>
        {label ?? t('common:actions.save')}
      </Button>
    </>
  )
}

export function FieldHint({ id, error, children }: { id: string; error?: string; children?: React.ReactNode }) {
  if (error)
    return (
      <p id={`${id}-error`} className="text-xs text-destructive">
        {error}
      </p>
    )
  if (!children) return null
  return (
    <p id={`${id}-hint`} className="text-xs text-muted-foreground">
      {children}
    </p>
  )
}
