import { useQuery } from '@tanstack/react-query'
import { Link, useParams, useSearch } from '@tanstack/react-router'
import { ArrowLeft, FileQuestion, Lock } from 'lucide-react'
import * as React from 'react'
import { api, ApiError, unwrap } from '@/api/client'
import { qk, useRuns, useTestCase } from '@/api/queries'
import type { StepStatus } from '@/api/types'
import { useCan } from '@/app/auth'
import { EmptyState, ErrorState, PageContainer } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { TestCaseEditor } from './editor/TestCaseEditor'
import { draftFromCase, emptyDraft } from './lib'
import { useDelayed } from './useDelayed'

const FROM = '/_app/p/$key/tests/$caseKey' as const
const EMPTY_STATUS = new Map<string, StepStatus>()

/** Editor test case: `caseKey === 'new'` = buat baru (execution & folder dari search params). */
export function TestCaseEditorPage() {
  const { key, caseKey } = useParams({ from: FROM })
  const search = useSearch({ from: FROM })
  if (caseKey === 'new') return <CreateTestCase key={`new-${search.execution ?? 'automated'}`} projectKey={key} />
  return <EditTestCase key={caseKey} projectKey={key} caseKey={caseKey} />
}

function CreateTestCase({ projectKey }: { projectKey: string }) {
  const search = useSearch({ from: FROM })
  const canEdit = useCan('edit_tests', projectKey)
  const [initial] = React.useState(() => emptyDraft(search.execution ?? 'automated', search.folder && search.folder !== 'root' ? search.folder : null))
  if (!canEdit) {
    return (
      <PageContainer>
        <EmptyState
          icon={Lock}
          title="Kamu tidak punya akses untuk membuat test case"
          description="Role viewer hanya bisa melihat. Minta maintainer project mengubah role-mu jadi editor."
          action={<BackToList projectKey={projectKey} />}
        />
      </PageContainer>
    )
  }
  return <TestCaseEditor projectKey={projectKey} server={null} initial={initial} runStatus={EMPTY_STATUS} />
}

function EditTestCase({ projectKey, caseKey }: { projectKey: string; caseKey: string }) {
  const query = useTestCase(caseKey)
  const runStatus = useLastRunStepStatus(projectKey, caseKey)
  const late = useDelayed(query.isPending)
  const [initial, setInitial] = React.useState(() => (query.data ? draftFromCase(query.data) : null))
  if (!initial && query.data) setInitial(draftFromCase(query.data))

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404
    return (
      <PageContainer>
        {notFound ? (
          <EmptyState
            icon={FileQuestion}
            title={`Test case ${caseKey} tidak ditemukan`}
            description="Mungkin sudah dihapus, atau key-nya salah ketik."
            action={<BackToList projectKey={projectKey} />}
          />
        ) : (
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        )}
      </PageContainer>
    )
  }
  if (!query.data || !initial) return late ? <EditorSkeleton /> : null

  return (
    <TestCaseEditor
      projectKey={projectKey}
      server={query.data}
      initial={initial}
      runStatus={runStatus}
      reload={async () => (await query.refetch()).data}
    />
  )
}

/** Status per step dari run terakhir yang memuat test case ini (test case langsung atau lewat flow). */
function useLastRunStepStatus(projectKey: string, caseKey: string): Map<string, StepStatus> {
  const runs = useRuns(projectKey, { target: caseKey }, { limit: 50, live: false })
  const latestKey = runs.data?.data[0]?.key
  const run = useQuery({
    queryKey: qk.run(latestKey ?? '__none'),
    queryFn: () => unwrap(api.GET('/runs/{runKey}', { params: { path: { runKey: latestKey! } } })),
    enabled: !!latestKey,
    refetchInterval: (q) => (q.state.data && ['queued', 'running'].includes(q.state.data.status) ? 1000 : false),
  })
  return React.useMemo(() => {
    const c = run.data?.cases.find((x) => x.test_case_key === caseKey)
    if (!c) return EMPTY_STATUS
    return new Map(c.steps.map((s) => [s.step_id, s.status]))
  }, [run.data, caseKey])
}

function BackToList({ projectKey }: { projectKey: string }) {
  return (
    <Button asChild variant="outline">
      <Link to="/p/$key/tests" params={{ key: projectKey }}>
        <ArrowLeft /> Kembali ke test cases
      </Link>
    </Button>
  )
}

function EditorSkeleton() {
  return (
    <PageContainer aria-busy>
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-16" />
        <Skeleton className="h-6 w-80" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-28" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-24" />
        </div>
      </div>
      <Skeleton className="h-9 w-96" />
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_400px]">
        <div className="flex flex-col gap-px overflow-hidden rounded-md border border-border">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-9 rounded-none" />
          ))}
        </div>
        <Skeleton className="hidden h-80 xl:block" />
      </div>
    </PageContainer>
  )
}
