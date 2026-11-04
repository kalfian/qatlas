import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Play, Plus, Search, Workflow, X } from 'lucide-react'
import * as React from 'react'
import { useFlows } from '@/api/queries'
import type { FlowSummary } from '@/api/types'
import { useCan } from '@/app/auth'
import { ManualBadge } from '@/components/misc'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tip } from '@/components/ui/tooltip'
import { RunDialog } from '@/features/runs/RunDialog'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { useDebounced, useDelayedFlag } from './hooks'

export function FlowsPage() {
  const { key } = useParams({ from: '/_app/p/$key/flows' })
  const canEdit = useCan('edit_tests', key)
  const canRun = useCan('run', key)
  const [q, setQ] = React.useState('')
  const debounced = useDebounced(q.trim(), 200)
  const flows = useFlows(key, debounced || undefined)
  const [runTarget, setRunTarget] = React.useState<FlowSummary | null>(null)
  const showSkeleton = useDelayedFlag(flows.isLoading)

  const list = flows.data?.data ?? []
  const searching = debounced !== ''

  return (
    <PageContainer>
      <PageHeader
        title="Flows"
        description="Urutan test case yang dijalankan sebagai satu run."
        actions={
          canEdit && (
            <Button asChild>
              <Link to="/p/$key/flows/$flowKey" params={{ key, flowKey: 'new' }}>
                <Plus /> Flow
              </Link>
            </Button>
          )
        }
      />

      <div className="flex flex-col gap-3">
        <div className="relative w-full sm:max-w-xs">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQ('')}
            placeholder="Cari nama atau key…"
            aria-label="Cari flow"
            className="pl-8"
          />
        </div>

        {flows.isError ? (
          <ErrorState error={flows.error} onRetry={() => flows.refetch()} />
        ) : flows.isLoading ? (
          showSkeleton ? <TableSkeleton /> : <div className="h-[328px]" aria-busy="true" />
        ) : list.length === 0 ? (
          searching ? (
            <EmptyState
              icon={Search}
              title={`Tidak ada flow yang cocok dengan "${debounced}".`}
              action={
                <Button variant="outline" size="sm" onClick={() => setQ('')}>
                  <X /> Reset pencarian
                </Button>
              }
            />
          ) : (
            <EmptyState
              icon={Workflow}
              title="Belum ada flow di project ini."
              description={
                canEdit
                  ? 'Flow menyusun beberapa test case jadi satu run, misalnya login → keranjang → checkout.'
                  : 'Editor project bisa menyusun beberapa test case jadi satu flow.'
              }
              action={
                canEdit && (
                  <Button asChild size="sm">
                    <Link to="/p/$key/flows/$flowKey" params={{ key, flowKey: 'new' }}>
                      <Plus /> Buat flow
                    </Link>
                  </Button>
                )
              }
            />
          )
        ) : (
          <FlowsTable projectKey={key} flows={list} canRun={canRun} onRun={setRunTarget} />
        )}
      </div>

      {runTarget && (
        <RunDialog
          projectKey={key}
          target={{ kind: 'flow', key: runTarget.key, title: runTarget.name, hasManual: runTarget.has_manual }}
          open
          onOpenChange={(o) => !o && setRunTarget(null)}
        />
      )}
    </PageContainer>
  )
}

function FlowsTable({
  projectKey,
  flows,
  canRun,
  onRun,
}: {
  projectKey: string
  flows: FlowSummary[]
  canRun: boolean
  onRun: (f: FlowSummary) => void
}) {
  const navigate = useNavigate()
  const open = (flowKey: string) => navigate({ to: '/p/$key/flows/$flowKey', params: { key: projectKey, flowKey } })

  return (
    <div className="rounded-md border border-border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-22">Key</TableHead>
            <TableHead>Nama</TableHead>
            <TableHead className="w-14 text-right">Item</TableHead>
            <TableHead className="hidden w-30 md:table-cell">Session</TableHead>
            <TableHead className="hidden w-28 lg:table-cell">Stop on failure</TableHead>
            <TableHead className="w-48">Last run</TableHead>
            <TableHead className="hidden w-26 lg:table-cell">Diubah</TableHead>
            {canRun && (
              <TableHead className="w-20">
                <span className="sr-only">Aksi</span>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {flows.map((f) => {
            const blocked = f.shared_session && f.has_manual
            return (
              <TableRow key={f.id} className="cursor-pointer hover:bg-muted/60" onClick={() => open(f.key)}>
                <TableCell>
                  <Link
                    to="/p/$key/flows/$flowKey"
                    params={{ key: projectKey, flowKey: f.key }}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-sm font-mono text-xs font-medium whitespace-nowrap hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {f.key}
                  </Link>
                </TableCell>
                <TableCell className="max-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{f.name}</span>
                    {f.has_manual && <ManualBadge execution="manual" className="shrink-0" />}
                  </div>
                  {f.description && <p className="truncate text-xs text-muted-foreground">{f.description}</p>}
                </TableCell>
                <TableCell className="text-right tabular">{f.item_count}</TableCell>
                <TableCell className="hidden md:table-cell">
                  <span className={cn('text-xs', f.shared_session ? 'text-foreground' : 'text-muted-foreground')}>
                    {f.shared_session ? 'Shared session' : 'Isolated'}
                  </span>
                </TableCell>
                <TableCell className="hidden lg:table-cell">
                  <span className={cn('text-xs', f.stop_on_failure ? 'text-foreground' : 'text-muted-foreground')}>
                    {f.stop_on_failure ? 'Ya' : 'Tidak'}
                  </span>
                </TableCell>
                <TableCell>
                  {f.last_run_status ? (
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <StatusBadge status={f.last_run_status} />
                      <time dateTime={f.last_run_at ?? undefined} className="text-xs text-muted-foreground">
                        {formatRelative(f.last_run_at)}
                      </time>
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">Belum pernah</span>
                  )}
                </TableCell>
                <TableCell className="hidden text-xs whitespace-nowrap text-muted-foreground lg:table-cell">
                  <time dateTime={f.updated_at}>{formatRelative(f.updated_at)}</time>
                </TableCell>
                {canRun && (
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {blocked ? (
                      <Tip label="Flow shared session berisi test case manual. Buka flow untuk memperbaikinya.">
                        <Button variant="ghost" size="sm" aria-disabled="true" aria-label={`Run ${f.key} (tidak tersedia)`}>
                          <Play /> Run
                        </Button>
                      </Tip>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => onRun(f)} aria-label={`Run ${f.key} ${f.name}`}>
                        <Play /> Run
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="rounded-md border border-border" aria-busy="true" aria-label="Memuat flow">
      <div className="h-8 border-b border-border" />
      {Array.from({ length: 8 }, (_, i) => (
        <div key={i} className="flex h-9 items-center gap-6 border-b border-border px-3 last:border-0">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="hidden h-3 w-20 md:block" />
          <Skeleton className="h-3 w-24" />
        </div>
      ))}
    </div>
  )
}
