import { Link } from '@tanstack/react-router'
import { History } from 'lucide-react'
import { useRuns } from '@/api/queries'
import { EmptyState, ErrorState } from '@/components/page'
import { StatusBadge } from '@/components/status'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format'
import { useDelayed } from '../useDelayed'

export function RunsTab({ projectKey, caseKey }: { projectKey: string; caseKey: string }) {
  const runs = useRuns(projectKey, { target: caseKey }, { limit: 50 })
  const late = useDelayed(runs.isPending)
  if (runs.isError) return <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
  if (runs.isPending) {
    return late ? (
      <div className="flex flex-col gap-2" aria-busy aria-label="Memuat riwayat run">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
    ) : null
  }
  const list = runs.data.data
  if (!list.length) {
    return <EmptyState icon={History} title="Test case ini belum pernah di-run" description="Riwayat run muncul di sini setelah kamu menjalankannya, sendiri atau lewat flow." />
  }
  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="w-full border-collapse text-sm">
        <caption className="sr-only">Riwayat run {caseKey}</caption>
        <thead>
          <tr className="h-8 border-b border-border text-left text-xs font-medium text-muted-foreground">
            <th scope="col" className="px-3 font-medium">Run</th>
            <th scope="col" className="px-3 font-medium">Status</th>
            <th scope="col" className="px-3 font-medium">Lewat</th>
            <th scope="col" className="hidden px-3 font-medium md:table-cell">Environment</th>
            <th scope="col" className="hidden px-3 font-medium md:table-cell">Oleh</th>
            <th scope="col" className="px-3 font-medium">Waktu</th>
            <th scope="col" className="px-3 text-right font-medium">Durasi</th>
          </tr>
        </thead>
        <tbody>
          {list.map((r) => (
            <tr key={r.id} className="h-9 border-b border-border last:border-0 hover:bg-muted/60">
              <td className="px-3">
                <Link
                  to="/p/$key/runs/$runKey"
                  params={{ key: projectKey, runKey: r.key }}
                  className="font-mono text-xs text-link hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {r.key}
                </Link>
              </td>
              <td className="px-3">
                <StatusBadge status={r.status} />
              </td>
              <td className="max-w-48 truncate px-3 text-xs text-muted-foreground">
                {r.kind === 'flow' ? (
                  <>
                    Flow <span className="font-mono">{r.target.key}</span>
                  </>
                ) : (
                  'Langsung'
                )}
              </td>
              <td className="hidden px-3 text-xs md:table-cell">{r.environment?.name ?? '—'}</td>
              <td className="hidden px-3 text-xs md:table-cell">{r.triggered_by.name}</td>
              <td className="px-3 text-xs whitespace-nowrap text-muted-foreground">
                <time dateTime={r.queued_at} title={formatDateTime(r.queued_at)}>
                  {formatRelative(r.queued_at)}
                </time>
              </td>
              <td className="px-3 text-right font-mono text-xs whitespace-nowrap">{formatDuration(r.duration_ms)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
