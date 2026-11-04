import { Link, Outlet, useMatchRoute, useNavigate, useParams, useRouterState } from '@tanstack/react-router'
import {
  ChevronsUpDown,
  CircleUser,
  FlaskConical,
  FolderKanban,
  Hand,
  KeyRound,
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
import { Toaster } from 'sonner'
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
import { TooltipProvider } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { useAuth, useCan, useIsAdmin } from '../auth'
import { IS_MOCK, rememberProject } from '../config'
import { useTheme } from '../theme'
import { CommandPalette, useCommandPalette } from './CommandPalette'
import { DevToolbar } from './DevToolbar'

/* ------------------------------------------------------------------ root */

export function RootLayout() {
  const { theme } = useTheme()
  const resolved = theme === 'system' ? undefined : theme
  return (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster position="bottom-right" theme={resolved ?? 'system'} toastOptions={{ className: 'text-sm' }} closeButton />
      {IS_MOCK && <DevToolbar />}
    </TooltipProvider>
  )
}

export function NotFoundPage() {
  return (
    <div className="flex min-h-dvh flex-col items-start justify-center gap-2 px-6 md:px-16">
      <p className="font-mono text-xs text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">Halaman tidak ditemukan</h1>
      <p className="text-sm text-muted-foreground">Alamat yang kamu buka tidak ada atau sudah dipindah.</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/">Kembali ke beranda</Link>
      </Button>
    </div>
  )
}

/* ------------------------------------------------------------------ shell */

export function AppShell() {
  const [mobileNav, setMobileNav] = React.useState(false)
  const palette = useCommandPalette()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  React.useEffect(() => setMobileNav(false), [pathname])

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:ring-2 focus:ring-ring">
        Lompat ke konten
      </a>
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-sidebar-border bg-sidebar lg:block">
        <Sidebar />
      </aside>
      <Dialog open={mobileNav} onOpenChange={setMobileNav}>
        <SheetContent side="left" className="w-64 bg-sidebar p-0" aria-describedby={undefined}>
          <span className="sr-only" id="mobile-nav-title">
            Navigasi
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
  const params = useParams({ strict: false }) as { key?: string }
  const key = params.key
  const isAdmin = useIsAdmin()
  const canSettings = useCan('manage_settings', key)
  const tasks = useMyManualRuns()
  const taskCount = tasks.data?.data.length ?? 0

  const projectNav: NavItem[] = key
    ? [
        { to: `/p/${key}`, label: 'Dashboard', icon: LayoutDashboard, exact: true },
        { to: `/p/${key}/tests`, label: 'Test cases', icon: ListChecks },
        { to: `/p/${key}/flows`, label: 'Flows', icon: Workflow },
        { to: `/p/${key}/runs`, label: 'Runs', icon: Play },
        { to: `/p/${key}/environments`, label: 'Environments', icon: Layers },
        { to: `/p/${key}/settings`, label: 'Pengaturan', icon: Settings, show: canSettings },
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
      <nav aria-label="Navigasi project" className="flex flex-col gap-0.5 px-2">
        {projectNav.filter((i) => i.show !== false).map((i) => (
          <NavLink key={i.to} item={i} />
        ))}
      </nav>
      <div className="mx-3 my-3 h-px bg-sidebar-border" />
      <nav aria-label="Navigasi global" className="flex flex-col gap-0.5 px-2">
        <NavLink item={{ to: '/projects', label: 'Semua project', icon: FolderKanban, exact: true }} />
        <NavLink item={{ to: '/my-tasks', label: 'Tugas saya', icon: Hand, badge: taskCount, ariaLabel: taskCount ? `Tugas saya, ${taskCount} menunggu` : undefined }} />
        {isAdmin && <NavLink item={{ to: '/admin/users', label: 'Admin · Users', icon: Users }} />}
      </nav>
      <div className="mt-auto flex flex-col gap-0.5 border-t border-sidebar-border p-2">
        <NavLink item={{ to: '/settings/profile', label: 'Akun', icon: CircleUser }} />
        <NavLink item={{ to: '/settings/tokens', label: 'API token & MCP', icon: KeyRound }} />
      </div>
    </div>
  )
}

function ProjectSwitcher({ currentKey }: { currentKey?: string }) {
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
          aria-label="Pilih project"
        >
          {current ? (
            <>
              <span className="rounded-sm bg-secondary px-1.5 font-mono text-xs font-medium">{current.key}</span>
              <span className="min-w-0 flex-1 truncate">{current.name}</span>
            </>
          ) : (
            <span className="flex-1 text-muted-foreground">Pilih project…</span>
          )}
          <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Cari project…" />
          <CommandList>
            <CommandEmpty>Tidak ada project</CommandEmpty>
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

const SECTION_LABELS: Record<string, string> = {
  tests: 'Test cases',
  flows: 'Flows',
  runs: 'Runs',
  environments: 'Environments',
  settings: 'Pengaturan',
  projects: 'Project',
  'my-tasks': 'Tugas saya',
  admin: 'Admin',
  users: 'Users',
  profile: 'Akun',
  tokens: 'API token',
}

function Breadcrumbs() {
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const segs = pathname.split('/').filter(Boolean)
  const crumbs: { label: string; to?: string; mono?: boolean }[] = []
  if (segs[0] === 'p' && segs[1]) {
    crumbs.push({ label: segs[1], to: `/p/${segs[1]}`, mono: true })
    if (segs[2]) crumbs.push({ label: SECTION_LABELS[segs[2]] ?? segs[2], to: `/p/${segs[1]}/${segs[2]}` })
    if (segs[3]) crumbs.push({ label: segs[3] === 'new' ? 'Baru' : segs[3], mono: segs[3] !== 'new' })
  } else if (segs[0] === 'settings') {
    crumbs.push({ label: 'Akun' })
    if (segs[1]) crumbs.push({ label: SECTION_LABELS[segs[1]] ?? segs[1] })
  } else {
    for (const s of segs) crumbs.push({ label: SECTION_LABELS[s] ?? s })
  }
  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
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
  const me = useAuth()
  const { theme, setTheme } = useTheme()
  const logout = useLogout()
  const navigate = useNavigate()
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-background/100 px-3 md:px-4">
      <Button variant="ghost" size="icon-sm" className="lg:hidden" onClick={onMenu} aria-label="Buka navigasi">
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
          <span>Cari…</span>
          <Kbd className="ml-4">{isMac ? '⌘K' : 'Ctrl K'}</Kbd>
        </button>
        <Button variant="ghost" size="icon-sm" className="sm:hidden" onClick={onSearch} aria-label="Cari">
          <Search />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Tema">
              {theme === 'dark' ? <Moon /> : theme === 'light' ? <Sun /> : <Monitor />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>Tema</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={theme} onValueChange={(v) => setTheme(v as typeof theme)}>
              <DropdownMenuRadioItem value="light">Terang</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark">Gelap</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="system">Sistem</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label={`Menu akun ${me.user.name}`}>
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
              <CircleUser /> Profil
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ to: '/settings/tokens' })}>
              <KeyRound /> API token
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                logout.mutate(undefined, {
                  onSettled: () => navigate({ to: '/login', search: {} }),
                })
              }
            >
              <LogOut /> Keluar
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
