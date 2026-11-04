import { useParams } from '@tanstack/react-router'
import { Layers, MoreHorizontal, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import * as React from 'react'
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
        title="Environments"
        description="Variable dan secret per target pengujian, misalnya staging dan production."
        actions={
          canManage &&
          list.length > 0 && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> Environment
            </Button>
          )
        }
      />

      {envs.isError ? (
        <ErrorState error={envs.error} onRetry={() => envs.refetch()} />
      ) : envs.isPending ? (
        <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]" aria-busy="true">
          <span className="sr-only">Memuat environment…</span>
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
          title="Belum ada environment."
          description={
            canManage
              ? 'Environment menyimpan BASE_URL, kredensial, dan nilai lain yang berbeda per target. Run memakai environment default bila tidak dipilih.'
              : 'Minta maintainer project membuat environment agar test bisa dijalankan.'
          }
          action={
            canManage && (
              <Button onClick={() => setCreateOpen(true)}>
                <Plus /> Buat environment
              </Button>
            )
          }
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,1fr)] items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
          <nav aria-label="Daftar environment">
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
                            <span className="sr-only">(default)</span>
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
            <AlertDialogTitle>Buang perubahan variable?</AlertDialogTitle>
            <AlertDialogDescription>Perubahan variable di {selected?.name} belum disimpan dan akan hilang jika kamu pindah environment.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Lanjut edit</AlertDialogCancel>
            <AlertDialogAction
              destructive
              onClick={() => {
                setDirty(false)
                setSelectedId(pendingSwitch)
                setPendingSwitch(null)
              }}
            >
              Buang perubahan
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
  const { update } = useEnvironmentMutations(projectKey)
  const [renameOpen, setRenameOpen] = React.useState(false)
  const [deleteOpen, setDeleteOpen] = React.useState(false)

  const makeDefault = () =>
    update.mutate(
      { id: env.id, is_default: true },
      {
        onSuccess: () => toast.success(`${env.name} jadi environment default`),
        onError: (err) => toast.error(`Gagal mengubah default: ${errorMessage(err)}`),
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
                <Star className="size-3 fill-current" aria-hidden /> Default
              </span>
            )}
          </h2>
          <p className="text-xs text-muted-foreground">
            Diubah{' '}
            <time dateTime={env.updated_at} title={formatDateTime(env.updated_at)}>
              {relativeTime(env.updated_at, formatRelative)}
            </time>
            {env.is_default && ' · dipakai saat run tidak memilih environment'}
          </p>
        </div>
        {canManage && (
          <div className="flex shrink-0 items-center gap-2">
            {!env.is_default && (
              <Button variant="outline" size="sm" onClick={makeDefault} loading={update.isPending}>
                <Star /> Jadikan default
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={`Aksi lain untuk ${env.name}`}>
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem onSelect={() => setRenameOpen(true)}>
                  <Pencil /> Ganti nama
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => setDeleteOpen(true)}>
                  <Trash2 /> Hapus environment
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
