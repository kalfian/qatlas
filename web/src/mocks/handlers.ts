import { delay, http, HttpResponse, type HttpResponseResolver } from 'msw'
import type {
  ApiTokenCreate,
  BulkTestCaseAction,
  EnvironmentInput,
  FieldError,
  FlowInput,
  GoogleAuthSettingsInput,
  ProjectRole,
  RunCreate,
  RunOptions,
  RunStatus,
  StorageSettingsInput,
  SystemRole,
  TestCaseInput,
} from '@/api/types'
import { can, type ProjectAction } from '@/lib/permissions'
import { validateSteps } from '@/lib/steps'
import {
  activeStorageBackend,
  currentUser,
  db,
  googleAuthState,
  storageState,
  isFinal,
  newId,
  nowIso,
  persistNow,
  projectRuns,
  resetDb,
  roleIn,
  testCaseInput,
  toEnvironment,
  toFlow,
  toFlowSummary,
  toFolder,
  toMe,
  toMember,
  toProject,
  toProjectSummary,
  toRun,
  toRunSummary,
  toTestCase,
  toTestCaseSummary,
  toUser,
  userRef,
  type DbProject,
  type DbRun,
  type DbTestCase,
  type DbUser,
} from './db'
import { junitFilename, runToJUnit } from './junit'
import { DEFAULT_RUN_OPTIONS } from './seed'
import { completeManualCase, createRun } from './simulator'
import { googleAllowedDomains, googleEnabled, removeGoogleAuth, saveGoogleAuth, toGoogleAuthSettings } from './google-auth'
import { probeFailureDetails, probeStorage, saveStorage, startMigration, toStorageSettings, validateStorageInput } from './storage'

const API = '/api/v1'

/* ------------------------------------------------------------------ helpers */

function fail(status: number, code: string, message: string, details?: FieldError[]): never {
  throw HttpResponse.json({ error: { code, message, ...(details ? { details } : {}) } }, { status })
}

function requireUser(): DbUser {
  const u = currentUser()
  if (!u) fail(401, 'unauthenticated', 'Your session has expired. Please sign in again.')
  return u
}

function requireAdmin(): DbUser {
  const u = requireUser()
  if (u.system_role !== 'admin') fail(403, 'forbidden', 'Only admins can do this')
  return u
}

function projectByKey(key: string): DbProject {
  const p = db().projects.find((x) => x.key === key.toUpperCase())
  if (!p) fail(404, 'not_found', `Project ${key} not found`)
  return p
}

function requireProject(key: string, action: ProjectAction = 'view'): { user: DbUser; project: DbProject; role: ProjectRole } {
  const user = requireUser()
  const project = projectByKey(key)
  const role = roleIn(user, project.id)
  if (!role) fail(404, 'not_found', `Project ${key} not found`)
  if (!can(role, action, user.system_role)) fail(403, 'forbidden', 'Your role does not allow this action')
  return { user, project, role }
}

function projectOfKey(entityKey: string): string {
  return entityKey.split('-')[0]
}

function findTestCase(caseKey: string, action: ProjectAction = 'view') {
  const ctx = requireProject(projectOfKey(caseKey), action)
  const tc = db().testCases.find((t) => t.key === caseKey && !t.deleted_at)
  if (!tc) fail(404, 'not_found', `Test case ${caseKey} not found`)
  return { ...ctx, tc }
}

function findFlow(flowKey: string, action: ProjectAction = 'view') {
  const ctx = requireProject(projectOfKey(flowKey), action)
  const flow = db().flows.find((f) => f.key === flowKey && !f.deleted_at)
  if (!flow) fail(404, 'not_found', `Flow ${flowKey} not found`)
  return { ...ctx, flow }
}

function findRun(runKey: string, action: ProjectAction = 'view') {
  const ctx = requireProject(projectOfKey(runKey), action)
  const run = db().runs.find((r) => r.key === runKey)
  if (!run) fail(404, 'not_found', `Run ${runKey} not found`)
  return { ...ctx, run }
}

async function body<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T
  } catch {
    return {} as T
  }
}

/** Bungkus resolver: latensi realistis + simpan state setelah mutasi. */
function r(resolver: HttpResponseResolver, opts: { mutate?: boolean; latency?: number } = {}): HttpResponseResolver {
  return async (info) => {
    await delay(opts.latency ?? 80 + Math.random() * 140)
    const res = await resolver(info)
    if (opts.mutate) persistNow()
    return res
  }
}
const m = (resolver: HttpResponseResolver) => r(resolver, { mutate: true })

const noContent = () => new HttpResponse(null, { status: 204 })

function page<T>(items: T[], url: URL) {
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200)
  const cursor = Number(url.searchParams.get('cursor') ?? 0)
  const slice = items.slice(cursor, cursor + limit)
  return { data: slice, next_cursor: cursor + limit < items.length ? String(cursor + limit) : null }
}

function validateInput(input: TestCaseInput): { errors: FieldError[]; warnings: FieldError[] } {
  const errors: FieldError[] = []
  if (!input.title?.trim()) errors.push({ path: 'title', message: 'Title is required' })
  const v = validateSteps(input.steps ?? [], input.execution ?? 'automated', { lng: 'en' })
  return { errors: [...errors, ...v.errors], warnings: v.warnings }
}

function snapshotRevision(tc: DbTestCase, authorId: string, note: string) {
  db().revisions.push({ test_case_id: tc.id, revision: tc.revision, author_id: authorId, change_note: note, created_at: nowIso(), snapshot: testCaseInput(tc) })
}

function mergeOptions(project: DbProject, partial?: Partial<RunOptions>): RunOptions {
  return { ...DEFAULT_RUN_OPTIONS, ...project.default_run_options, ...(partial ?? {}) }
}

function flowValidation(input: FlowInput): FieldError[] {
  const errors: FieldError[] = []
  if (!input.name?.trim()) errors.push({ path: 'name', message: 'Flow name is required' })
  if (!input.items?.length) errors.push({ path: 'items', message: 'A flow needs at least 1 test case' })
  input.items?.forEach((it, i) => {
    const tc = db().testCases.find((t) => t.id === it.test_case_id && !t.deleted_at)
    if (!tc) errors.push({ path: `items[${i}]`, message: 'Test case not found' })
    else if (input.shared_session && tc.execution === 'manual')
      errors.push({ path: `items[${i}]`, message: `Manual test case ${tc.key} can't be in a flow with a shared session` })
  })
  return errors
}

/* ------------------------------------------------------------------ handlers */

export const handlers = [
  // ---------- mock-only (tidak ada di OpenAPI)
  http.post(`${API}/__mock/google-login`, m(async ({ request }) => {
    const { email } = await body<{ email: string }>(request)
    if (!googleEnabled()) fail(409, 'google_disabled', 'Google sign-in is turned off')
    const allowed = googleAllowedDomains()
    if (allowed.length && !allowed.includes(email.split('@')[1]?.toLowerCase() ?? ''))
      fail(403, 'domain_not_allowed', "This Google account's domain isn't allowed. Ask an admin.")
    const u = db().users.find((x) => x.email.toLowerCase() === email.toLowerCase())
    if (!u || u.status === 'disabled') fail(403, 'not_registered', "This Google account isn't registered. Ask an admin for an invite.")
    u.google_linked = true
    if (u.status === 'invited') {
      u.status = 'active'
      for (const inv of db().invites) if (inv.user_id === u.id && !inv.used_at) inv.used_at = nowIso()
    }
    u.last_login_at = nowIso()
    db().session = { user_id: u.id }
    return HttpResponse.json(toMe(u))
  })),
  http.post(`${API}/__mock/switch-user`, m(async ({ request }) => {
    const { user_id } = await body<{ user_id: string }>(request)
    const u = db().users.find((x) => x.id === user_id && x.status === 'active')
    if (!u) fail(404, 'not_found', 'User is not active')
    db().session = { user_id: u.id }
    return HttpResponse.json(toMe(u))
  })),
  http.post(`${API}/__mock/reset`, m(() => {
    resetDb()
    return noContent()
  })),

  // ---------- auth
  http.get(`${API}/auth/config`, r(() => HttpResponse.json({ google_enabled: googleEnabled(), mode: 'mock' }), { latency: 20 })),
  http.post(`${API}/auth/login`, m(async ({ request }) => {
    const { email, password } = await body<{ email: string; password: string }>(request)
    const u = db().users.find((x) => x.email.toLowerCase() === (email ?? '').toLowerCase())
    if (!u || !u.password || u.password !== password || u.status !== 'active') {
      fail(401, 'invalid_credentials', 'Incorrect email or password.')
    }
    u.last_login_at = nowIso()
    db().session = { user_id: u.id }
    return HttpResponse.json(toMe(u))
  })),
  http.post(`${API}/auth/logout`, m(() => {
    db().session = null
    return noContent()
  })),
  http.get(`${API}/auth/invites/:token`, r(({ params }) => {
    const inv = db().invites.find((x) => x.token === params.token)
    if (!inv) fail(404, 'not_found', 'Invalid invite link')
    if (inv.used_at || Date.parse(inv.expires_at) < Date.now()) fail(410, 'expired', 'This invite link has already been used or has expired')
    const u = db().users.find((x) => x.id === inv.user_id)!
    return HttpResponse.json({ email: u.email, name: u.name, kind: inv.kind, expires_at: inv.expires_at })
  })),
  http.post(`${API}/auth/invites/:token/accept`, m(async ({ params, request }) => {
    const { password } = await body<{ password: string }>(request)
    const inv = db().invites.find((x) => x.token === params.token)
    if (!inv || inv.used_at || Date.parse(inv.expires_at) < Date.now()) fail(410, 'expired', 'This invite link has already been used or has expired')
    if (!password || password.length < 8) fail(400, 'validation_failed', 'Password must be at least 8 characters', [{ path: 'password', message: 'At least 8 characters' }])
    const u = db().users.find((x) => x.id === inv.user_id)!
    u.password = password
    u.status = 'active'
    u.last_login_at = nowIso()
    inv.used_at = nowIso()
    db().session = { user_id: u.id }
    return HttpResponse.json(toMe(u))
  })),

  // ---------- me
  http.get(`${API}/me`, r(() => HttpResponse.json(toMe(requireUser())), { latency: 40 })),
  http.patch(`${API}/me`, m(async ({ request }) => {
    const u = requireUser()
    const b = await body<{ name?: string; locale?: 'en' | 'id'; current_password?: string; new_password?: string }>(request)
    if (b.locale === 'en' || b.locale === 'id') u.locale = b.locale
    if (b.name !== undefined) {
      if (!b.name.trim()) fail(400, 'validation_failed', 'Name is required', [{ path: 'name', message: 'Required' }])
      u.name = b.name.trim()
    }
    if (b.new_password !== undefined) {
      if (u.password && u.password !== b.current_password) fail(400, 'validation_failed', 'Current password is incorrect', [{ path: 'current_password', message: 'Current password is incorrect' }])
      if (b.new_password.length < 8) fail(400, 'validation_failed', 'Password must be at least 8 characters', [{ path: 'new_password', message: 'At least 8 characters' }])
      u.password = b.new_password
    }
    return HttpResponse.json(toMe(u))
  })),
  http.get(`${API}/me/tokens`, r(() => {
    const u = requireUser()
    const data = db().tokens.filter((t) => t.user_id === u.id).map(({ user_id: _u, ...t }) => t)
    return HttpResponse.json({ data: data.sort((a, b) => b.created_at.localeCompare(a.created_at)) })
  })),
  http.post(`${API}/me/tokens`, m(async ({ request }) => {
    const u = requireUser()
    const b = await body<ApiTokenCreate>(request)
    if (!b.name?.trim()) fail(400, 'validation_failed', 'Token name is required', [{ path: 'name', message: 'Required' }])
    if (!b.scopes?.length) fail(400, 'validation_failed', 'Select at least one scope', [{ path: 'scopes', message: 'Select at least one' }])
    const rnd = (n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (x) => x.toString(16).padStart(2, '0')).join('')
    const prefix = `qat_${rnd(4)}`
    const secret = `${prefix}_${rnd(16)}`
    const token = {
      id: newId('tok'),
      user_id: u.id,
      name: b.name.trim(),
      prefix,
      scopes: b.scopes,
      project_keys: b.project_keys?.length ? b.project_keys : null,
      expires_at: b.expires_in_days ? new Date(Date.now() + b.expires_in_days * 86400_000).toISOString() : null,
      last_used_at: null,
      created_at: nowIso(),
      revoked_at: null,
    }
    db().tokens.push(token)
    const { user_id: _u, ...pub } = token
    return HttpResponse.json({ token: pub, secret }, { status: 201 })
  })),
  http.delete(`${API}/me/tokens/:id`, m(({ params }) => {
    const u = requireUser()
    const t = db().tokens.find((x) => x.id === params.id && x.user_id === u.id)
    if (!t) fail(404, 'not_found', 'Token not found')
    t.revoked_at = nowIso()
    return noContent()
  })),
  http.get(`${API}/me/manual-runs`, r(() => {
    const u = requireUser()
    const data = db()
      .runs.filter((x) => x.status === 'awaiting_manual' && x.assignee_id === u.id && roleIn(u, x.project_id))
      .sort((a, b) => a.queued_at.localeCompare(b.queued_at))
      .map(toRunSummary)
    return HttpResponse.json({ data })
  })),

  // ---------- admin
  http.get(`${API}/admin/users`, r(() => {
    requireAdmin()
    return HttpResponse.json({ data: db().users.map(toUser).sort((a, b) => a.name.localeCompare(b.name)) })
  })),
  http.post(`${API}/admin/users`, m(async ({ request }) => {
    requireAdmin()
    const b = await body<{ email: string; name: string; system_role: SystemRole }>(request)
    const email = (b.email ?? '').trim().toLowerCase()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(400, 'validation_failed', 'Invalid email', [{ path: 'email', message: 'Invalid email' }])
    if (!b.name?.trim()) fail(400, 'validation_failed', 'Name is required', [{ path: 'name', message: 'Required' }])
    if (db().users.some((x) => x.email === email)) fail(409, 'conflict', 'Email is already registered', [{ path: 'email', message: 'Email is already registered' }])
    const user: DbUser = { id: newId('u'), email, name: b.name.trim(), system_role: b.system_role ?? 'member', status: 'invited', password: null, google_linked: false, last_login_at: null, created_at: nowIso() }
    db().users.push(user)
    const token = newId('inv')
    const expires_at = new Date(Date.now() + 72 * 3600_000).toISOString()
    db().invites.push({ token, user_id: user.id, kind: 'invite', expires_at, used_at: null })
    return HttpResponse.json({ user: toUser(user), invite_url: `${location.origin}/invite/${token}`, expires_at }, { status: 201 })
  })),
  http.patch(`${API}/admin/users/:id`, m(async ({ params, request }) => {
    const admin = requireAdmin()
    const u = db().users.find((x) => x.id === params.id)
    if (!u) fail(404, 'not_found', 'User not found')
    const b = await body<{ name?: string; system_role?: SystemRole; status?: 'active' | 'disabled' }>(request)
    if (u.id === admin.id && (b.status === 'disabled' || b.system_role === 'member')) fail(400, 'validation_failed', "You can't disable or demote your own account")
    if (b.name) u.name = b.name
    if (b.system_role) u.system_role = b.system_role
    if (b.status) {
      if (b.status === 'active' && u.status === 'invited') fail(400, 'validation_failed', 'Invited users become active once they accept the invite')
      u.status = b.status
      if (b.status === 'disabled') for (const t of db().tokens) if (t.user_id === u.id && !t.revoked_at) t.revoked_at = nowIso()
    }
    return HttpResponse.json(toUser(u))
  })),
  http.post(`${API}/admin/users/:id/invite-link`, m(({ params }) => {
    requireAdmin()
    const u = db().users.find((x) => x.id === params.id)
    if (!u) fail(404, 'not_found', 'User not found')
    if (u.status === 'disabled') fail(400, 'validation_failed', 'User is disabled')
    for (const inv of db().invites) if (inv.user_id === u.id && !inv.used_at) inv.used_at = nowIso()
    const token = newId('inv')
    const expires_at = new Date(Date.now() + 72 * 3600_000).toISOString()
    db().invites.push({ token, user_id: u.id, kind: u.status === 'invited' ? 'invite' : 'reset_password', expires_at, used_at: null })
    return HttpResponse.json({ user: toUser(u), invite_url: `${location.origin}/invite/${token}`, expires_at })
  })),

  // ---------- admin: Google sign-in (lihat mocks/google-auth.ts untuk aturan validasi)
  http.get(`${API}/admin/settings/google-auth`, r(() => {
    requireAdmin()
    return HttpResponse.json(toGoogleAuthSettings())
  }, { latency: 60 })),
  http.put(`${API}/admin/settings/google-auth`, m(async ({ request }) => {
    const admin = requireAdmin()
    if (googleAuthState().env_override) fail(409, 'env_override', 'Google sign-in is set by environment variables (GOOGLE_CLIENT_ID); remove them to manage it here')
    const input = await body<GoogleAuthSettingsInput>(request)
    const invalid = saveGoogleAuth(input, admin.id)
    if (invalid.length) fail(422, 'validation_failed', 'Google sign-in settings are invalid', invalid)
    return HttpResponse.json(toGoogleAuthSettings())
  })),
  http.delete(`${API}/admin/settings/google-auth`, m(() => {
    const admin = requireAdmin()
    if (googleAuthState().env_override) fail(409, 'env_override', 'Google sign-in is set by environment variables (GOOGLE_CLIENT_ID); remove them to manage it here')
    removeGoogleAuth(admin.id)
    return HttpResponse.json(toGoogleAuthSettings())
  })),

  // ---------- admin: artifact storage (lihat mocks/storage.ts untuk aturan simulasi)
  http.get(`${API}/admin/settings/storage`, r(() => {
    requireAdmin()
    return HttpResponse.json(toStorageSettings())
  }, { mutate: true, latency: 60 })),
  http.put(`${API}/admin/settings/storage`, r(async ({ request }) => {
    const admin = requireAdmin()
    const st = storageState()
    if (st.env_override) fail(409, 'env_override', 'Storage is set by environment variables (QATLAS_STORAGE); remove them to manage it here')
    const input = await body<StorageSettingsInput>(request)
    const invalid = validateStorageInput(input, st.s3.secret !== null)
    if (invalid.length) fail(422, 'validation_failed', 'Storage settings are invalid', invalid)
    const probe = probeStorage(input, st.s3.secret)
    await delay(probe.latency_ms * 3)
    if (!probe.ok) fail(422, 'storage_check_failed', `Storage check failed: ${probe.message}`, probeFailureDetails(probe))
    saveStorage(input, admin.id)
    return HttpResponse.json(toStorageSettings())
  }, { mutate: true })),
  http.post(`${API}/admin/settings/storage/test`, r(async ({ request }) => {
    requireAdmin()
    const input = await body<StorageSettingsInput>(request)
    const result = probeStorage(input, storageState().s3.secret)
    await delay(result.latency_ms * 3)
    return HttpResponse.json(result)
  })),
  http.post(`${API}/admin/settings/storage/migrate`, m(async ({ request }) => {
    requireAdmin()
    const b = await body<{ delete_source?: boolean }>(request)
    if (!startMigration(b.delete_source === true)) fail(409, 'conflict', 'An artifact migration is already running')
    return HttpResponse.json(toStorageSettings(), { status: 202 })
  })),

  // ---------- projects
  http.get(`${API}/projects`, r(({ request }) => {
    const u = requireUser()
    const includeArchived = new URL(request.url).searchParams.get('include_archived') === 'true'
    const data = db()
      .projects.filter((p) => roleIn(u, p.id) && (includeArchived || !p.archived_at))
      .map((p) => toProjectSummary(p, u))
    return HttpResponse.json({ data })
  })),
  http.post(`${API}/projects`, m(async ({ request }) => {
    const u = requireAdmin()
    const b = await body<{ key: string; name: string; description?: string }>(request)
    const key = (b.key ?? '').toUpperCase()
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(key)) fail(400, 'validation_failed', 'Key must be 2–10 uppercase letters or digits, starting with a letter', [{ path: 'key', message: 'Invalid key format' }])
    if (db().projects.some((p) => p.key === key)) fail(409, 'conflict', `Key ${key} is already taken`, [{ path: 'key', message: 'Key is already taken' }])
    if (!b.name?.trim()) fail(400, 'validation_failed', 'Name is required', [{ path: 'name', message: 'Required' }])
    const p: DbProject = { id: newId('p'), key, name: b.name.trim(), description: b.description ?? '', archived_at: null, default_run_options: { ...DEFAULT_RUN_OPTIONS }, artifact_retention_days: 30, created_at: nowIso(), seq: { case: 0, flow: 0, run: 0 } }
    db().projects.push(p)
    db().members.push({ project_id: p.id, user_id: u.id, role: 'maintainer', added_at: nowIso() })
    db().environments.push({ id: newId('env'), project_id: p.id, name: 'staging', is_default: true, variables: { BASE_URL: 'https://staging.example.com' }, secrets: [], updated_at: nowIso() })
    return HttpResponse.json(toProject(p, u), { status: 201 })
  })),
  http.get(`${API}/projects/:key`, r(({ params }) => {
    const { user, project } = requireProject(params.key as string)
    return HttpResponse.json(toProject(project, user))
  })),
  http.patch(`${API}/projects/:key`, m(async ({ params, request }) => {
    const { user, project } = requireProject(params.key as string, 'manage_settings')
    const b = await body<{ name?: string; description?: string; default_run_options?: RunOptions; artifact_retention_days?: number }>(request)
    if (b.name !== undefined) project.name = b.name
    if (b.description !== undefined) project.description = b.description
    if (b.default_run_options) project.default_run_options = { ...project.default_run_options, ...b.default_run_options }
    if (b.artifact_retention_days) project.artifact_retention_days = b.artifact_retention_days
    return HttpResponse.json(toProject(project, user))
  })),
  http.post(`${API}/projects/:key/archive`, m(({ params }) => {
    const { user, project } = requireProject(params.key as string, 'manage_settings')
    project.archived_at = nowIso()
    return HttpResponse.json(toProject(project, user))
  })),
  http.get(`${API}/projects/:key/stats`, r(({ params, request }) => {
    const { project } = requireProject(params.key as string)
    const range = (new URL(request.url).searchParams.get('range') ?? '7d') as '7d' | '30d'
    const days = range === '30d' ? 30 : 7
    const since = Date.now() - days * 86400_000
    const runs = projectRuns(project.id).filter((x) => Date.parse(x.queued_at) >= since)
    const finals = runs.filter((x) => isFinal(x.status) && x.status !== 'cancelled')
    const daily = Array.from({ length: days }, (_, i) => {
      const date = localDate(new Date(Date.now() - (days - 1 - i) * 86400_000))
      const dayRuns = runs.filter((x) => localDate(new Date(x.queued_at)) === date)
      return {
        date,
        passed: dayRuns.filter((x) => x.status === 'passed').length,
        failed: dayRuns.filter((x) => x.status === 'failed' || x.status === 'error').length,
        other: dayRuns.filter((x) => !['passed', 'failed', 'error'].includes(x.status)).length,
      }
    })
    const failMap = new Map<string, { failures: number; runs: number; title: string }>()
    for (const run of runs) {
      for (const c of run.cases) {
        const e = failMap.get(c.test_case_key) ?? { failures: 0, runs: 0, title: c.title }
        e.runs += 1
        if (c.status === 'failed' || c.status === 'error') e.failures += 1
        failMap.set(c.test_case_key, e)
      }
    }
    const top_failing = [...failMap.entries()]
      .filter(([, v]) => v.failures > 0)
      .sort((a, b) => b[1].failures - a[1].failures)
      .slice(0, 5)
      .map(([k, v]) => ({ test_case_key: k, title: v.title, failures: v.failures, runs: v.runs }))
    const durations = finals.filter((x) => x.started_at && x.finished_at).map((x) => Date.parse(x.finished_at!) - Date.parse(x.started_at!))
    return HttpResponse.json({
      range,
      total_runs: runs.length,
      pass_rate: finals.length ? finals.filter((x) => x.status === 'passed').length / finals.length : null,
      avg_duration_ms: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
      awaiting_manual: projectRuns(project.id).filter((x) => x.status === 'awaiting_manual').length,
      daily,
      top_failing,
    })
  })),

  // ---------- members
  http.get(`${API}/projects/:key/members`, r(({ params }) => {
    const { project } = requireProject(params.key as string)
    return HttpResponse.json({ data: db().members.filter((x) => x.project_id === project.id).map(toMember) })
  })),
  http.get(`${API}/projects/:key/assignable-users`, r(({ params }) => {
    const { project } = requireProject(params.key as string, 'manage_members')
    const memberIds = new Set(db().members.filter((x) => x.project_id === project.id).map((x) => x.user_id))
    return HttpResponse.json({ data: db().users.filter((u) => u.status === 'active' && !memberIds.has(u.id)).map((u) => userRef(u.id)) })
  })),
  http.post(`${API}/projects/:key/members`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'manage_members')
    const b = await body<{ user_id: string; role: ProjectRole }>(request)
    if (db().members.some((x) => x.project_id === project.id && x.user_id === b.user_id)) fail(409, 'conflict', 'User is already a member')
    const mem = { project_id: project.id, user_id: b.user_id, role: b.role, added_at: nowIso() }
    db().members.push(mem)
    return HttpResponse.json(toMember(mem), { status: 201 })
  })),
  http.patch(`${API}/projects/:key/members/:userId`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'manage_members')
    const mem = db().members.find((x) => x.project_id === project.id && x.user_id === params.userId)
    if (!mem) fail(404, 'not_found', 'Member not found')
    const b = await body<{ role: ProjectRole }>(request)
    if (mem.role === 'maintainer' && b.role !== 'maintainer' && db().members.filter((x) => x.project_id === project.id && x.role === 'maintainer').length === 1)
      fail(400, 'validation_failed', 'A project needs at least one maintainer')
    mem.role = b.role
    return HttpResponse.json(toMember(mem))
  })),
  http.delete(`${API}/projects/:key/members/:userId`, m(({ params }) => {
    const { project } = requireProject(params.key as string, 'manage_members')
    const mem = db().members.find((x) => x.project_id === project.id && x.user_id === params.userId)
    if (!mem) fail(404, 'not_found', 'Member not found')
    if (mem.role === 'maintainer' && db().members.filter((x) => x.project_id === project.id && x.role === 'maintainer').length === 1)
      fail(400, 'validation_failed', 'A project needs at least one maintainer')
    db().members = db().members.filter((x) => x !== mem)
    return noContent()
  })),

  // ---------- environments
  http.get(`${API}/projects/:key/environments`, r(({ params }) => {
    const { project } = requireProject(params.key as string)
    return HttpResponse.json({ data: db().environments.filter((e) => e.project_id === project.id).map(toEnvironment) })
  })),
  http.post(`${API}/projects/:key/environments`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'manage_environments')
    const b = await body<EnvironmentInput>(request)
    const name = (b.name ?? '').trim()
    if (!name) fail(400, 'validation_failed', 'Name is required', [{ path: 'name', message: 'Required' }])
    if (db().environments.some((e) => e.project_id === project.id && e.name === name)) fail(409, 'conflict', 'Environment name is already taken', [{ path: 'name', message: 'Already taken' }])
    validateVarKeys(b.variables ?? {})
    const envs = db().environments.filter((e) => e.project_id === project.id)
    const env = { id: newId('env'), project_id: project.id, name, is_default: !!b.is_default || envs.length === 0, variables: b.variables ?? {}, secrets: [], updated_at: nowIso() }
    if (env.is_default) envs.forEach((e) => (e.is_default = false))
    db().environments.push(env)
    return HttpResponse.json(toEnvironment(env), { status: 201 })
  })),
  http.patch(`${API}/projects/:key/environments/:id`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'manage_environments')
    const env = db().environments.find((e) => e.id === params.id && e.project_id === project.id)
    if (!env) fail(404, 'not_found', 'Environment not found')
    const b = await body<EnvironmentInput>(request)
    if (b.name !== undefined) {
      const name = b.name.trim()
      if (name && name !== env.name && db().environments.some((e) => e.project_id === project.id && e.name === name))
        fail(409, 'conflict', 'Environment name is already taken', [{ path: 'name', message: 'Already taken' }])
      env.name = name || env.name
    }
    if (b.variables) {
      validateVarKeys(b.variables)
      env.variables = b.variables
    }
    if (b.is_default) {
      db().environments.filter((e) => e.project_id === project.id).forEach((e) => (e.is_default = false))
      env.is_default = true
    }
    env.updated_at = nowIso()
    return HttpResponse.json(toEnvironment(env))
  })),
  http.delete(`${API}/projects/:key/environments/:id`, m(({ params }) => {
    const { project } = requireProject(params.key as string, 'manage_environments')
    const env = db().environments.find((e) => e.id === params.id && e.project_id === project.id)
    if (!env) fail(404, 'not_found', 'Environment not found')
    db().environments = db().environments.filter((e) => e !== env)
    const rest = db().environments.filter((e) => e.project_id === project.id)
    if (env.is_default && rest[0]) rest[0].is_default = true
    return noContent()
  })),
  http.put(`${API}/projects/:key/environments/:id/secrets/:name`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'manage_environments')
    const env = db().environments.find((e) => e.id === params.id && e.project_id === project.id)
    if (!env) fail(404, 'not_found', 'Environment not found')
    const name = params.name as string
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) fail(400, 'validation_failed', 'Secret name must be UPPER_SNAKE_CASE', [{ path: 'name', message: 'Use UPPER_SNAKE_CASE' }])
    const { value } = await body<{ value: string }>(request)
    if (!value) fail(400, 'validation_failed', 'Value is required', [{ path: 'value', message: 'Required' }])
    const existing = env.secrets.find((s) => s.name === name)
    if (existing) {
      existing.value = value
      existing.updated_at = nowIso()
    } else env.secrets.push({ name, value, updated_at: nowIso() })
    env.updated_at = nowIso()
    return HttpResponse.json(toEnvironment(env))
  })),
  http.delete(`${API}/projects/:key/environments/:id/secrets/:name`, m(({ params }) => {
    const { project } = requireProject(params.key as string, 'manage_environments')
    const env = db().environments.find((e) => e.id === params.id && e.project_id === project.id)
    if (!env) fail(404, 'not_found', 'Environment not found')
    env.secrets = env.secrets.filter((s) => s.name !== params.name)
    return HttpResponse.json(toEnvironment(env))
  })),

  // ---------- folders
  http.get(`${API}/projects/:key/folders`, r(({ params }) => {
    const { project } = requireProject(params.key as string)
    return HttpResponse.json({ data: db().folders.filter((f) => f.project_id === project.id).sort((a, b) => a.position - b.position).map(toFolder) })
  })),
  http.post(`${API}/projects/:key/folders`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'edit_tests')
    const b = await body<{ name: string; parent_id?: string | null }>(request)
    if (!b.name?.trim()) fail(400, 'validation_failed', 'Folder name is required', [{ path: 'name', message: 'Required' }])
    const parent = b.parent_id ?? null
    const f = { id: newId('f'), project_id: project.id, parent_id: parent, name: b.name.trim(), position: db().folders.filter((x) => x.project_id === project.id && x.parent_id === parent).length }
    db().folders.push(f)
    return HttpResponse.json(toFolder(f), { status: 201 })
  })),
  http.patch(`${API}/projects/:key/folders/:id`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'edit_tests')
    const f = db().folders.find((x) => x.id === params.id && x.project_id === project.id)
    if (!f) fail(404, 'not_found', 'Folder not found')
    const b = await body<{ name?: string; parent_id?: string | null; position?: number }>(request)
    if (b.name !== undefined) f.name = b.name.trim() || f.name
    if (b.parent_id !== undefined) {
      // cegah siklus
      let cur = b.parent_id
      while (cur) {
        if (cur === f.id) fail(400, 'validation_failed', "A folder can't be moved into itself")
        cur = db().folders.find((x) => x.id === cur)?.parent_id ?? null
      }
      f.parent_id = b.parent_id
    }
    if (b.position !== undefined) f.position = b.position
    return HttpResponse.json(toFolder(f))
  })),
  http.delete(`${API}/projects/:key/folders/:id`, m(({ params }) => {
    const { project } = requireProject(params.key as string, 'edit_tests')
    const f = db().folders.find((x) => x.id === params.id && x.project_id === project.id)
    if (!f) fail(404, 'not_found', 'Folder not found')
    for (const c of db().folders) if (c.parent_id === f.id) c.parent_id = f.parent_id
    for (const t of db().testCases) if (t.folder_id === f.id) t.folder_id = f.parent_id
    db().folders = db().folders.filter((x) => x !== f)
    return noContent()
  })),

  // ---------- test cases
  http.get(`${API}/projects/:key/tags`, r(({ params }) => {
    const { project } = requireProject(params.key as string)
    const counts = new Map<string, number>()
    for (const t of db().testCases) if (t.project_id === project.id && !t.deleted_at) for (const tag of t.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1)
    return HttpResponse.json({ data: [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count })) })
  })),
  http.get(`${API}/projects/:key/test-cases`, r(({ params, request }) => {
    const { project } = requireProject(params.key as string)
    const sp = new URL(request.url).searchParams
    const folder = sp.get('folder')
    const q = sp.get('q')?.toLowerCase().trim()
    const tags = sp.get('tags')?.split(',').filter(Boolean) ?? []
    const descendants = (id: string): string[] => [id, ...db().folders.filter((f) => f.parent_id === id).flatMap((f) => descendants(f.id))]
    const folderSet = folder && folder !== 'root' ? new Set(descendants(folder)) : null
    let list = db().testCases.filter((t) => t.project_id === project.id && !t.deleted_at)
    if (folder === 'root') list = list.filter((t) => !t.folder_id)
    else if (folderSet) list = list.filter((t) => t.folder_id && folderSet.has(t.folder_id))
    if (q) list = list.filter((t) => t.title.toLowerCase().includes(q) || t.key.toLowerCase().includes(q))
    if (tags.length) list = list.filter((t) => tags.every((tag) => t.tags.includes(tag)))
    for (const f of ['status', 'priority', 'execution'] as const) {
      const v = sp.get(f)
      if (v) list = list.filter((t) => t[f] === v)
    }
    let summaries = list.map(toTestCaseSummary)
    const lrs = sp.get('last_run_status')
    if (lrs) summaries = summaries.filter((t) => t.last_run_status === lrs)
    summaries.sort((a, b) => Number(a.key.split('-T')[1]) - Number(b.key.split('-T')[1]))
    return HttpResponse.json(page(summaries, new URL(request.url)))
  })),
  http.post(`${API}/projects/:key/test-cases/validate`, r(async ({ params, request }) => {
    requireProject(params.key as string)
    const input = await body<TestCaseInput>(request)
    const v = validateInput(input)
    return HttpResponse.json({ valid: v.errors.length === 0, errors: v.errors, warnings: v.warnings })
  })),
  http.post(`${API}/projects/:key/test-cases/bulk`, m(async ({ params, request }) => {
    const { project, user } = requireProject(params.key as string, 'edit_tests')
    const b = await body<BulkTestCaseAction>(request)
    const targets = db().testCases.filter((t) => t.project_id === project.id && b.ids.includes(t.id) && !t.deleted_at)
    if (b.action === 'delete') {
      // Same rule as the single delete: refuse (nothing deleted) while a live flow uses a case.
      const used = targets
        .map((t) => ({ t, flows: db().flows.filter((f) => !f.deleted_at && f.items.some((i) => i.test_case_id === t.id)) }))
        .filter((u) => u.flows.length > 0)
        .sort((a, b) => Number(a.t.key.split('-T')[1]) - Number(b.t.key.split('-T')[1]))
      if (used.length) {
        const flowKeys = (u: (typeof used)[number]) =>
          u.flows.map((f) => f.key).sort((a, b) => Number(a.split('-F')[1]) - Number(b.split('-F')[1]))
        fail(
          409,
          'in_use',
          `Still used in flows: ${used.map((u) => `${u.t.key} (${flowKeys(u).join(', ')})`).join('; ')}`,
          used.map((u) => ({ path: u.t.key, message: `Still used in flows: ${flowKeys(u).join(', ')}` })),
        )
      }
    }
    for (const t of targets) {
      if (b.action === 'move') t.folder_id = b.folder_id ?? null
      if (b.action === 'set_status' && b.status) t.status = b.status
      if (b.action === 'add_tags') t.tags = [...new Set([...t.tags, ...(b.tags ?? [])])]
      if (b.action === 'remove_tags') t.tags = t.tags.filter((x) => !(b.tags ?? []).includes(x))
      if (b.action === 'delete') t.deleted_at = nowIso()
      t.updated_at = nowIso()
      t.updated_by = user.id
    }
    return HttpResponse.json({ updated: targets.length })
  })),
  http.post(`${API}/projects/:key/test-cases`, m(async ({ params, request }) => {
    const { project, user } = requireProject(params.key as string, 'edit_tests')
    const input = await body<TestCaseInput>(request)
    const v = validateInput(input)
    if (v.errors.length) fail(422, 'validation_failed', 'Test case is not valid', v.errors)
    project.seq.case += 1
    const tc: DbTestCase = {
      id: newId('tc'),
      project_id: project.id,
      key: `${project.key}-T${project.seq.case}`,
      folder_id: input.folder_id ?? null,
      title: input.title.trim(),
      description: input.description ?? '',
      preconditions: input.preconditions ?? '',
      priority: input.priority ?? 'medium',
      status: input.status ?? 'draft',
      execution: input.execution ?? 'automated',
      tags: input.tags ?? [],
      variables: input.variables ?? {},
      steps: input.steps ?? [],
      revision: 1,
      created_at: nowIso(),
      created_by: user.id,
      updated_at: nowIso(),
      updated_by: user.id,
      deleted_at: null,
    }
    db().testCases.push(tc)
    snapshotRevision(tc, user.id, 'Created')
    return HttpResponse.json(toTestCase(tc), { status: 201 })
  })),
  http.get(`${API}/test-cases/:caseKey`, r(({ params }) => HttpResponse.json(toTestCase(findTestCase(params.caseKey as string).tc)))),
  http.patch(`${API}/test-cases/:caseKey`, m(async ({ params, request }) => {
    const { tc, user } = findTestCase(params.caseKey as string, 'edit_tests')
    const input = await body<TestCaseInput & { revision: number; change_note?: string }>(request)
    if (input.revision !== tc.revision) fail(409, 'revision_conflict', `Test case was changed by someone else (revision ${tc.revision}). Reload to see the latest changes.`)
    const v = validateInput({ ...testCaseInput(tc), ...input })
    if (v.errors.length) fail(422, 'validation_failed', 'Test case is not valid', v.errors)
    Object.assign(tc, {
      folder_id: input.folder_id !== undefined ? input.folder_id : tc.folder_id,
      title: input.title?.trim() ?? tc.title,
      description: input.description ?? tc.description,
      preconditions: input.preconditions ?? tc.preconditions,
      priority: input.priority ?? tc.priority,
      status: input.status ?? tc.status,
      execution: input.execution ?? tc.execution,
      tags: input.tags ?? tc.tags,
      variables: input.variables ?? tc.variables,
      steps: input.steps ?? tc.steps,
    })
    tc.revision += 1
    tc.updated_at = nowIso()
    tc.updated_by = user.id
    snapshotRevision(tc, user.id, input.change_note?.trim() || 'No change note')
    return HttpResponse.json(toTestCase(tc))
  })),
  http.delete(`${API}/test-cases/:caseKey`, m(({ params }) => {
    const { tc } = findTestCase(params.caseKey as string, 'edit_tests')
    const usedIn = db().flows.filter((f) => !f.deleted_at && f.items.some((i) => i.test_case_id === tc.id))
    if (usedIn.length) fail(409, 'in_use', `Still used in flows: ${usedIn.map((f) => f.key).join(', ')}`)
    tc.deleted_at = nowIso()
    return noContent()
  })),
  http.post(`${API}/test-cases/:caseKey/duplicate`, m(({ params }) => {
    const { tc, project, user } = findTestCase(params.caseKey as string, 'edit_tests')
    project.seq.case += 1
    const copy: DbTestCase = {
      ...structuredClone(tc),
      id: newId('tc'),
      key: `${project.key}-T${project.seq.case}`,
      title: `${tc.title} (copy)`,
      status: 'draft',
      revision: 1,
      created_at: nowIso(),
      created_by: user.id,
      updated_at: nowIso(),
      updated_by: user.id,
    }
    db().testCases.push(copy)
    snapshotRevision(copy, user.id, `Duplicated from ${tc.key}`)
    return HttpResponse.json(toTestCase(copy), { status: 201 })
  })),
  http.get(`${API}/test-cases/:caseKey/revisions`, r(({ params }) => {
    const { tc } = findTestCase(params.caseKey as string)
    const data = db()
      .revisions.filter((x) => x.test_case_id === tc.id)
      .sort((a, b) => b.revision - a.revision)
      .map((x) => ({ revision: x.revision, author: userRef(x.author_id), change_note: x.change_note, created_at: x.created_at }))
    return HttpResponse.json({ data })
  })),
  http.get(`${API}/test-cases/:caseKey/revisions/:rev`, r(({ params }) => {
    const { tc } = findTestCase(params.caseKey as string)
    const rev = db().revisions.find((x) => x.test_case_id === tc.id && x.revision === Number(params.rev))
    if (!rev) fail(404, 'not_found', 'Revision not found')
    return HttpResponse.json({ revision: rev.revision, author: userRef(rev.author_id), change_note: rev.change_note, created_at: rev.created_at, snapshot: rev.snapshot })
  })),

  // ---------- flows
  http.get(`${API}/projects/:key/flows`, r(({ params, request }) => {
    const { project } = requireProject(params.key as string)
    const q = new URL(request.url).searchParams.get('q')?.toLowerCase()
    let list = db().flows.filter((f) => f.project_id === project.id && !f.deleted_at)
    if (q) list = list.filter((f) => f.name.toLowerCase().includes(q) || f.key.toLowerCase().includes(q))
    return HttpResponse.json({ data: list.map(toFlowSummary) })
  })),
  http.post(`${API}/projects/:key/flows`, m(async ({ params, request }) => {
    const { project } = requireProject(params.key as string, 'edit_tests')
    const input = await body<FlowInput>(request)
    const errors = flowValidation(input)
    if (errors.length) fail(422, 'validation_failed', 'Flow is not valid', errors)
    project.seq.flow += 1
    const flow = {
      id: newId('fl'),
      project_id: project.id,
      key: `${project.key}-F${project.seq.flow}`,
      name: input.name.trim(),
      description: input.description ?? '',
      tags: input.tags ?? [],
      shared_session: !!input.shared_session,
      stop_on_failure: input.stop_on_failure ?? true,
      variables: input.variables ?? {},
      items: input.items.map((i) => ({ id: newId('fi'), test_case_id: i.test_case_id, continue_on_failure: !!i.continue_on_failure, enabled: i.enabled ?? true })),
      revision: 1,
      created_at: nowIso(),
      updated_at: nowIso(),
      deleted_at: null,
    }
    db().flows.push(flow)
    return HttpResponse.json(toFlow(flow), { status: 201 })
  })),
  http.get(`${API}/flows/:flowKey`, r(({ params }) => HttpResponse.json(toFlow(findFlow(params.flowKey as string).flow)))),
  http.patch(`${API}/flows/:flowKey`, m(async ({ params, request }) => {
    const { flow } = findFlow(params.flowKey as string, 'edit_tests')
    const input = await body<FlowInput & { revision: number }>(request)
    if (input.revision !== flow.revision) fail(409, 'revision_conflict', 'Flow was changed by someone else. Reload to see the latest changes.')
    const errors = flowValidation(input)
    if (errors.length) fail(422, 'validation_failed', 'Flow is not valid', errors)
    Object.assign(flow, {
      name: input.name.trim(),
      description: input.description ?? flow.description,
      tags: input.tags ?? flow.tags,
      shared_session: input.shared_session ?? flow.shared_session,
      stop_on_failure: input.stop_on_failure ?? flow.stop_on_failure,
      variables: input.variables ?? flow.variables,
      items: input.items.map((i) => ({ id: newId('fi'), test_case_id: i.test_case_id, continue_on_failure: !!i.continue_on_failure, enabled: i.enabled ?? true })),
    })
    flow.revision += 1
    flow.updated_at = nowIso()
    return HttpResponse.json(toFlow(flow))
  })),
  http.delete(`${API}/flows/:flowKey`, m(({ params }) => {
    const { flow } = findFlow(params.flowKey as string, 'edit_tests')
    flow.deleted_at = nowIso()
    return noContent()
  })),

  // ---------- runs
  http.get(`${API}/projects/:key/runs`, r(({ params, request }) => {
    const { project } = requireProject(params.key as string)
    const sp = new URL(request.url).searchParams
    let list = projectRuns(project.id)
    const status = sp.get('status') as RunStatus | null
    if (status) list = list.filter((x) => x.status === status)
    const target = sp.get('target')?.toUpperCase()
    if (target)
      list = list.filter(
        (x) =>
          x.target_key.includes(target) ||
          x.target_title.toUpperCase().includes(target) ||
          x.key.includes(target) ||
          x.cases.some((c) => c.test_case_key === target),
      )
    const kind = sp.get('kind')
    if (kind) list = list.filter((x) => x.kind === kind)
    const trigger = sp.get('trigger')
    if (trigger) list = list.filter((x) => x.trigger === trigger)
    const from = sp.get('from')
    if (from) list = list.filter((x) => localDate(new Date(x.queued_at)) >= from)
    const to = sp.get('to')
    if (to) list = list.filter((x) => localDate(new Date(x.queued_at)) <= to)
    return HttpResponse.json(page(list.map(toRunSummary), new URL(request.url)))
  })),
  http.post(`${API}/projects/:key/runs`, m(async ({ params, request }) => {
    const { project, user } = requireProject(params.key as string, 'run')
    const b = await body<RunCreate>(request)
    let kind: 'test_case' | 'flow'
    let targetId: string
    if (b.test_case) {
      const tc = db().testCases.find((t) => t.key === b.test_case && t.project_id === project.id && !t.deleted_at)
      if (!tc) fail(422, 'validation_failed', `Test case ${b.test_case} not found`)
      const v = validateSteps(tc.steps, tc.execution, { lng: 'en' })
      if (v.errors.length) fail(422, 'validation_failed', 'Test case is not valid; fix it before running', v.errors)
      if (!tc.steps.length) fail(422, 'validation_failed', 'Test case has no steps')
      kind = 'test_case'
      targetId = tc.id
    } else if (b.flow) {
      const flow = db().flows.find((f) => f.key === b.flow && f.project_id === project.id && !f.deleted_at)
      if (!flow) fail(422, 'validation_failed', `Flow ${b.flow} not found`)
      const errors = flowValidation({ name: flow.name, items: flow.items, shared_session: flow.shared_session })
      if (errors.length) fail(422, 'validation_failed', 'Flow is not valid', errors)
      kind = 'flow'
      targetId = flow.id
    } else {
      fail(422, 'validation_failed', 'Choose a test case or a flow')
    }
    const env = b.environment_id
      ? db().environments.find((e) => e.id === b.environment_id && e.project_id === project.id)
      : db().environments.find((e) => e.project_id === project.id && e.is_default)
    if (b.assignee_id) {
      const assignee = db().users.find((u) => u.id === b.assignee_id)
      if (!assignee || !can(roleIn(assignee, project.id), 'execute_manual', assignee.system_role)) fail(422, 'validation_failed', 'Assignee must be an editor or maintainer of the project')
    }
    const run = createRun({ project, kind, targetId, env, options: mergeOptions(project, b.options), userId: user.id, trigger: 'manual', assigneeId: b.assignee_id ?? user.id })
    db().runs.push(run)
    return HttpResponse.json(toRun(run), { status: 202 })
  })),
  http.get(`${API}/runs/:runKey`, r(({ params }) => HttpResponse.json(toRun(findRun(params.runKey as string).run)), { latency: 30 })),
  http.get(`${API}/runs/:runKey/junit.xml`, r(({ params }) => {
    const { run } = findRun(params.runKey as string)
    if (!isFinal(run.status))
      fail(409, 'conflict', `Run ${run.key} is ${run.status.replace('_', ' ')}; the JUnit report is available once the run has finished`)
    return new HttpResponse(runToJUnit(toRun(run)), {
      headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${junitFilename(run.key)}"` },
    })
  })),
  http.post(`${API}/runs/:runKey/cancel`, m(({ params }) => {
    const { run, user, role } = findRun(params.runKey as string, 'cancel_own_run')
    if (run.triggered_by_id !== user.id && !can(role, 'cancel_any_run', user.system_role)) fail(403, 'forbidden', "Only maintainers can cancel other people's runs")
    if (isFinal(run.status)) fail(409, 'conflict', 'Run has already finished')
    if (run.status === 'awaiting_manual' || run.status === 'queued') {
      for (const c of run.cases) if (c.status === 'pending' || c.status === 'running') {
        c.status = 'skipped'
        for (const s of c.steps) if (s.status === 'pending' || s.status === 'running') s.status = 'skipped'
      }
      run.status = 'cancelled'
      run.finished_at = nowIso()
      run.resume_position = null
    } else run.cancel_requested = true
    return HttpResponse.json(toRun(run))
  })),
  http.post(`${API}/runs/:runKey/rerun`, m(async ({ params, request }) => {
    const { run, project, user } = findRun(params.runKey as string, 'run')
    const b = await body<{ only_failed?: boolean }>(request)
    const env = db().environments.find((e) => e.id === run.environment_id)
    const onlyIds = b.only_failed && run.kind === 'flow'
      ? run.cases.filter((c) => c.status === 'failed' || c.status === 'error' || c.status === 'blocked' || c.status === 'skipped').map((c) => c.test_case_id)
      : undefined
    if (onlyIds && onlyIds.length === 0) fail(422, 'validation_failed', 'No failed cases to rerun')
    const next = createRun({ project, kind: run.kind, targetId: run.target_id, env, options: run.options, userId: user.id, trigger: 'manual', assigneeId: run.assignee_id ?? user.id, onlyTestCaseIds: onlyIds })
    db().runs.push(next)
    return HttpResponse.json(toRun(next), { status: 202 })
  })),
  http.patch(`${API}/runs/:runKey/assignee`, m(async ({ params, request }) => {
    const { run, project } = findRun(params.runKey as string, 'reassign_manual')
    const { user_id } = await body<{ user_id: string }>(request)
    const assignee = db().users.find((u) => u.id === user_id)
    if (!assignee || !can(roleIn(assignee, project.id), 'execute_manual', assignee.system_role)) fail(422, 'validation_failed', 'Assignee must be an editor or maintainer of the project')
    run.assignee_id = user_id
    return HttpResponse.json(toRun(run))
  })),
  http.put(`${API}/runs/:runKey/cases/:caseId/steps/:stepId/manual-result`, r(async ({ params, request }) => {
    const { run, user } = findRun(params.runKey as string, 'execute_manual')
    assertManualEditable(run, user, params.caseId as string)
    const c = run.cases.find((x) => x.id === params.caseId)!
    const s = c.steps.find((x) => x.id === params.stepId)
    if (!s) fail(404, 'not_found', 'Step not found')
    const b = await body<{ status: 'pending' | 'passed' | 'failed' | 'blocked' | 'skipped'; actual_result?: string }>(request)
    s.status = b.status
    if (b.actual_result !== undefined) s.actual_result = b.actual_result || null
    c.status = 'running'
    c.started_at = c.started_at ?? nowIso()
    c.executed_by_id = user.id
    return HttpResponse.json(toRun(run))
  }, { mutate: true, latency: 60 })),
  http.post(`${API}/runs/:runKey/cases/:caseId/attachments`, m(async ({ params, request }) => {
    const { run, user } = findRun(params.runKey as string, 'execute_manual')
    assertManualEditable(run, user, params.caseId as string)
    const c = run.cases.find((x) => x.id === params.caseId)!
    const form = await request.formData()
    const file = form.get('file')
    if (!(file instanceof File)) fail(400, 'validation_failed', 'A file is required')
    if (file.size > 25 * 1024 * 1024) fail(413, 'too_large', 'Maximum file size is 25 MB')
    const url = await fileToDataUrl(file)
    const art = {
      id: newId('art'),
      project_id: run.project_id,
      run_id: run.id,
      run_case_id: c.id,
      run_step_id: (form.get('run_step_id') as string) || null,
      kind: 'attachment' as const,
      name: file.name || 'lampiran.png',
      url,
      mime: file.type || 'application/octet-stream',
      size_bytes: file.size,
      uploaded_by: user.id,
      created_at: nowIso(),
      expired: false,
      storage: activeStorageBackend(),
    }
    db().artifacts.push(art)
    c.attachment_ids.push(art.id)
    return HttpResponse.json(
      { id: art.id, kind: art.kind, name: art.name, url: art.url, mime: art.mime, size_bytes: art.size_bytes, expired: false, run_step_id: art.run_step_id, created_at: art.created_at },
      { status: 201 },
    )
  })),
  http.post(`${API}/runs/:runKey/cases/:caseId/complete-manual`, m(({ params }) => {
    const { run, user } = findRun(params.runKey as string, 'execute_manual')
    assertManualEditable(run, user, params.caseId as string)
    const msg = completeManualCase(run, params.caseId as string, user.id)
    if (msg) fail(409, 'conflict', msg)
    return HttpResponse.json(toRun(run))
  })),
]

function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function validateVarKeys(vars: Record<string, string>) {
  const bad = Object.keys(vars).filter((k) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
  if (bad.length)
    fail(400, 'validation_failed', `Invalid variable names: ${bad.join(', ')}`, bad.map((k) => ({ path: `variables.${k}`, message: 'Use letters, digits, and underscores' })))
}

function assertManualEditable(run: DbRun, user: DbUser, caseId: string) {
  if (run.status !== 'awaiting_manual') fail(409, 'conflict', 'Run is not awaiting manual execution')
  if (run.assignee_id !== user.id) fail(403, 'forbidden', 'Only the assignee can record manual results')
  const c = run.cases.find((x) => x.id === caseId)
  if (!c || c.execution !== 'manual' || c.position !== run.resume_position) fail(409, 'conflict', 'This case is not in progress')
}

function fileToDataUrl(file: File): Promise<string> {
  // gambar kecil disimpan sebagai data URL agar tahan reload; file besar memakai object URL (hilang saat reload)
  if (file.size > 400_000) return Promise.resolve(URL.createObjectURL(file))
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
