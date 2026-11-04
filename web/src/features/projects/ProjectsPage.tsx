import { Link } from '@tanstack/react-router'
import { FolderKanban, Plus } from 'lucide-react'
import * as React from 'react'
import { useProjects, useProjectStats } from '@/api/queries'
import type { ProjectSummary } from '@/api/types'
import { useIsAdmin } from '@/app/auth'
import { KeyBadge } from '@/components/misc'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { StatusBadge } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Delayed } from '@/features/auth/shared'
import { formatDateTime, formatPercent, formatRelative } from '@/lib/format'
import { ROLE_LABELS } from '@/lib/permissions'
import { CreateProjectDialog } from './CreateProjectDialog'

/** Kolom desktop: key · nama · test case · run terakhir · pass rate. Kolom key muat 10 karakter mono. */
const GRID = 'md:grid-cols-[5.5rem_minmax(0,1fr)_7rem_14rem_9.5rem]'

export function ProjectsPage() {
  const projects = useProjects()
  const isAdmin = useIsAdmin()
  const [createOpen, setCreateOpen] = React.useState(false)
  const list = projects.data?.data ?? []

  const createButton = isAdmin ? (
    <Button onClick={() => setCreateOpen(true)}>
      <Plus /> Buat project
    </Button>
  ) : undefined

  return (
    <PageContainer>
      <PageHeader
        title="Project"
        description={projects.data && list.length > 0 ? `${list.length} project yang bisa kamu akses.` : 'Project yang bisa kamu akses.'}
        actions={list.length > 0 ? createButton : undefined}
      />

      {projects.isPending ? (
        <ProjectsSkeleton />
      ) : projects.isError ? (
        <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
      ) : list.length === 0 ? (
        isAdmin ? (
          <EmptyState icon={FolderKanban} title="Belum ada project" description="Buat project pertama untuk mulai menyusun test case dan flow." action={createButton} />
        ) : (
          <EmptyState icon={FolderKanban} title="Kamu belum jadi member project mana pun." description="Minta maintainer project menambahkanmu." />
        )
      ) : (
        <div className="rounded-md border border-border">
          <div className={`hidden h-8 items-center gap-x-4 border-b border-border px-4 text-xs font-medium text-muted-foreground md:grid ${GRID}`} aria-hidden>
            <span>Key</span>
            <span>Project</span>
            <span className="text-right">Test case</span>
            <span>Run terakhir</span>
            <span>Pass rate 7 hari</span>
          </div>
          <ul aria-label="Daftar project">
            {list.map((p) => (
              <ProjectRow key={p.id} project={p} />
            ))}
          </ul>
        </div>
      )}

      {isAdmin && <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} />}
    </PageContainer>
  )
}

function ProjectRow({ project: p }: { project: ProjectSummary }) {
  const run = p.last_run
  const runAt = run ? (run.finished_at ?? run.started_at ?? run.queued_at) : null
  return (
    <li className="border-b border-border last:border-0">
      <Link
        to="/p/$key"
        params={{ key: p.key }}
        className={`grid grid-cols-1 items-center gap-y-1.5 px-4 py-2.5 transition-colors duration-150 hover:bg-muted/60 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:gap-x-4 ${GRID}`}
      >
        {/* Mobile: key di depan nama. Desktop: `contents` → key dan nama jadi kolom grid sendiri. */}
        <span className="flex min-w-0 items-start gap-2.5 md:contents">
          <span className="pt-0.5 md:pt-0">
            <KeyBadge>{p.key}</KeyBadge>
          </span>
          <span className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate font-medium">{p.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{ROLE_LABELS[p.my_role]}</span>
            </span>
            <span className="truncate text-xs text-muted-foreground">{p.description || 'Tanpa deskripsi'}</span>
          </span>
        </span>

        {/* Mobile: meta jadi satu baris di bawah nama. Desktop: `contents` → tiap item jadi kolom grid. */}
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs md:contents md:text-sm">
          <span className="tabular md:text-right">
            {p.test_case_count} <span className="text-muted-foreground">test case</span>
          </span>
          <span className="flex min-w-0 items-center gap-2">
            {run ? (
              <>
                <StatusBadge status={run.status} />
                <time dateTime={runAt!} title={formatDateTime(runAt)} className="truncate text-xs text-muted-foreground">
                  {formatRelative(runAt)}
                </time>
              </>
            ) : (
              <span className="text-muted-foreground">Belum ada run</span>
            )}
          </span>
          <PassRate projectKey={p.key} value={p.pass_rate_7d} />
        </span>
      </Link>
    </li>
  )
}

function PassRate({ projectKey, value }: { projectKey: string; value: number | null }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="sr-only">Pass rate 7 hari:</span>
      <span className={value == null ? 'tabular w-9 text-muted-foreground' : 'tabular w-9 font-medium'}>{formatPercent(value)}</span>
      {value != null && <Sparkline projectKey={projectKey} />}
    </span>
  )
}

/** Tren pass rate harian 7 hari (60×20). Dekoratif bagi pembaca layar: angkanya sudah ada di samping. */
function Sparkline({ projectKey }: { projectKey: string }) {
  const stats = useProjectStats(projectKey, '7d')
  const W = 60
  const H = 20
  const pad = 2
  if (!stats.data) return <span className="h-5 w-15" aria-hidden />
  const days = stats.data.daily
  const pts = days.map((d, i) => {
    const n = d.passed + d.failed
    const rate = n ? d.passed / n : null
    const x = pad + (i * (W - pad * 2)) / Math.max(1, days.length - 1)
    const y = rate == null ? null : pad + (1 - rate) * (H - pad * 2)
    return { x, y }
  })
  // Pecah garis di hari tanpa run.
  const segments: string[] = []
  let cur: string[] = []
  for (const p of pts) {
    if (p.y == null) {
      if (cur.length) segments.push(cur.join(' '))
      cur = []
    } else cur.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`)
  }
  if (cur.length) segments.push(cur.join(' '))
  const lastPoint = [...pts].reverse().find((p) => p.y != null)

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} className="shrink-0 overflow-visible text-muted-foreground" aria-hidden focusable="false">
      <line x1={0} x2={W} y1={H - 0.5} y2={H - 0.5} className="stroke-border" strokeWidth={1} />
      {segments.map((s, i) =>
        s.includes(' ') ? (
          <polyline key={i} points={s} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
        ) : (
          <circle key={i} cx={s.split(',')[0]} cy={s.split(',')[1]} r={1.25} fill="currentColor" />
        ),
      )}
      {lastPoint && <circle cx={lastPoint.x} cy={lastPoint.y!} r={2} className="fill-foreground" />}
    </svg>
  )
}

function ProjectsSkeleton() {
  return (
    <Delayed>
      <div className="rounded-md border border-border" aria-hidden>
        <div className="hidden h-8 border-b border-border md:block" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex h-15 items-center gap-4 border-b border-border px-4 last:border-0">
            <Skeleton className="h-5 w-12" />
            <div className="flex flex-1 flex-col gap-1.5">
              <Skeleton className="h-3.5 w-40" />
              <Skeleton className="h-3 w-64 max-w-full" />
            </div>
            <Skeleton className="hidden h-5 w-24 md:block" />
            <Skeleton className="hidden h-5 w-28 md:block" />
          </div>
        ))}
      </div>
    </Delayed>
  )
}
