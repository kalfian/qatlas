import { QueryClient } from '@tanstack/react-query'
import { createRootRouteWithContext, createRoute, createRouter, lazyRouteComponent, Outlet, redirect } from '@tanstack/react-router'
import { api, ApiError, unwrap } from '@/api/client'
import { qk } from '@/api/queries'
import type { Me, RunKind, RunStatus, RunTrigger } from '@/api/types'
import { AuthPending, PagePending, ShellPending } from './shell/RoutePending'
import { NotFoundPage, RootLayout } from './shell/RootLayout'
import { lastProject } from './config'
import { applyUserLanguageOnce } from './language'

export interface RouterContext {
  queryClient: QueryClient
}

/* ------------------------------------------------------------------ search params */

const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
function oneOf<T extends string>(v: unknown, values: readonly T[]): T | undefined {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : undefined
}

export interface TestCasesSearch {
  folder?: string
  q?: string
  tags?: string
  status?: 'draft' | 'ready' | 'deprecated'
  priority?: 'low' | 'medium' | 'high' | 'critical'
  execution?: 'automated' | 'manual'
  last_run_status?: RunStatus
}

const RUN_STATUSES = ['queued', 'running', 'awaiting_manual', 'passed', 'failed', 'blocked', 'error', 'cancelled'] as const

export interface TestCaseEditorSearch {
  tab?: 'steps' | 'variables' | 'info' | 'revisions' | 'runs'
  execution?: 'automated' | 'manual'
  folder?: string
}

export interface RunsSearch {
  status?: RunStatus
  target?: string
  kind?: RunKind
  trigger?: RunTrigger
  from?: string
  to?: string
}

export interface SettingsSearch {
  section?: 'general' | 'members' | 'run-defaults' | 'retention' | 'danger'
}

/* ------------------------------------------------------------------ lazy pages */

/*
 * Tiap halaman = chunk sendiri, dimuat saat route dicocokkan (atau saat hover/fokus link: defaultPreload 'intent').
 * Yang tetap di bundle awal hanya definisi route: validateSearch, beforeLoad (auth, redirect), dan pending UI.
 */
const AdminUsersPage = lazyRouteComponent(() => import('@/features/admin/AdminUsersPage'), 'AdminUsersPage')
const AdminStoragePage = lazyRouteComponent(() => import('@/features/admin/StoragePage'), 'StoragePage')
const ProfilePage = lazyRouteComponent(() => import('@/features/account/ProfilePage'), 'ProfilePage')
const TokensPage = lazyRouteComponent(() => import('@/features/account/TokensPage'), 'TokensPage')
const InvitePage = lazyRouteComponent(() => import('@/features/auth/InvitePage'), 'InvitePage')
const LoginPage = lazyRouteComponent(() => import('@/features/auth/LoginPage'), 'LoginPage')
const DashboardPage = lazyRouteComponent(() => import('@/features/dashboard/DashboardPage'), 'DashboardPage')
const EnvironmentsPage = lazyRouteComponent(() => import('@/features/environments/EnvironmentsPage'), 'EnvironmentsPage')
const FlowBuilderPage = lazyRouteComponent(() => import('@/features/flows/FlowBuilderPage'), 'FlowBuilderPage')
const FlowsPage = lazyRouteComponent(() => import('@/features/flows/FlowsPage'), 'FlowsPage')
const ProjectsPage = lazyRouteComponent(() => import('@/features/projects/ProjectsPage'), 'ProjectsPage')
const RunPage = lazyRouteComponent(() => import('@/features/runs/RunPage'), 'RunPage')
const RunsPage = lazyRouteComponent(() => import('@/features/runs/RunsPage'), 'RunsPage')
const ProjectSettingsPage = lazyRouteComponent(() => import('@/features/settings/ProjectSettingsPage'), 'ProjectSettingsPage')
const MyTasksPage = lazyRouteComponent(() => import('@/features/tasks/MyTasksPage'), 'MyTasksPage')
const TestCaseEditorPage = lazyRouteComponent(() => import('@/features/testcases/TestCaseEditorPage'), 'TestCaseEditorPage')
const TestCasesPage = lazyRouteComponent(() => import('@/features/testcases/TestCasesPage'), 'TestCasesPage')
const AppShell = lazyRouteComponent(() => import('./shell/AppShell'), 'AppShell')
const ProjectLayout = lazyRouteComponent(() => import('./shell/AppShell'), 'ProjectLayout')

/* ------------------------------------------------------------------ routes */

const rootRoute = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
})

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  validateSearch: (s: Record<string, unknown>): { error?: string; redirect?: string } => ({ error: str(s.error), redirect: str(s.redirect) }),
  component: LoginPage,
  pendingComponent: AuthPending,
})

const inviteRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/invite/$token',
  component: InvitePage,
  pendingComponent: AuthPending,
})

/** Layout terproteksi: memastikan user sudah login. */
const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: '_app',
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.ensureQueryData<Me>({ queryKey: qk.me, queryFn: () => unwrap(api.GET('/me')) })
      // Locale profil diterapkan sekali per user sebelum shell dirender (lihat app/language.ts).
      await applyUserLanguageOnce(me.user)
      return { me }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw redirect({ to: '/login', search: { redirect: location.href === '/' ? undefined : location.href } })
      }
      throw err
    }
  },
  component: AppShell,
  // Shell belum dirender saat /me atau chunk shell masih dimuat → skeleton berbentuk shell.
  pendingComponent: ShellPending,
})

const indexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: ({ context }) => {
    const me = (context as unknown as { me: Me }).me
    const last = lastProject()
    const target = me.projects.find((p) => p.key === last) ?? (me.projects.length === 1 ? me.projects[0] : undefined)
    if (target) throw redirect({ to: '/p/$key', params: { key: target.key } })
    throw redirect({ to: '/projects' })
  },
})

const projectsRoute = createRoute({ getParentRoute: () => appRoute, path: '/projects', component: ProjectsPage })
const myTasksRoute = createRoute({ getParentRoute: () => appRoute, path: '/my-tasks', component: MyTasksPage })
/** Halaman admin sistem: non-admin dialihkan ke beranda (link-nya juga tidak tampil di sidebar). */
function requireAdmin({ context }: { context: unknown }) {
  const me = (context as { me: Me }).me
  if (me.user.system_role !== 'admin') throw redirect({ to: '/' })
}
const adminUsersRoute = createRoute({ getParentRoute: () => appRoute, path: '/admin/users', beforeLoad: requireAdmin, component: AdminUsersPage })
const adminStorageRoute = createRoute({ getParentRoute: () => appRoute, path: '/admin/storage', beforeLoad: requireAdmin, component: AdminStoragePage })
const profileRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings/profile', component: ProfilePage })
const tokensRoute = createRoute({ getParentRoute: () => appRoute, path: '/settings/tokens', component: TokensPage })

const projectRoute = createRoute({ getParentRoute: () => appRoute, path: '/p/$key', component: ProjectLayout })

const dashboardRoute = createRoute({ getParentRoute: () => projectRoute, path: '/', component: DashboardPage })

const testCasesRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/tests',
  validateSearch: (s: Record<string, unknown>): TestCasesSearch => ({
    folder: str(s.folder),
    q: str(s.q),
    tags: str(s.tags),
    status: oneOf(s.status, ['draft', 'ready', 'deprecated'] as const),
    priority: oneOf(s.priority, ['low', 'medium', 'high', 'critical'] as const),
    execution: oneOf(s.execution, ['automated', 'manual'] as const),
    last_run_status: oneOf(s.last_run_status, RUN_STATUSES),
  }),
  component: TestCasesPage,
})

const testCaseRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/tests/$caseKey',
  validateSearch: (s: Record<string, unknown>): TestCaseEditorSearch => ({
    tab: oneOf(s.tab, ['steps', 'variables', 'info', 'revisions', 'runs'] as const),
    execution: oneOf(s.execution, ['automated', 'manual'] as const),
    folder: str(s.folder),
  }),
  component: TestCaseEditorPage,
})

const flowsRoute = createRoute({ getParentRoute: () => projectRoute, path: '/flows', component: FlowsPage })
const flowRoute = createRoute({ getParentRoute: () => projectRoute, path: '/flows/$flowKey', component: FlowBuilderPage })

const runsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/runs',
  validateSearch: (s: Record<string, unknown>): RunsSearch => ({
    status: oneOf(s.status, RUN_STATUSES),
    target: str(s.target),
    kind: oneOf(s.kind, ['test_case', 'flow'] as const),
    trigger: oneOf(s.trigger, ['manual', 'mcp', 'api', 'schedule'] as const),
    from: str(s.from),
    to: str(s.to),
  }),
  component: RunsPage,
})
const runRoute = createRoute({ getParentRoute: () => projectRoute, path: '/runs/$runKey', component: RunPage })

const environmentsRoute = createRoute({ getParentRoute: () => projectRoute, path: '/environments', component: EnvironmentsPage })
const settingsRoute = createRoute({
  getParentRoute: () => projectRoute,
  path: '/settings',
  validateSearch: (s: Record<string, unknown>): SettingsSearch => ({
    section: oneOf(s.section, ['general', 'members', 'run-defaults', 'retention', 'danger'] as const),
  }),
  component: ProjectSettingsPage,
})

const routeTree = rootRoute.addChildren([
  loginRoute,
  inviteRoute,
  appRoute.addChildren([
    indexRoute,
    projectsRoute,
    myTasksRoute,
    adminUsersRoute,
    adminStorageRoute,
    profileRoute,
    tokensRoute,
    projectRoute.addChildren([
      dashboardRoute,
      testCasesRoute,
      testCaseRoute,
      flowsRoute,
      flowRoute,
      runsRoute,
      runRoute,
      environmentsRoute,
      settingsRoute,
    ]),
  ]),
])

export function createAppRouter(queryClient: QueryClient) {
  return createRouter({
    routeTree,
    context: { queryClient },
    defaultPreload: 'intent',
    scrollRestoration: true,
    // Chunk halaman / beforeLoad yang lambat: skeleton baru tampil setelah 150ms (tanpa kedip untuk respons
    // cepat), lalu bertahan minimal 300ms agar tidak berkedip saat chunk tiba tepat setelahnya (ui-direction §6).
    defaultPendingComponent: PagePending,
    defaultPendingMs: 150,
    defaultPendingMinMs: 300,
  })
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>
  }
}

/**
 * Route ID untuk getRouteApi / useSearch({ from }):
 *  /login, /invite/$token, /_app/projects, /_app/my-tasks, /_app/admin/users, /_app/admin/storage, /_app/settings/profile, /_app/settings/tokens,
 *  /_app/p/$key, /_app/p/$key/, /_app/p/$key/tests, /_app/p/$key/tests/$caseKey, /_app/p/$key/flows,
 *  /_app/p/$key/flows/$flowKey, /_app/p/$key/runs, /_app/p/$key/runs/$runKey, /_app/p/$key/environments, /_app/p/$key/settings
 */
export { Outlet }
