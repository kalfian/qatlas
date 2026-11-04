import { Link, Outlet, useMatchRoute, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import {
  ChevronsUpDown,
  CircleUser,
  FlaskConical,
  FolderKanban,
  HardDrive,
  Hand,
  KeyRound,
  Languages,
  LayoutDashboard,
  ListChecks,
  LogOut,
  Menu,
  Monitor,
  Moon,
  Play,
  Search,
  Settings,
  Sun,
  Users,
  Workflow,
  Layers,
  type LucideIcon,
} from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useLogout, useMyManualRuns, useProject } from '@/api/queries'
import { ErrorState } from '@/components/page'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, SheetContent } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { LANGUAGES, type Language } from '@/i18n'
import { cn } from '@/lib/utils'
import { useAuth, useCan, useIsAdmin } from '../auth'
import { rememberProject } from '../config'
import { useChangeLanguage } from '../language'
import { useTheme } from '../theme'
import { CommandPalette, useCommandPalette } from './CommandPalette'

/* ------------------------------------------------------------------ shell */

export function AppShell() {
  const { t } = useTranslation('nav')
  const [mobileNav, setMobileNav] = React.useState(false)
  const palette = useCommandPalette()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  React.useEffect(() => setMobileNav(false), [pathname])

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring">
        {t('skipToContent')}
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
        <Sidebar />
      </aside>
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0" aria-describedby={undefined}>
          <span className="sr-only" id="mobile-nav-title">
            {t('navigation')}
          </span>
          <Sidebar />
        </SheetContent>
      </Dialog>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={() => setMobileNav(true)} onSearch={() => palette.setOpen(true)} />
        <main id="main" className="min-w-0 flex-1" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={palette.open} onOpenChange={palette.setOpen} />
    </div>
  )
}

export function ProjectLayout() {
  const { key } = useParams({ from: '/_app/p/$key' })
  const project = useProject(key)
  React.useEffect(() => {
    if (project.data) rememberProject(key)
  }, [key, project.data])
  if (project.isError) {
    return (
      <div className="p-6">
        <ErrorState error={project.error} onRetry={() => project.refetch()} />
      </div>
    )
  }
  return <Outlet />
}

/* ------------------------------------------------------------------ sidebar */

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  exact?: boolean
  show?: boolean
  badge?: number
  ariaLabel?: string
}

function NavLink({ item }: { item: NavItem }) {
  const matchRoute = useMatchRoute()
  const active = !!matchRoute({ to: item.to, fuzzy: !item.exact })
  return (
    <Link
      to={item.to}
      aria-current={active ? 'page' : undefined}
      aria-label={item.ariaLabel}
      className={cn(
        'relative flex h-8 items-center gap-2.5 rounded-md px-2.5 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        active && 'bg-sidebar-accent font-medium text-sidebar-accent-foreground before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-ring',
      )}
    >
      <item.icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{item.label}</span>
      {item.badge ? (
        <span className="ml-auto rounded-sm bg-status-awaiting-manual-bg px-1.5 text-xs font-medium text-status-awaiting-manual tabular">{item.badge}</span>
      ) : null}
    </Link>
  )
}

function Sidebar() {
  const { t } = useTranslation('nav')
  const params = useParams({ strict: false }) as { key?: string }
  const key = params.key
  const isAdmin = useIsAdmin()
  const canSettings = useCan('manage_settings', key)
  const tasks = useMyManualRuns()
  const taskCount = tasks.data?.data.length ?? 0

  const projectNav: NavItem[] = key
    ? [
        { to: `/p/${key}`, label: t('items.dashboard'), icon: LayoutDashboard, exact: true },
        { to: `/p/${key}/tests`, label: t('items.testCases'), icon: ListChecks },
        { to: `/p/${key}/flows`, label: t('items.flows'), icon: Workflow },
        { to: `/p/${key}/runs`, label: t('items.runs'), icon: Play },
        { to: `/p/${key}/environments`, label: t('items.environments'), icon: Layers },
        { to: `/p/${key}/settings`, label: t('items.settings'), icon: Settings, show: canSettings },
      ]
    : []

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-12 items-center gap-2 border-b border-sidebar-border px-3">
        <FlaskConical className="size-4 text-foreground" aria-hidden />
        <Link to="/" className="text-sm font-semibold tracking-tight">
          QAtlas
        </Link>
      </div>
      <div className="p-2">
        <ProjectSwitcher currentKey={key} />
      </div>
      <nav aria-label={t('projectNav')} className="flex flex-col gap-0.5 px-2">
        {projectNav.filter((i) => i.show !== false).map((i) => (
          <NavLink key={i.to} item={i} />
        ))}
      </nav>
      <div className="mx-3 my-3 h-px bg-sidebar-border" />
      <nav aria-label={t('globalNav')} className="flex flex-col gap-0.5 px-2">
        <NavLink item={{ to: '/projects', label: t('items.allProjects'), icon: FolderKanban, exact: true }} />
        <NavLink
          item={{ to: '/my-tasks', label: t('items.myTasks'), icon: Hand, badge: taskCount, ariaLabel: taskCount ? t('myTasksPending', { count: taskCount }) : undefined }}
        />
        {isAdmin && (
          <>
            <NavLink item={{ to: '/admin/users', label: t('items.adminUsers'), icon: Users }} />
            <NavLink item={{ to: '/admin/storage', label: t('items.adminStorage'), icon: HardDrive }} />
          </>
        )}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border p-2">
        <NavLink item={{ to: '/settings/profile', label: t('items.account'), icon: CircleUser }} />
        <NavLink item={{ to: '/settings/tokens', label: t('items.tokensMcp'), icon: KeyRound }} />
      </div>
    </div>
  )
}

function ProjectSwitcher({ currentKey }: { currentKey?: string }) {
  const { t } = useTranslation('nav')
  const me = useAuth()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const current = me.projects.find((p) => p.key === currentKey)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex h-10 w-full items-center gap-2 rounded-md border border-sidebar-border bg-background px-2 text-left text-sm hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
          aria-label={t('projectSwitcher.label')}
        >
          {current ? (
            <>
              <span className="rounded-sm bg-secondary px-1.5 font-mono text-xs font-medium">{current.key}</span>
              <span className="min-w-0 flex-1 truncate">{current.name}</span>
            </>
          ) : (
            <span className="flex-1 text-muted-foreground">{t('projectSwitcher.placeholder')}</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder={t('projectSwitcher.search')} />
          <CommandList>
            <CommandEmpty>{t('projectSwitcher.empty')}</CommandEmpty>
            <CommandGroup>
              {me.projects.map((p) => (
                <CommandItem
                  key={p.key}
                  value={`${p.key} ${p.name}`}
                  onSelect={() => {
                    setOpen(false)
                    navigate({ to: '/p/$key', params: { key: p.key } })
                  }}
                >
                  <span className="rounded-sm bg-secondary px-1.5 font-mono text-xs font-medium">{p.key}</span>
                  <span className="truncate">{p.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ topbar */

/** Segmen URL → kunci `nav:breadcrumbs.sections.*`. */
const SECTION_KEYS = {
  tests: 'tests',
  flows: 'flows',
  runs: 'runs',
  environments: 'environments',
  settings: 'settings',
  projects: 'projects',
  'my-tasks': 'myTasks',
  admin: 'admin',
  users: 'users',
  storage: 'storage',
  profile: 'profile',
  tokens: 'tokens',
} as const

function Breadcrumbs() {
  const { t } = useTranslation('nav')
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segs = pathname.split('/').filter(Boolean)
  const section = (seg: string) => (seg in SECTION_KEYS ? t(`breadcrumbs.sections.${SECTION_KEYS[seg as keyof typeof SECTION_KEYS]}`) : seg)
  const crumbs: { label: string; to?: string; mono?: boolean }[] = []
  if (segs[0] === 'p' && segs[1]) {
    crumbs.push({ label: segs[1], to: `/p/${segs[1]}`, mono: true })
    if (segs[2]) crumbs.push({ label: section(segs[2]), to: `/p/${segs[1]}/${segs[2]}` })
    if (segs[3]) crumbs.push({ label: segs[3] === 'new' ? t('breadcrumbs.new') : segs[3], mono: segs[3] !== 'new' })
  } else if (segs[0] === 'settings') {
    crumbs.push({ label: t('breadcrumbs.sections.account') })
    if (segs[1]) crumbs.push({ label: section(segs[1]) })
  } else {
    for (const s of segs) crumbs.push({ label: section(s) })
  }
  return (
    <nav aria-label={t('breadcrumbs.label')} className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-sm">
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <li key={i} className="flex min-w-0 items-center gap-1.5">
              {i > 0 && <span className="text-muted-foreground">/</span>}
              {c.to && !last ? (
                <Link to={c.to} className={cn('truncate text-muted-foreground hover:text-foreground', c.mono && 'font-mono text-xs')}>
                  {c.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cn('truncate', last ? 'font-medium' : 'text-muted-foreground', c.mono && 'font-mono text-xs')}>
                  {c.label}
                </span>
              )}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

function Topbar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  const { t } = useTranslation('nav')
  const me = useAuth()
  const { language, change: changeLanguage } = useChangeLanguage()
  const { theme, setTheme } = useTheme()
  const logout = useLogout()
  const navigate = useNavigate()
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/100 px-3 md:px-4">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onMenu} aria-label={t('topbar.openNav')}>
        <Menu />
      </Button>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSearch}
          className="hidden h-8 items-center gap-2 rounded-md border border-input bg-background px-2.5 text-sm text-muted-foreground hover:bg-accent sm:flex"
        >
          <Search className="size-4" aria-hidden />
          <span>{t('topbar.search')}</span>
          <Kbd className="ml-4">{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>
        <Button variant="ghost" size="icon-sm" className="sm:hidden" onClick={onSearch} aria-label={t('topbar.searchLabel')}>
          <Search />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('topbar.theme')}>
              {theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{t('topbar.theme')}</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
              <DropdownMenuRadioItem value="light">{t('topbar.themeLight')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">{t('topbar.themeDark')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">{t('topbar.themeSystem')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={t('topbar.accountMenu', { name: me.user.name })}>
              <Avatar name={me.user.name} className="size-7" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-56">
            <div className="px-2 py-1.5">
              <p className="truncate text-sm font-medium">{me.user.name}</p>
              <p className="truncate text-xs text-muted-foreground">{me.user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => navigate({ to: '/settings/profile' })}>
              <CircleUser /> {t('topbar.profile')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ to: '/settings/tokens' })}>
              <KeyRound /> {t('topbar.apiTokens')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-2">
              <Languages className="size-3.5" aria-hidden /> {t('topbar.language')}
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup aria-label={t('topbar.language')} value={language} onValueChange={(v) => void changeLanguage(v as Language)}>
              {LANGUAGES.map((l) => (
                <DropdownMenuRadioItem key={l.value} value={l.value} lang={l.value}>
                  {l.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                logout.mutate(undefined, {
                  onSettled: () => navigate({ to: '/login', search: {} }),
                })
              }
            >
              <LogOut /> {t('topbar.logout')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
