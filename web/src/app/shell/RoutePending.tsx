import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { PageContainer } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { useDelayed } from '@/features/testcases/useDelayed'

/**
 * Pending UI saat chunk route (atau beforeLoad) belum siap. Router baru menampilkannya setelah
 * `defaultPendingMs` (150ms), dan useDelayed menahan 150ms lagi untuk fallback Suspense yang tidak melewati
 * timer router (render pertama) — jadi respons cepat tidak pernah berkedip. Bentuk skeleton = bentuk final
 * (ui-direction §6), tanpa spinner halaman penuh.
 */
function Pending({ className, children }: { className?: string; children: React.ReactNode }) {
  const { t } = useTranslation()
  const show = useDelayed(true, 150)
  return (
    <div className={className} aria-busy="true">
      {show && (
        <>
          <span role="status" className="sr-only">
            {t('states.loading')}
          </span>
          {children}
        </>
      )}
    </div>
  )
}

function PageBody() {
  return (
    <PageContainer>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-72" />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-3 px-3">
            <Skeleton className="h-3.5 w-16" />
            <Skeleton className="h-3.5 flex-1" />
            <Skeleton className="hidden h-3.5 w-20 sm:block" />
          </div>
        ))}
      </div>
    </PageContainer>
  )
}

/** Isi halaman di dalam shell (default semua route). */
export function PagePending() {
  return (
    <Pending>
      <PageBody />
    </Pending>
  )
}

/** Shell belum ada (route `_app`: /me + chunk shell): sidebar 240 + topbar h-12 + isi halaman. */
export function ShellPending() {
  return (
    <Pending className="flex min-h-dvh">
      <div className="hidden h-dvh w-60 shrink-0 flex-col border-r border-sidebar-border bg-sidebar lg:flex">
        <div className="flex h-12 items-center border-b border-sidebar-border px-3">
          <Skeleton className="h-4 w-20" />
        </div>
        <div className="flex flex-col gap-2 p-2">
          <Skeleton className="h-8 w-full" />
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-6 w-3/4" />
          ))}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-12 items-center gap-2 border-b border-border px-3 md:px-4">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="ml-auto h-8 w-8 sm:w-48" />
        </div>
        <PageBody />
      </div>
    </Pending>
  )
}

/** Login / undangan: kolom 360px di tengah (satu-satunya layout tengah, ui-direction §5). */
export function AuthPending() {
  return (
    <Pending className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      {/* Geometri sama dengan AuthShell (features/auth/shared.tsx) agar form muncul tanpa geser. */}
      <div className="flex w-full max-w-90 flex-col gap-6">
        <Skeleton className="h-6 w-24" />
        <div className="flex flex-col gap-4">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      </div>
    </Pending>
  )
}
