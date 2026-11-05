import { useNavigate, useParams } from '@tanstack/react-router'
import { CircleUser, FolderKanban, Hand, HardDrive, KeyRound, LayoutDashboard, ListChecks, LogIn, Play, Plus, Users, Workflow } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { useFlows, useTestCases } from '@/api/queries'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useAuth, useCan, useIsAdmin } from '../auth'

export function useCommandPalette() {
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return { open, setOpen }
}

export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const { t } = useTranslation('nav')
  const me = useAuth()
  const params = useParams({ strict: false }) as { key?: string }
  const key = params.key
  const navigate = useNavigate()
  const isAdmin = useIsAdmin()
  const canEdit = useCan('edit_tests', key)
  const [search, setSearch] = React.useState('')
  const tests = useTestCases(key ?? '', {})
  const flows = useFlows(key ?? '')
  const go = (to: string) => {
    onOpenChange(false)
    setSearch('')
    navigate({ to })
  }
  const runKeyMatch = /^([A-Z][A-Z0-9]{1,9})-R(\d+)$/i.exec(search.trim())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-hidden p-0" hideClose aria-describedby={undefined}>
        <DialogTitle className="sr-only">{t('palette.title')}</DialogTitle>
        <Command loop>
          <CommandInput placeholder={t('palette.placeholder')} value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[60vh]">
            <CommandEmpty>{t('palette.empty')}</CommandEmpty>
            {runKeyMatch && (
              <CommandGroup heading={t('palette.run')}>
                <CommandItem value={`run ${search}`} onSelect={() => go(`/p/${runKeyMatch[1].toUpperCase()}/runs/${search.trim().toUpperCase()}`)}>
                  <Play /> {t('palette.openRun')} <span className="font-mono">{search.trim().toUpperCase()}</span>
                </CommandItem>
              </CommandGroup>
            )}
            {key && (
              <CommandGroup heading={t('palette.project', { key })}>
                <CommandItem onSelect={() => go(`/p/${key}`)}><LayoutDashboard /> {t('items.dashboard')}</CommandItem>
                <CommandItem onSelect={() => go(`/p/${key}/tests`)}><ListChecks /> {t('items.testCases')}</CommandItem>
                <CommandItem onSelect={() => go(`/p/${key}/flows`)}><Workflow /> {t('items.flows')}</CommandItem>
                <CommandItem onSelect={() => go(`/p/${key}/runs`)}><Play /> {t('items.runs')}</CommandItem>
                {canEdit && <CommandItem onSelect={() => go(`/p/${key}/tests/new`)}><Plus /> {t('palette.newTestCase')}</CommandItem>}
                {canEdit && <CommandItem onSelect={() => go(`/p/${key}/flows/new`)}><Plus /> {t('palette.newFlow')}</CommandItem>}
              </CommandGroup>
            )}
            <CommandGroup heading={t('palette.navigation')}>
              <CommandItem onSelect={() => go('/projects')}><FolderKanban /> {t('items.allProjects')}</CommandItem>
              <CommandItem onSelect={() => go('/my-tasks')}><Hand /> {t('items.myTasks')}</CommandItem>
              {isAdmin && <CommandItem onSelect={() => go('/admin/users')}><Users /> {t('items.adminUsers')}</CommandItem>}
              {isAdmin && <CommandItem onSelect={() => go('/admin/storage')}><HardDrive /> {t('items.adminStorage')}</CommandItem>}
              {isAdmin && <CommandItem onSelect={() => go('/admin/google-sign-in')}><LogIn /> {t('items.adminGoogle')}</CommandItem>}
              <CommandItem onSelect={() => go('/settings/profile')}><CircleUser /> {t('items.account')}</CommandItem>
              <CommandItem onSelect={() => go('/settings/tokens')}><KeyRound /> {t('items.tokensMcp')}</CommandItem>
            </CommandGroup>
            <CommandGroup heading={t('palette.projects')}>
              {me.projects.map((p) => (
                <CommandItem key={p.key} value={`project ${p.key} ${p.name}`} onSelect={() => go(`/p/${p.key}`)}>
                  <span className="rounded-sm bg-secondary px-1.5 font-mono text-xs">{p.key}</span> {p.name}
                </CommandItem>
              ))}
            </CommandGroup>
            {key && (tests.data?.data.length ?? 0) > 0 && (
              <CommandGroup heading={t('palette.testCases')}>
                {tests.data!.data.map((t) => (
                  <CommandItem key={t.id} value={`${t.key} ${t.title}`} onSelect={() => go(`/p/${key}/tests/${t.key}`)}>
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{t.key}</span>
                    <span className="truncate">{t.title}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {key && (flows.data?.data.length ?? 0) > 0 && (
              <CommandGroup heading={t('palette.flows')}>
                {flows.data!.data.map((f) => (
                  <CommandItem key={f.id} value={`${f.key} ${f.name}`} onSelect={() => go(`/p/${key}/flows/${f.key}`)}>
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">{f.key}</span>
                    <span className="truncate">{f.name}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  )
}
