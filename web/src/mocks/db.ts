import type {
  ApiToken,
  Artifact,
  Counts,
  Environment,
  Execution,
  Flow,
  FlowSummary,
  Folder,
  Me,
  Member,
  Priority,
  Project,
  ProjectRole,
  ProjectSummary,
  Run,
  RunCase,
  RunKind,
  RunOptions,
  RunStatus,
  RunStep,
  RunSummary,
  RunTrigger,
  Step,
  StepAction,
  StepStatus,
  SystemRole,
  TestCase,
  TestCaseInput,
  TestCaseStatus,
  TestCaseSummary,
  User,
  UserRef,
  UserStatus,
} from '@/api/types'

/* ------------------------------------------------------------------ tabel mock */

export interface DbUser {
  id: string
  email: string
  name: string
  system_role: SystemRole
  status: UserStatus
  password: string | null
  google_linked: boolean
  last_login_at: string | null
  created_at: string
}

export interface DbInvite {
  token: string
  user_id: string
  kind: 'invite' | 'reset_password'
  expires_at: string
  used_at: string | null
}

export interface DbToken extends ApiToken {
  user_id: string
}

export interface DbProject {
  id: string
  key: string
  name: string
  description: string
  archived_at: string | null
  default_run_options: RunOptions
  artifact_retention_days: number
  created_at: string
  seq: { case: number; flow: number; run: number }
}

export interface DbMember {
  project_id: string
  user_id: string
  role: ProjectRole
  added_at: string
}

export interface DbEnvironment {
  id: string
  project_id: string
  name: string
  is_default: boolean
  variables: Record<string, string>
  secrets: { name: string; value: string; updated_at: string }[]
  updated_at: string
}

export interface DbFolder {
  id: string
  project_id: string
  parent_id: string | null
  name: string
  position: number
}

export interface DbTestCase {
  id: string
  project_id: string
  key: string
  folder_id: string | null
  title: string
  description: string
  preconditions: string
  priority: Priority
  status: TestCaseStatus
  execution: Execution
  tags: string[]
  variables: Record<string, string>
  steps: Step[]
  revision: number
  created_at: string
  created_by: string
  updated_at: string
  updated_by: string
  deleted_at: string | null
}

export interface DbRevision {
  test_case_id: string
  revision: number
  author_id: string
  change_note: string
  created_at: string
  snapshot: TestCaseInput
}

export interface DbFlow {
  id: string
  project_id: string
  key: string
  name: string
  description: string
  tags: string[]
  shared_session: boolean
  stop_on_failure: boolean
  variables: Record<string, string>
  items: { id: string; test_case_id: string; continue_on_failure: boolean; enabled: boolean }[]
  revision: number
  created_at: string
  updated_at: string
  deleted_at: string | null
}

/** Hasil simulasi yang sudah ditentukan saat run dibuat. */
export interface SimPlan {
  outcome: 'passed' | 'failed'
  error?: string
  duration_ms: number
}

export interface DbRunStep extends Omit<RunStep, 'screenshot'> {
  screenshot_id: string | null
  sim?: SimPlan
  sim_details?: Record<string, unknown>
  force_screenshot?: boolean
  continue_on_failure?: boolean
  enabled?: boolean
  is_ui: boolean
}

export interface DbRunCase extends Omit<RunCase, 'executed_by' | 'video' | 'attachments' | 'steps'> {
  executed_by_id: string | null
  video_id: string | null
  attachment_ids: string[]
  continue_on_failure: boolean
  steps: DbRunStep[]
}

export interface DbRun {
  id: string
  key: string
  project_id: string
  kind: RunKind
  target_id: string
  target_key: string
  target_title: string
  environment_id: string | null
  environment_name: string | null
  status: RunStatus
  options: RunOptions
  trigger: RunTrigger
  triggered_by_id: string
  assignee_id: string | null
  shared_session: boolean
  stop_on_failure: boolean
  queued_at: string
  started_at: string | null
  finished_at: string | null
  error_message: string | null
  cancel_requested: boolean
  resume_position: number | null
  cases: DbRunCase[]
}

export interface DbArtifact {
  id: string
  project_id: string
  run_id: string
  run_case_id: string | null
  run_step_id: string | null
  kind: Artifact['kind']
  name: string
  url: string
  mime: string
  size_bytes: number
  uploaded_by: string | null
  created_at: string
  expired: boolean
}

export interface MockState {
  version: number
  session: { user_id: string } | null
  users: DbUser[]
  invites: DbInvite[]
  tokens: DbToken[]
  projects: DbProject[]
  members: DbMember[]
  environments: DbEnvironment[]
  folders: DbFolder[]
  testCases: DbTestCase[]
  revisions: DbRevision[]
  flows: DbFlow[]
  runs: DbRun[]
  artifacts: DbArtifact[]
  sim: { speed: number }
}

export const STATE_VERSION = 3
const STORAGE_KEY = 'qatlas.mock.db'

/* ------------------------------------------------------------------ persistence */

let state: MockState | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
let seedFn: (() => MockState) | null = null

export function setState(s: MockState) {
  state = s
}

export function registerSeed(fn: () => MockState) {
  seedFn = fn
}

export function db(): MockState {
  if (state) return state
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as MockState
      if (parsed.version === STATE_VERSION) {
        state = parsed
        return state
      }
    }
  } catch {
    // localStorage bisa tidak tersedia / rusak → seed ulang
  }
  if (!seedFn) throw new Error('Mock seed belum diregistrasi')
  state = seedFn()
  persistNow()
  return state
}

export function persist() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    persistNow()
  }, 150)
}

if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => persistNow())
}

/** Simpan sekarang juga (dipakai setelah mutasi API agar reload langsung tidak kehilangan data). */
export function persistNow() {
  try {
    if (state) localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // quota penuh / private mode — data tetap ada di memori
  }
}

export function resetDb() {
  if (!seedFn) return
  const session = state?.session ?? null
  state = seedFn()
  state.session = session && state.users.some((u) => u.id === session.user_id) ? session : null
  persistNow()
}

/* ------------------------------------------------------------------ helper */

export function nowIso(): string {
  return new Date().toISOString()
}

let idCounter = 0
export function newId(prefix: string): string {
  idCounter += 1
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

export function userRef(id: string | null | undefined): UserRef {
  const u = db().users.find((x) => x.id === id)
  return u ? { id: u.id, name: u.name, email: u.email } : { id: id ?? 'unknown', name: 'Pengguna terhapus', email: '' }
}

export function toUser(u: DbUser): User {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    system_role: u.system_role,
    status: u.status,
    has_password: !!u.password,
    google_linked: u.google_linked,
    last_login_at: u.last_login_at,
    created_at: u.created_at,
  }
}

export function currentUser(): DbUser | null {
  const s = db().session
  if (!s) return null
  const u = db().users.find((x) => x.id === s.user_id)
  return u && u.status === 'active' ? u : null
}

/** Role efektif user di project. Admin tanpa membership diperlakukan sebagai maintainer. */
export function roleIn(user: DbUser, projectId: string): ProjectRole | null {
  const m = db().members.find((x) => x.project_id === projectId && x.user_id === user.id)
  if (m) return m.role
  return user.system_role === 'admin' ? 'maintainer' : null
}

export function visibleProjects(user: DbUser): DbProject[] {
  return db().projects.filter((p) => roleIn(user, p.id) !== null)
}

export function toMe(u: DbUser): Me {
  return {
    user: toUser(u),
    projects: visibleProjects(u)
      .filter((p) => !p.archived_at)
      .map((p) => ({ key: p.key, name: p.name, role: roleIn(u, p.id)! })),
  }
}

export function toProject(p: DbProject, user: DbUser): Project {
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    archived_at: p.archived_at,
    my_role: roleIn(user, p.id) ?? 'viewer',
    default_run_options: p.default_run_options,
    artifact_retention_days: p.artifact_retention_days,
    created_at: p.created_at,
  }
}

export function projectRuns(projectId: string): DbRun[] {
  return db()
    .runs.filter((r) => r.project_id === projectId)
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))
}

export function toProjectSummary(p: DbProject, user: DbUser): ProjectSummary {
  const runs = projectRuns(p.id)
  const weekAgo = Date.now() - 7 * 86400_000
  const recent = runs.filter((r) => Date.parse(r.queued_at) >= weekAgo && isFinal(r.status) && r.status !== 'cancelled')
  return {
    id: p.id,
    key: p.key,
    name: p.name,
    description: p.description,
    archived_at: p.archived_at,
    my_role: roleIn(user, p.id) ?? 'viewer',
    test_case_count: db().testCases.filter((t) => t.project_id === p.id && !t.deleted_at).length,
    flow_count: db().flows.filter((f) => f.project_id === p.id && !f.deleted_at).length,
    pass_rate_7d: recent.length ? recent.filter((r) => r.status === 'passed').length / recent.length : null,
    last_run: runs[0] ? toRunSummary(runs[0]) : null,
  }
}

export function toMember(m: DbMember): Member {
  return { user: userRef(m.user_id), role: m.role, added_at: m.added_at }
}

export function toEnvironment(e: DbEnvironment): Environment {
  return {
    id: e.id,
    name: e.name,
    is_default: e.is_default,
    variables: e.variables,
    secrets: e.secrets.map((s) => ({ name: s.name, updated_at: s.updated_at })),
    updated_at: e.updated_at,
  }
}

export function toFolder(f: DbFolder): Folder {
  return {
    id: f.id,
    parent_id: f.parent_id,
    name: f.name,
    position: f.position,
    test_case_count: db().testCases.filter((t) => t.folder_id === f.id && !t.deleted_at).length,
  }
}

function lastRunFor(targetId: string): DbRun | undefined {
  return db()
    .runs.filter((r) => r.target_id === targetId || r.cases.some((c) => c.test_case_id === targetId && r.kind === 'test_case'))
    .sort((a, b) => b.queued_at.localeCompare(a.queued_at))[0]
}

export function toTestCaseSummary(t: DbTestCase): TestCaseSummary {
  const last = lastRunFor(t.id)
  return {
    id: t.id,
    key: t.key,
    folder_id: t.folder_id,
    title: t.title,
    priority: t.priority,
    status: t.status,
    execution: t.execution,
    tags: t.tags,
    step_count: t.steps.length,
    revision: t.revision,
    last_run_status: last?.status ?? null,
    last_run_at: last?.queued_at ?? null,
    updated_at: t.updated_at,
    updated_by: userRef(t.updated_by),
  }
}

export function toTestCase(t: DbTestCase): TestCase {
  const p = db().projects.find((x) => x.id === t.project_id)!
  return {
    ...toTestCaseSummary(t),
    project_key: p.key,
    description: t.description,
    preconditions: t.preconditions,
    variables: t.variables,
    steps: t.steps,
    created_at: t.created_at,
    created_by: userRef(t.created_by),
  }
}

export function testCaseInput(t: DbTestCase): TestCaseInput {
  return {
    folder_id: t.folder_id,
    title: t.title,
    description: t.description,
    preconditions: t.preconditions,
    priority: t.priority,
    status: t.status,
    execution: t.execution,
    tags: t.tags,
    variables: t.variables,
    steps: t.steps,
  }
}

export function toFlowSummary(f: DbFlow): FlowSummary {
  const last = lastRunFor(f.id)
  return {
    id: f.id,
    key: f.key,
    name: f.name,
    description: f.description,
    tags: f.tags,
    shared_session: f.shared_session,
    stop_on_failure: f.stop_on_failure,
    item_count: f.items.length,
    has_manual: f.items.some((i) => db().testCases.find((t) => t.id === i.test_case_id)?.execution === 'manual'),
    last_run_status: last?.status ?? null,
    last_run_at: last?.queued_at ?? null,
    updated_at: f.updated_at,
  }
}

export function toFlow(f: DbFlow): Flow {
  const p = db().projects.find((x) => x.id === f.project_id)!
  return {
    ...toFlowSummary(f),
    project_key: p.key,
    variables: f.variables,
    revision: f.revision,
    items: f.items.map((i) => {
      const t = db().testCases.find((x) => x.id === i.test_case_id)
      return {
        id: i.id,
        continue_on_failure: i.continue_on_failure,
        enabled: i.enabled,
        test_case: t
          ? { id: t.id, key: t.key, title: t.title, execution: t.execution, status: t.status, step_count: t.steps.length }
          : { id: i.test_case_id, key: '?', title: 'Test case terhapus', execution: 'automated', status: 'deprecated', step_count: 0 },
      }
    }),
  }
}

/* ------------------------------------------------------------------ runs */

export function isFinal(s: RunStatus): boolean {
  return s === 'passed' || s === 'failed' || s === 'blocked' || s === 'error' || s === 'cancelled'
}

const emptyCounts = (): Counts => ({ total: 0, passed: 0, failed: 0, blocked: 0, skipped: 0, other: 0 })

function bump(c: Counts, s: StepStatus) {
  c.total += 1
  if (s === 'passed') c.passed += 1
  else if (s === 'failed' || s === 'error') c.failed += 1
  else if (s === 'blocked') c.blocked += 1
  else if (s === 'skipped') c.skipped += 1
  else c.other += 1
}

export function runCounts(r: DbRun): { cases: Counts; steps: Counts } {
  const cases = emptyCounts()
  const steps = emptyCounts()
  for (const c of r.cases) {
    bump(cases, c.status)
    for (const s of c.steps) bump(steps, s.status)
  }
  return { cases, steps }
}

export function toArtifact(id: string | null): Artifact | null {
  if (!id) return null
  const a = db().artifacts.find((x) => x.id === id)
  if (!a) return null
  return {
    id: a.id,
    kind: a.kind,
    name: a.name,
    url: a.url,
    mime: a.mime,
    size_bytes: a.size_bytes,
    expired: a.expired,
    run_step_id: a.run_step_id,
    created_at: a.created_at,
  }
}

export function toRunSummary(r: DbRun): RunSummary {
  const p = db().projects.find((x) => x.id === r.project_id)
  return {
    id: r.id,
    key: r.key,
    project_key: p?.key ?? '?',
    kind: r.kind,
    target: { id: r.target_id, key: r.target_key, title: r.target_title },
    environment: r.environment_id ? { id: r.environment_id, name: r.environment_name ?? '' } : null,
    status: r.status,
    trigger: r.trigger,
    triggered_by: userRef(r.triggered_by_id),
    assignee: r.assignee_id ? userRef(r.assignee_id) : null,
    has_manual: r.cases.some((c) => c.execution === 'manual'),
    summary: runCounts(r),
    queued_at: r.queued_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.started_at
      ? (r.finished_at ? Date.parse(r.finished_at) : Date.now()) - Date.parse(r.started_at)
      : null,
  }
}

export function toRun(r: DbRun): Run {
  return {
    ...toRunSummary(r),
    options: r.options,
    shared_session: r.shared_session,
    stop_on_failure: r.stop_on_failure,
    error_message: r.error_message,
    cancel_requested: r.cancel_requested,
    resume_position: r.resume_position,
    cases: r.cases.map((c) => ({
      id: c.id,
      position: c.position,
      test_case_id: c.test_case_id,
      test_case_key: c.test_case_key,
      test_case_revision: c.test_case_revision,
      title: c.title,
      execution: c.execution,
      status: c.status,
      executed_by: c.executed_by_id ? userRef(c.executed_by_id) : null,
      started_at: c.started_at,
      finished_at: c.finished_at,
      duration_ms: c.duration_ms,
      video: toArtifact(c.video_id),
      attachments: c.attachment_ids.map((id) => toArtifact(id)).filter((a): a is Artifact => a !== null),
      steps: c.steps.map((s) => ({
        id: s.id,
        position: s.position,
        step_id: s.step_id,
        action: s.action as StepAction,
        summary: s.summary,
        description: s.description,
        expected: s.expected,
        status: s.status,
        duration_ms: s.duration_ms,
        error_message: s.error_message,
        actual_result: s.actual_result,
        screenshot: toArtifact(s.screenshot_id),
        details: s.details,
      })),
    })),
  }
}
