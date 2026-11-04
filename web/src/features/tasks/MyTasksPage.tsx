import { Link, useNavigate } from '@tanstack/react-router'
import { Hand, ListChecks, Workflow } from 'lucide-react'
import { useMyManualRuns } from '@/api/queries'
import type { RunSummary } from '@/api/types'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { KeyBadge } from '@/components/misc'
import { StatusBadge } from '@/components/status'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Delayed } from '@/features/auth/shared'
import { formatDateTime, formatRelative } from '@/lib/format'

function progress(run: RunSummary) {
  const s = run.summary.steps
  const done = s.passed + s.failed + s.blocked + s.skipped
  return { done, total: s.total }
}

export function MyTasksPage() {
  const runs = useMyManualRuns()
  const navigate = useNavigate()
  const list = runs.data?.data ?? []

  const open = (r: RunSummary) => navigate({ to: '/p/$key/runs/$runKey', params: { key: r.project_key, runKey: r.key } })

  return (
    <PageContainer>
      <PageHeader
        title="Tugas saya"
        description="Run manual yang ditugaskan ke kamu di semua project. Yang paling lama menunggu ada di atas."
        meta={runs.data && list.length > 0 ? <span className="tabular">{list.length} menunggu</span> : undefined}
      />

      {runs.isPending ? (
        <Delayed>
          <div className="rounded-md border border-border" aria-hidden>
            <div className="h-8 border-b border-border" />
            {Array.from({ length: 4 }, (_, i) => (
              <div key={i} className="flex h-9 items-center gap-6 border-b border-border px-3 last:border-0">
                <Skeleton className="h-4 w-12" />
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3.5 w-56" />
                <Skeleton className="hidden h-3.5 w-16 md:block" />
              </div>
            ))}
          </div>
        </Delayed>
      ) : runs.isError ? (
        <ErrorState error={runs.error} onRetry={() => runs.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon={Hand} title="Tidak ada tugas manual" description="Run manual yang ditugaskan ke kamu akan muncul di sini." />
      ) : (
        <div className="rounded-md border border-border">
          <Table>
            <caption className="sr-only">Run manual yang menunggu kamu, urut dari yang paling lama</caption>
            <TableHeader>
              <TableRow>
                <TableHead className="hidden sm:table-cell">Project</TableHead>
                <TableHead>Run</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="text-right">Progres</TableHead>
                <TableHead className="hidden sm:table-cell">Ditugaskan</TableHead>
                <TableHead className="hidden sm:table-cell">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((r) => {
                const p = progress(r)
                return (
                  <TableRow
                    key={r.id}
                    className="cursor-pointer hover:bg-muted/60"
                    // Baris bisa diklik dengan mouse; keyboard memakai link di kolom Run.
                    onClick={(e) => {
                      if ((e.target as HTMLElement).closest('a')) return
                      open(r)
                    }}
                  >
                    <TableCell className="hidden sm:table-cell">
                      <KeyBadge>{r.project_key}</KeyBadge>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      <Link
                        to="/p/$key/runs/$runKey"
                        params={{ key: r.project_key, runKey: r.key }}
                        className="rounded-sm font-mono text-xs font-medium text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Kerjakan ${r.key}: ${r.target.title}`}
                      >
                        {r.key}
                      </Link>
                    </TableCell>
                    <TableCell className="py-2 sm:min-w-56">
                      <span className="flex min-w-0 items-start gap-2 sm:items-center">
                        {r.kind === 'flow' ? (
                          <Workflow className="mt-0.5 size-3.5 shrink-0 text-muted-foreground sm:mt-0" aria-label="Flow" role="img" />
                        ) : (
                          <ListChecks className="mt-0.5 size-3.5 shrink-0 text-muted-foreground sm:mt-0" aria-label="Test case" role="img" />
                        )}
                        <span className="min-w-0 sm:truncate">
                          {r.target.title} <span className="font-mono text-xs whitespace-nowrap text-muted-foreground">{r.target.key}</span>
                          <span className="block text-xs text-muted-foreground sm:hidden">Ditugaskan {formatRelative(r.queued_at)}</span>
                        </span>
                      </span>
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <span className="tabular">
                        {p.done}/{p.total}
                      </span>{' '}
                      <span className="text-muted-foreground">step</span>
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap sm:table-cell">
                      <time dateTime={r.queued_at} title={formatDateTime(r.queued_at)}>
                        {formatRelative(r.queued_at)}
                      </time>
                    </TableCell>
                    <TableCell className="hidden sm:table-cell">
                      <StatusBadge status={r.status} />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </PageContainer>
  )
}
