import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import * as React from 'react'
import { IS_MOCK } from '@/app/config'
import { api, API_BASE, ApiError, CSRF_HEADERS, unwrap } from './client'
import type {
  ApiTokenCreate,
  BulkTestCaseAction,
  EnvironmentInput,
  FlowInput,
  ProjectRole,
  RunCreate,
  RunKind,
  RunOptions,
  RunStatus,
  RunTrigger,
  StorageSettings,
  StorageSettingsInput,
  SystemRole,
  TestCaseInput,
} from './types'

/* ------------------------------------------------------------------ query keys */

export const qk = {
  me: ['me'] as const,
  tokens: ['me', 'tokens'] as const,
  myManualRuns: ['me', 'manual-runs'] as const,
  adminUsers: ['admin', 'users'] as const,
  adminStorage: ['admin', 'storage'] as const,
  projects: ['projects'] as const,
  project: (key: string) => ['projects', key] as const,
  stats: (key: string, range: string) => ['projects', key, 'stats', range] as const,
  members: (key: string) => ['projects', key, 'members'] as const,
  assignable: (key: string) => ['projects', key, 'assignable-users'] as const,
  environments: (key: string) => ['projects', key, 'environments'] as const,
  folders: (key: string) => ['projects', key, 'folders'] as const,
  tags: (key: string) => ['projects', key, 'tags'] as const,
  testCases: (key: string, filters?: object) => ['projects', key, 'test-cases', filters ?? {}] as const,
  testCase: (caseKey: string) => ['test-cases', caseKey] as const,
  revisions: (caseKey: string) => ['test-cases', caseKey, 'revisions'] as const,
  revision: (caseKey: string, rev: number) => ['test-cases', caseKey, 'revisions', rev] as const,
  flows: (key: string, q?: string) => ['projects', key, 'flows', q ?? ''] as const,
  flow: (flowKey: string) => ['flows', flowKey] as const,
  runs: (key: string, filters?: object) => ['projects', key, 'runs', filters ?? {}] as const,
  run: (runKey: string) => ['runs', runKey] as const,
}

const projectOf = (entityKey: string) => entityKey.split('-')[0]

/** Invalidate semua query yang terkait satu project (list, stats, dll). */
export function invalidateProject(qc: QueryClient, key: string) {
  return qc.invalidateQueries({ queryKey: ['projects', key] })
}

/* ------------------------------------------------------------------ auth & me */

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => unwrap(api.GET('/me')),
    retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2,
    staleTime: 30_000,
  })
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; password: string }) => unwrap(api.POST('/auth/login', { body })),
    onSuccess: (me) => {
      qc.clear()
      qc.setQueryData(qk.me, me)
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.POST('/auth/logout')),
    onSettled: () => {
      qc.clear()
    },
  })
}

/** Mode mock: simulasi callback Google. Mode real: redirect ke /auth/google/start. */
export function useMockGoogleLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (email: string) => {
      const res = await fetch(`${API_BASE}/__mock/google-login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CSRF_HEADERS },
        body: JSON.stringify({ email }),
      })
      const json = await res.json().catch(() => undefined)
      if (!res.ok) throw new ApiError(res.status, json)
      return json
    },
    onSuccess: (me) => {
      qc.clear()
      qc.setQueryData(qk.me, me)
    },
  })
}

export function useAuthConfig() {
  return useQuery({ queryKey: ['auth', 'config'], queryFn: () => unwrap(api.GET('/auth/config')), staleTime: Infinity })
}

export function useInvite(token: string) {
  return useQuery({
    queryKey: ['invite', token],
    queryFn: () => unwrap(api.GET('/auth/invites/{token}', { params: { path: { token } } })),
    retry: false,
  })
}

export function useAcceptInvite(token: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (password: string) => unwrap(api.POST('/auth/invites/{token}/accept', { params: { path: { token } }, body: { password } })),
    onSuccess: (me) => {
      qc.clear()
      qc.setQueryData(qk.me, me)
    },
  })
}

export function useUpdateMe() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name?: string; locale?: 'en' | 'id'; current_password?: string; new_password?: string }) => unwrap(api.PATCH('/me', { body })),
    onSuccess: (me) => qc.setQueryData(qk.me, me),
  })
}

export function useTokens() {
  return useQuery({ queryKey: qk.tokens, queryFn: () => unwrap(api.GET('/me/tokens')) })
}

export function useCreateToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: ApiTokenCreate) => unwrap(api.POST('/me/tokens', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  })
}

export function useRevokeToken() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.DELETE('/me/tokens/{id}', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.tokens }),
  })
}

export function useMyManualRuns() {
  return useQuery({ queryKey: qk.myManualRuns, queryFn: () => unwrap(api.GET('/me/manual-runs')), refetchInterval: 10_000 })
}

/* ------------------------------------------------------------------ admin */

export function useAdminUsers() {
  return useQuery({ queryKey: qk.adminUsers, queryFn: () => unwrap(api.GET('/admin/users')) })
}

export function useAdminCreateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { email: string; name: string; system_role: SystemRole }) => unwrap(api.POST('/admin/users', { body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  })
}

export function useAdminUpdateUser() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; name?: string; system_role?: SystemRole; status?: 'active' | 'disabled' }) =>
      unwrap(api.PATCH('/admin/users/{id}', { params: { path: { id } }, body })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  })
}

export function useAdminInviteLink() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => unwrap(api.POST('/admin/users/{id}/invite-link', { params: { path: { id } } })),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.adminUsers }),
  })
}

/** Migrasi artifact sedang berjalan di server → GET storage di-poll tiap 2 detik. */
export function storageMigrationActive(s: StorageSettings | undefined): boolean {
  const st = s?.migration?.status
  return st === 'queued' || st === 'running'
}

export function useStorageSettings() {
  return useQuery({
    queryKey: qk.adminStorage,
    queryFn: () => unwrap(api.GET('/admin/settings/storage')),
    refetchInterval: (q) => (storageMigrationActive(q.state.data) ? 2_000 : false),
  })
}

export function useUpdateStorageSettings() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: StorageSettingsInput) => unwrap(api.PUT('/admin/settings/storage', { body })),
    onSuccess: (s) => qc.setQueryData(qk.adminStorage, s),
  })
}

/** Probe tanpa menyimpan; `s3.secret_access_key` yang dihilangkan = secret tersimpan. */
export function useTestStorageSettings() {
  return useMutation({
    mutationFn: (body: StorageSettingsInput) => unwrap(api.POST('/admin/settings/storage/test', { body })),
  })
}

export function useMigrateArtifacts() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { delete_source: boolean }) => unwrap(api.POST('/admin/settings/storage/migrate', { body })),
    onSuccess: (s) => qc.setQueryData(qk.adminStorage, s),
  })
}

/* ------------------------------------------------------------------ projects */

export function useProjects() {
  return useQuery({ queryKey: qk.projects, queryFn: () => unwrap(api.GET('/projects')) })
}

export function useProject(key: string) {
  return useQuery({ queryKey: qk.project(key), queryFn: () => unwrap(api.GET('/projects/{key}', { params: { path: { key } } })) })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { key: string; name: string; description?: string }) => unwrap(api.POST('/projects', { body })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects })
      qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

export function useUpdateProject(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: { name?: string; description?: string; default_run_options?: RunOptions; artifact_retention_days?: number }) =>
      unwrap(api.PATCH('/projects/{key}', { params: { path: { key } }, body })),
    onSuccess: (p) => {
      qc.setQueryData(qk.project(key), p)
      qc.invalidateQueries({ queryKey: qk.projects })
    },
  })
}

export function useArchiveProject(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => unwrap(api.POST('/projects/{key}/archive', { params: { path: { key } } })),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.projects })
      qc.invalidateQueries({ queryKey: qk.me })
    },
  })
}

export function useProjectStats(key: string, range: '7d' | '30d') {
  return useQuery({
    queryKey: qk.stats(key, range),
    queryFn: () => unwrap(api.GET('/projects/{key}/stats', { params: { path: { key }, query: { range } } })),
    refetchInterval: 15_000,
  })
}

export function useMembers(key: string) {
  return useQuery({ queryKey: qk.members(key), queryFn: () => unwrap(api.GET('/projects/{key}/members', { params: { path: { key } } })) })
}

export function useAssignableUsers(key: string, enabled = true) {
  return useQuery({
    queryKey: qk.assignable(key),
    queryFn: () => unwrap(api.GET('/projects/{key}/assignable-users', { params: { path: { key } } })),
    enabled,
  })
}

export function useMemberMutations(key: string) {
  const qc = useQueryClient()
  const done = () => {
    qc.invalidateQueries({ queryKey: qk.members(key) })
    qc.invalidateQueries({ queryKey: qk.assignable(key) })
  }
  return {
    add: useMutation({
      mutationFn: (body: { user_id: string; role: ProjectRole }) => unwrap(api.POST('/projects/{key}/members', { params: { path: { key } }, body })),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ userId, role }: { userId: string; role: ProjectRole }) =>
        unwrap(api.PATCH('/projects/{key}/members/{userId}', { params: { path: { key, userId } }, body: { role } })),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (userId: string) => unwrap(api.DELETE('/projects/{key}/members/{userId}', { params: { path: { key, userId } } })),
      onSuccess: done,
    }),
  }
}

/* ------------------------------------------------------------------ environments */

export function useEnvironments(key: string) {
  return useQuery({ queryKey: qk.environments(key), queryFn: () => unwrap(api.GET('/projects/{key}/environments', { params: { path: { key } } })) })
}

export function useEnvironmentMutations(key: string) {
  const qc = useQueryClient()
  const done = () => qc.invalidateQueries({ queryKey: qk.environments(key) })
  return {
    create: useMutation({
      mutationFn: (body: EnvironmentInput) => unwrap(api.POST('/projects/{key}/environments', { params: { path: { key } }, body })),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: EnvironmentInput & { id: string }) =>
        unwrap(api.PATCH('/projects/{key}/environments/{id}', { params: { path: { key, id } }, body })),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/projects/{key}/environments/{id}', { params: { path: { key, id } } })),
      onSuccess: done,
    }),
    setSecret: useMutation({
      mutationFn: ({ id, name, value }: { id: string; name: string; value: string }) =>
        unwrap(api.PUT('/projects/{key}/environments/{id}/secrets/{name}', { params: { path: { key, id, name } }, body: { value } })),
      onSuccess: done,
    }),
    deleteSecret: useMutation({
      mutationFn: ({ id, name }: { id: string; name: string }) =>
        unwrap(api.DELETE('/projects/{key}/environments/{id}/secrets/{name}', { params: { path: { key, id, name } } })),
      onSuccess: done,
    }),
  }
}

/* ------------------------------------------------------------------ folders & test cases */

export function useFolders(key: string) {
  return useQuery({ queryKey: qk.folders(key), queryFn: () => unwrap(api.GET('/projects/{key}/folders', { params: { path: { key } } })) })
}

export function useFolderMutations(key: string) {
  const qc = useQueryClient()
  const done = () => invalidateProject(qc, key)
  return {
    create: useMutation({
      mutationFn: (body: { name: string; parent_id?: string | null }) => unwrap(api.POST('/projects/{key}/folders', { params: { path: { key } }, body })),
      onSuccess: done,
    }),
    update: useMutation({
      mutationFn: ({ id, ...body }: { id: string; name?: string; parent_id?: string | null; position?: number }) =>
        unwrap(api.PATCH('/projects/{key}/folders/{id}', { params: { path: { key, id } }, body })),
      onSuccess: done,
    }),
    remove: useMutation({
      mutationFn: (id: string) => unwrap(api.DELETE('/projects/{key}/folders/{id}', { params: { path: { key, id } } })),
      onSuccess: done,
    }),
  }
}

export function useTags(key: string) {
  return useQuery({ queryKey: qk.tags(key), queryFn: () => unwrap(api.GET('/projects/{key}/tags', { params: { path: { key } } })) })
}

export interface TestCaseFilters {
  folder?: string
  q?: string
  tags?: string
  status?: 'draft' | 'ready' | 'deprecated'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  execution?: 'automated' | 'manual'
  last_run_status?: RunStatus
}

export function useTestCases(key: string, filters: TestCaseFilters = {}) {
  return useQuery({
    queryKey: qk.testCases(key, filters),
    queryFn: () => unwrap(api.GET('/projects/{key}/test-cases', { params: { path: { key }, query: { ...filters, limit: 200 } } })),
    placeholderData: keepPreviousData,
    enabled: !!key,
  })
}

export function useTestCase(caseKey: string) {
  return useQuery({ queryKey: qk.testCase(caseKey), queryFn: () => unwrap(api.GET('/test-cases/{caseKey}', { params: { path: { caseKey } } })) })
}

export function useCreateTestCase(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TestCaseInput) => unwrap(api.POST('/projects/{key}/test-cases', { params: { path: { key } }, body })),
    onSuccess: (tc) => {
      qc.setQueryData(qk.testCase(tc.key), tc)
      invalidateProject(qc, key)
    },
  })
}

export function useUpdateTestCase(caseKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: TestCaseInput & { revision: number; change_note?: string }) =>
      unwrap(api.PATCH('/test-cases/{caseKey}', { params: { path: { caseKey } }, body })),
    onSuccess: (tc) => {
      qc.setQueryData(qk.testCase(caseKey), tc)
      qc.invalidateQueries({ queryKey: qk.revisions(caseKey) })
      invalidateProject(qc, projectOf(caseKey))
    },
  })
}

export function useValidateTestCase(key: string) {
  return useMutation({
    mutationFn: (body: TestCaseInput) => unwrap(api.POST('/projects/{key}/test-cases/validate', { params: { path: { key } }, body })),
  })
}

export function useDeleteTestCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (caseKey: string) => unwrap(api.DELETE('/test-cases/{caseKey}', { params: { path: { caseKey } } })),
    onSuccess: (_d, caseKey) => {
      qc.removeQueries({ queryKey: qk.testCase(caseKey) })
      invalidateProject(qc, projectOf(caseKey))
    },
  })
}

export function useDuplicateTestCase() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (caseKey: string) => unwrap(api.POST('/test-cases/{caseKey}/duplicate', { params: { path: { caseKey } } })),
    onSuccess: (tc) => invalidateProject(qc, projectOf(tc.key)),
  })
}

export function useBulkTestCases(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: BulkTestCaseAction) => unwrap(api.POST('/projects/{key}/test-cases/bulk', { params: { path: { key } }, body })),
    onSuccess: () => {
      invalidateProject(qc, key)
      qc.invalidateQueries({ queryKey: ['test-cases'] })
    },
  })
}

export function useRevisions(caseKey: string, enabled = true) {
  return useQuery({
    queryKey: qk.revisions(caseKey),
    queryFn: () => unwrap(api.GET('/test-cases/{caseKey}/revisions', { params: { path: { caseKey } } })),
    enabled,
  })
}

export function useRevision(caseKey: string, rev: number | null) {
  return useQuery({
    queryKey: qk.revision(caseKey, rev ?? 0),
    queryFn: () => unwrap(api.GET('/test-cases/{caseKey}/revisions/{rev}', { params: { path: { caseKey, rev: rev! } } })),
    enabled: rev != null,
  })
}

/* ------------------------------------------------------------------ flows */

export function useFlows(key: string, q?: string) {
  return useQuery({
    queryKey: qk.flows(key, q),
    queryFn: () => unwrap(api.GET('/projects/{key}/flows', { params: { path: { key }, query: q ? { q } : {} } })),
    enabled: !!key,
  })
}

export function useFlow(flowKey: string) {
  return useQuery({ queryKey: qk.flow(flowKey), queryFn: () => unwrap(api.GET('/flows/{flowKey}', { params: { path: { flowKey } } })) })
}

export function useCreateFlow(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FlowInput) => unwrap(api.POST('/projects/{key}/flows', { params: { path: { key } }, body })),
    onSuccess: (f) => {
      qc.setQueryData(qk.flow(f.key), f)
      invalidateProject(qc, key)
    },
  })
}

export function useUpdateFlow(flowKey: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: FlowInput & { revision: number }) => unwrap(api.PATCH('/flows/{flowKey}', { params: { path: { flowKey } }, body })),
    onSuccess: (f) => {
      qc.setQueryData(qk.flow(flowKey), f)
      invalidateProject(qc, projectOf(flowKey))
    },
  })
}

export function useDeleteFlow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (flowKey: string) => unwrap(api.DELETE('/flows/{flowKey}', { params: { path: { flowKey } } })),
    onSuccess: (_d, flowKey) => invalidateProject(qc, projectOf(flowKey)),
  })
}

/* ------------------------------------------------------------------ runs */

export interface RunFilters {
  status?: RunStatus
  target?: string
  kind?: RunKind
  trigger?: RunTrigger
  from?: string
  to?: string
}

export function useRuns(key: string, filters: RunFilters = {}, opts: { limit?: number; live?: boolean } = {}) {
  return useQuery({
    queryKey: qk.runs(key, { ...filters, limit: opts.limit }),
    queryFn: () => unwrap(api.GET('/projects/{key}/runs', { params: { path: { key }, query: { ...filters, limit: opts.limit ?? 100 } } })),
    placeholderData: keepPreviousData,
    refetchInterval: opts.live === false ? false : 5_000,
  })
}

const ACTIVE: RunStatus[] = ['queued', 'running']

/**
 * Progres run. Phase 1: polling saat run aktif (MSW mensimulasikan progres).
 * Phase 3: diganti SSE /runs/{key}/events tanpa mengubah komponen pemakai.
 */
/**
 * Progres run. Mode mock: polling. Mode real: SSE `/runs/{key}/events` meng-invalidate query
 * (polling tetap aktif sebagai fallback yang lebih jarang).
 */
export function useRunProgress(runKey: string) {
  const qc = useQueryClient()
  React.useEffect(() => {
    if (IS_MOCK || !runKey || typeof EventSource === 'undefined') return
    const es = new EventSource(`${API_BASE}/runs/${encodeURIComponent(runKey)}/events`, { withCredentials: true })
    const refresh = () => {
      void qc.invalidateQueries({ queryKey: qk.run(runKey) })
    }
    es.onmessage = refresh
    for (const type of ['run_started', 'case_started', 'step_started', 'step_finished', 'case_finished', 'awaiting_manual', 'run_finished', 'run_updated']) {
      es.addEventListener(type, refresh)
    }
    return () => es.close()
  }, [qc, runKey])
  return useQuery({
    queryKey: qk.run(runKey),
    queryFn: () => unwrap(api.GET('/runs/{runKey}', { params: { path: { runKey } } })),
    refetchInterval: (q) => {
      const s = q.state.data?.status
      if (!s) return false
      if (ACTIVE.includes(s)) return IS_MOCK ? 700 : 3000
      if (s === 'awaiting_manual') return 4000
      return false
    },
  })
}

/** JUnit XML of a final run (GET /runs/{runKey}/junit.xml); not final yet → ApiError 409. */
export function useRunJUnit() {
  return useMutation({
    mutationFn: (runKey: string) => unwrap(api.GET('/runs/{runKey}/junit.xml', { params: { path: { runKey } }, parseAs: 'text' })),
  })
}

export function useCreateRun(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (body: RunCreate) => unwrap(api.POST('/projects/{key}/runs', { params: { path: { key } }, body })),
    onSuccess: (run) => {
      qc.setQueryData(qk.run(run.key), run)
      invalidateProject(qc, key)
      qc.invalidateQueries({ queryKey: qk.myManualRuns })
    },
  })
}

function useRunMutation<V>(fn: (v: V) => Promise<import('./types').Run>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: fn,
    onSuccess: (run) => {
      qc.setQueryData(qk.run(run.key), run)
      invalidateProject(qc, run.project_key)
      qc.invalidateQueries({ queryKey: qk.myManualRuns })
    },
  })
}

export function useCancelRun() {
  return useRunMutation((runKey: string) => unwrap(api.POST('/runs/{runKey}/cancel', { params: { path: { runKey } } })))
}

export function useRerun() {
  return useRunMutation(({ runKey, only_failed }: { runKey: string; only_failed?: boolean }) =>
    unwrap(api.POST('/runs/{runKey}/rerun', { params: { path: { runKey } }, body: { only_failed } })),
  )
}

export function useSetAssignee() {
  return useRunMutation(({ runKey, user_id }: { runKey: string; user_id: string }) =>
    unwrap(api.PATCH('/runs/{runKey}/assignee', { params: { path: { runKey } }, body: { user_id } })),
  )
}

export function useManualStepResult() {
  return useRunMutation(
    ({ runKey, caseId, stepId, status, actual_result }: {
      runKey: string
      caseId: string
      stepId: string
      status: 'pending' | 'passed' | 'failed' | 'blocked' | 'skipped'
      actual_result?: string
    }) =>
      unwrap(
        api.PUT('/runs/{runKey}/cases/{caseId}/steps/{stepId}/manual-result', {
          params: { path: { runKey, caseId, stepId } },
          body: { status, actual_result },
        }),
      ),
  )
}

export function useCompleteManualCase() {
  return useRunMutation(({ runKey, caseId }: { runKey: string; caseId: string }) =>
    unwrap(api.POST('/runs/{runKey}/cases/{caseId}/complete-manual', { params: { path: { runKey, caseId } } })),
  )
}

export function useUploadAttachment() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ runKey, caseId, file, stepId }: { runKey: string; caseId: string; file: File; stepId?: string }) => {
      const form = new FormData()
      form.append('file', file)
      if (stepId) form.append('run_step_id', stepId)
      const res = await fetch(`${API_BASE}/runs/${runKey}/cases/${caseId}/attachments`, { method: 'POST', body: form, headers: CSRF_HEADERS })
      const json = await res.json().catch(() => undefined)
      if (!res.ok) throw new ApiError(res.status, json)
      return json as import('./types').Artifact
    },
    onSuccess: (_a, v) => qc.invalidateQueries({ queryKey: qk.run(v.runKey) }),
  })
}
