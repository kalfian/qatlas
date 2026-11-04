import { useParams } from '@tanstack/react-router'
import { Layers, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useEnvironmentMutations, useEnvironments } from '@/api/queries'
import type { Environment } from '@/api/types'
import { useCan } from '@/app/auth'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { relativeTime, useDelayedFlag } from '@/features/settings/shared'
import { DeleteEnvironmentDialog, EnvironmentNameDialog } from './dialogs'
import { SecretCountHint, SecretsSection, VariablesSection } from './sections'

export function EnvironmentsPage() {
  const { key } = useParams({ from: '/_app/p/$key/environments' })
  const { t } = useTranslation(['environments', 'common'])
  const canManage = useCan('manage_environments', key)
  const envs = useEnvironments(key)
  const list = React.useMemo(() => envs.data?.data ?? [], [envs.data])

  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [createOpen, setCreateOpen] = React.useState(false)
  const [dirty, setDirty] = React.useState(false)
  const [pendingSwitch, setPendingSwitch] = React.useState<string | null>(null)
  const showSkeleton = useDelayedFlag(envs.isPending)

  const selected = list.find((e) => e.id === selectedId) ?? list.find((e) => e.is_default) ?? list[0]

  const select = (id: string) => {
    if (id === selected?.id) return
    if (dirty) setPendingSwitch(id)
    else setSelectedId(id)
  }

  return (
    <PageContainer>
      <PageHeader
        title={t('page.title')}
        description={t('page.description')}
        actions={
          canManage &&
          list.length > 0 && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> {t('page.add')}
            </Button>
          )
        }
      />

      {envs.isError ? (
        <ErrorState error={envs.error} onRetry={() => envs.refetch()} />
      ) : envs.isPending ? (
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]" aria-busy="true">
          <span className="sr-only">{t('page.loading')}</span>
          {showSkeleton && (
            <>
              <div className="grid content-start gap-1">
                <Skeleton className="h-12" />
                <Skeleton className="h-12" />
              </div>
              <div className="grid gap-4">
                <Skeleton className="h-8 w-48" />
                <Skeleton className="h-48" />
                <Skeleton className="h-32" />
              </div>
            </>
          )}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={Layers}
          title={t('page.emptyTitle')}
          description={canManage ? t('page.emptyManage') : t('page.emptyViewer')}
          action={
            canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> {t('page.create')}
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label={t('page.listLabel')}>
            <ul className="grid gap-0.5">
              {list.map((e) => {
                const active = e.id === selected?.id
                return (
                  <li key={e.id}>
                    <button
                      type="button"
                      onClick={() => select(e.id)}
                      aria-current={active ? 'true' : undefined}
                      className={cn(
                        'relative flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                        active && 'bg-accent before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-ring',
                      )}
                    >
                      <span className="flex w-full items-center gap-1.5">
                        <span className={cn('truncate font-mono text-sm', active && 'font-medium')}>{e.name}</span>
                        {e.is_default && (
                          <>
                            <Star className="size-3.5 shrink-0 fill-current text-muted-foreground" aria-hidden />
                            <span className="sr-only">{t('page.defaultSr')}</span>
                          </>
                        )}
                      </span>
                      <SecretCountHint env={e} />
                    </button>
                  </li>
                )
              })}
            </ul>
          </nav>

          {selected && (
            <EnvironmentDetail
              key={selected.id}
              projectKey={key}
              env={selected}
              allEnvs={list}
              canManage={canManage}
              onDirtyChange={setDirty}
              onDeleted={() => setSelectedId(null)}
            />
          )}
        </div>
      )}

      {canManage && (
        <EnvironmentNameDialog
          projectKey={key}
          open={createOpen}
          onOpenChange={setCreateOpen}
          existing={list}
          onCreated={(e) => {
            setDirty(false)
            setSelectedId(e.id)
          }}
        />
      )}

      <AlertDialog open={pendingSwitch != null} onOpenChange={(o) => !o && setPendingSwitch(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('page.discardTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('page.discardDescription', { name: selected?.name ?? '' })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('page.keepEditing')}</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                setDirty(false)
                setSelectedId(pendingSwitch)
                setPendingSwitch(null)
              }}
            >
              {t('page.discardConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageContainer>
  )
}

function EnvironmentDetail({ projectKey, env, allEnvs, canManage, onDirtyChange, onDeleted }: {
  projectKey: string
  env: Environment
  allEnvs: Environment[]
  canManage: boolean
  onDirtyChange: (d: boolean) => void
  onDeleted: () => void
}) {
  const { t } = useTranslation('environments')
  const { update } = useEnvironmentMutations(projectKey)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const makeDefault = () =>
    update.mutate(
      { id: env.id, is_default: true },
      {
        onSuccess: () => toast.success(t('detail.madeDefault', { name: env.name })),
        onError: (err) => toast.error(t('detail.makeDefaultFailed', { message: errorMessage(err) })),
      },
    )

  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <span className="truncate font-mono">{env.name}</span>
            {env.is_default && (
              <span className="inline-flex h-5 items-center gap-1 rounded-sm bg-secondary px-1.5 font-sans text-xs font-medium text-secondary-foreground">
                <Star className="size-3 fill-current" aria-hidden /> {t('detail.default')}
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            <Trans
              t={t}
              i18nKey="detail.updated"
              values={{ time: relativeTime(env.updated_at, formatRelative) }}
              components={{ time: <time dateTime={env.updated_at} title={formatDateTime(env.updated_at)} /> }}
            />
            {env.is_default && t('detail.defaultHint')}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {!env.is_default && (
              <Button variant="outline" size="sm" onClick={makeDefault} loading={update.isPending}>
                <Star /> {t('detail.makeDefault')}
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t('detail.moreActions', { name: env.name })}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil /> {t('detail.rename')}
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                  <Trash2 /> {t('detail.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>

      <VariablesSection projectKey={projectKey} env={env} canManage={canManage} onDirtyChange={onDirtyChange} />
      <SecretsSection projectKey={projectKey} env={env} allEnvs={allEnvs} canManage={canManage} />

      {canManage && (
        <>
          <EnvironmentNameDialog projectKey={projectKey} open={renameOpen} onOpenChange={setRenameOpen} env={env} existing={allEnvs} />
          <DeleteEnvironmentDialog projectKey={projectKey} env={env} open={deleteOpen} onOpenChange={setDeleteOpen} onDeleted={onDeleted} />
        </>
      )}
    </div>
  )
}
