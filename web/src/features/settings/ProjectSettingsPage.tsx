import { Link, useParams, useSearch } from '@tanstack/react-router'
import { Lock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useProject } from '@/api/queries'
import { useCan } from '@/app/auth'
import type { SettingsSearch } from '@/app/router'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { DangerSection } from './DangerSection'
import { GeneralSection } from './GeneralSection'
import { MembersSection } from './MembersSection'
import { RetentionSection, RunDefaultsSection } from './RunSections'
import { useDelayedFlag } from './shared'

type SectionId = NonNullable<SettingsSearch['section']>

const SECTIONS = [
  { id: 'general', label: 'page.sections.general' },
  { id: 'members', label: 'page.sections.members' },
  { id: 'run-defaults', label: 'page.sections.runDefaults' },
  { id: 'retention', label: 'page.sections.retention' },
  { id: 'danger', label: 'page.sections.danger' },
] as const satisfies readonly { id: SectionId; label: string }[]

export function ProjectSettingsPage() {
  const { key } = useParams({ from: '/_app/p/$key/settings' })
  const { section = 'general' } = useSearch({ from: '/_app/p/$key/settings' })
  const { t } = useTranslation('settings')
  const canManage = useCan('manage_settings', key)
  const project = useProject(key)
  const showSkeleton = useDelayedFlag(project.isPending)

  if (!canManage) {
    return (
      <PageContainer narrow>
        <PageHeader title={t('page.title')} />
        <EmptyState
          icon={Lock}
          title={t('page.noAccessTitle')}
          description={t('page.noAccessDescription')}
        />
      </PageContainer>
    )
  }

  return (
    <PageContainer className="max-w-5xl">
      <PageHeader title={t('page.title')} description={project.data ? `${project.data.name} · ${key}` : key} />
      <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 md:grid-cols-[168px_minmax(0,1fr)] md:gap-8">
        <nav aria-label={t('page.sectionsLabel')} className="-mx-4 overflow-x-auto px-4 md:mx-0 md:overflow-visible md:px-0">
          <ul className="flex gap-1 border-b border-border pb-px md:flex-col md:gap-0.5 md:border-0 md:pb-0">
            {SECTIONS.map((s) => {
              const active = s.id === section
              return (
                <li key={s.id} className="shrink-0">
                  <Link
                    to="/p/$key/settings"
                    params={{ key }}
                    search={{ section: s.id }}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'relative flex h-8 items-center rounded-md px-2.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      active && 'font-medium text-foreground max-md:after:absolute max-md:after:inset-x-2.5 max-md:after:-bottom-px max-md:after:h-0.5 max-md:after:bg-ring md:bg-accent md:before:absolute md:before:inset-y-1.5 md:before:left-0 md:before:w-0.5 md:before:rounded-full md:before:bg-ring',
                      s.id === 'danger' && 'text-destructive hover:text-destructive',
                    )}
                  >
                    {t(s.label)}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>

        <div className="min-w-0 max-w-3xl">
          {project.isError ? (
            <ErrorState error={project.error} onRetry={() => project.refetch()} />
          ) : project.isPending ? (
            <div className="grid gap-3" aria-busy="true">
              <span className="sr-only">{t('page.loading')}</span>
              {showSkeleton && (
                <>
                  <Skeleton className="h-6 w-40" />
                  <Skeleton className="h-56" />
                </>
              )}
            </div>
          ) : section === 'general' ? (
            <GeneralSection key={project.data.id} project={project.data} />
          ) : section === 'members' ? (
            <MembersSection projectKey={key} />
          ) : section === 'run-defaults' ? (
            <RunDefaultsSection key={project.data.id} project={project.data} />
          ) : section === 'retention' ? (
            <RetentionSection key={project.data.id} project={project.data} />
          ) : (
            <DangerSection project={project.data} />
          )}
        </div>
      </div>
    </PageContainer>
  )
}
