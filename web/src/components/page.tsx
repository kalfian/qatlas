import { AlertTriangle, RotateCw, type LucideIcon } from 'lucide-react'
import * as React from 'react'
import { ApiError, errorMessage } from '@/api/client'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function PageHeader({
  title,
  description,
  actions,
  meta,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  meta?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-x-4 gap-y-3', className)}>
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
        {meta && <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">{meta}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  )
}

export function PageContainer({ children, className, narrow }: { children: React.ReactNode; className?: string; narrow?: boolean }) {
  return <div className={cn('flex flex-col gap-5 px-4 py-4 md:px-6 md:py-5', narrow && 'max-w-3xl', className)}>{children}</div>
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col items-start gap-2 rounded-md border border-dashed border-border px-5 py-8', className)}>
      <Icon className="size-5 text-muted-foreground" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-prose text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  )
}

export function ErrorState({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const status = error instanceof ApiError ? error.status : undefined
  const title =
    status === 403 ? 'Kamu tidak punya akses ke halaman ini' : status === 404 ? 'Data tidak ditemukan' : 'Gagal memuat data'
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-2 rounded-md border border-border px-5 py-6', className)}>
      <AlertTriangle className="size-5 text-status-failed" aria-hidden />
      <p className="text-sm font-medium">{title}</p>
      <p className="text-sm text-muted-foreground">{errorMessage(error)}</p>
      {onRetry && status !== 403 && status !== 404 && (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw /> Coba lagi
        </Button>
      )}
      {error instanceof ApiError && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Detail teknis</summary>
          <code className="font-mono">
            HTTP {error.status} · {error.code}
          </code>
        </details>
      )}
    </div>
  )
}

/** Panel ber-border (pengganti card). */
export function Panel({ title, actions, children, className, bodyClassName }: {
  title?: React.ReactNode
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section className={cn('rounded-md border border-border bg-card', className)}>
      {(title || actions) && (
        <header className="flex min-h-10 items-center justify-between gap-2 border-b border-border px-4 py-2">
          {title && <h2 className="text-sm font-semibold">{title}</h2>}
          {actions}
        </header>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  )
}
