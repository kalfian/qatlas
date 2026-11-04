import { Ban, KeyRound, Link2, MailPlus, MoreHorizontal, Plus, Search, ShieldCheck, UserCheck, UserRound, UsersRound, UserX } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useAdminInviteLink, useAdminUpdateUser, useAdminUsers } from '@/api/queries'
import type { SystemRole, User, UserInvite, UserStatus } from '@/api/types'
import { useAuth } from '@/app/auth'
import { EmptyState, ErrorState, PageContainer, PageHeader } from '@/components/page'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Avatar } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Banner, Delayed } from '@/features/auth/shared'
import { formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CreateUserDialog, InviteLinkDialog, type LinkDialogState } from './UserDialogs'

export const ROLE_LABEL: Record<SystemRole, string> = { admin: 'Admin', member: 'Member' }

const STATUS_META: Record<UserStatus, { label: string; icon: typeof UserCheck }> = {
  invited: { label: 'Invited', icon: MailPlus },
  active: { label: 'Active', icon: UserCheck },
  disabled: { label: 'Disabled', icon: UserX },
}

function UserStatusBadge({ status }: { status: UserStatus }) {
  const m = STATUS_META[status]
  return (
    <Badge variant={status === 'invited' ? 'outline' : 'default'} className={cn(status === 'disabled' && 'bg-transparent px-0 text-muted-foreground')}>
      <m.icon aria-hidden />
      {m.label}
    </Badge>
  )
}

export function AdminUsersPage() {
  const users = useAdminUsers()
  const [q, setQ] = React.useState('')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [link, setLink] = React.useState<LinkDialogState | null>(null)
  const [disabling, setDisabling] = React.useState<User | null>(null)

  const list = users.data?.data ?? []
  const needle = q.trim().toLowerCase()
  const filtered = needle ? list.filter((u) => u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle)) : list
  const counts = {
    active: list.filter((u) => u.status === 'active').length,
    invited: list.filter((u) => u.status === 'invited').length,
  }

  return (
    <PageContainer>
      <PageHeader
        title="Users"
        description="Hanya user yang dibuat di sini yang bisa masuk. Tidak ada pendaftaran mandiri."
        meta={
          users.data ? (
            <>
              <span className="tabular">{counts.active} active</span>
              <span className="tabular">{counts.invited} menunggu undangan</span>
            </>
          ) : undefined
        }
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus /> Buat user
          </Button>
        }
      />

      {users.isPending ? (
        <UsersSkeleton />
      ) : users.isError ? (
        <ErrorState error={users.error} onRetry={() => users.refetch()} />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
            <Input
              type="search"
              placeholder="Cari nama atau email…"
              aria-label="Cari user"
              className="pl-8"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          {filtered.length === 0 ? (
            <EmptyState
              icon={UsersRound}
              title={`Tidak ada user yang cocok dengan “${q.trim()}”`}
              action={
                <Button variant="outline" size="sm" onClick={() => setQ('')}>
                  Reset pencarian
                </Button>
              }
            />
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nama</TableHead>
                    <TableHead className="hidden md:table-cell">Email</TableHead>
                    <TableHead className="hidden sm:table-cell">System role</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden lg:table-cell">Login terakhir</TableHead>
                    <TableHead>
                      <span className="sr-only">Aksi</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((u) => (
                    <UserRow key={u.id} user={u} onLink={setLink} onDisable={() => setDisabling(u)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>
      )}

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <InviteLinkDialog state={link} onClose={() => setLink(null)} />
      <DisableDialog user={disabling} onClose={() => setDisabling(null)} />
    </PageContainer>
  )
}

function UserRow({ user: u, onLink, onDisable }: { user: User; onLink: (s: LinkDialogState) => void; onDisable: () => void }) {
  const me = useAuth()
  const isSelf = u.id === me.user.id
  const update = useAdminUpdateUser()
  const inviteLink = useAdminInviteLink()
  const disabled = u.status === 'disabled'

  const makeLink = () => {
    const kind = u.status === 'invited' ? 'invite' : 'reset_password'
    onLink({ user: u, kind, result: null })
    inviteLink.mutate(u.id, {
      onSuccess: (res: UserInvite) => onLink({ user: u, kind, result: res }),
      onError: (err) => {
        onLink({ user: u, kind, result: null, error: errorMessage(err) })
      },
    })
  }

  const setRole = (role: SystemRole) => {
    if (role === u.system_role) return
    update.mutate(
      { id: u.id, system_role: role },
      {
        onSuccess: () => toast.success(`${u.name} sekarang ${ROLE_LABEL[role]}`),
        onError: (err) => toast.error(`Gagal mengubah role: ${errorMessage(err)}`),
      },
    )
  }

  const enable = () =>
    update.mutate(
      { id: u.id, status: 'active' },
      {
        onSuccess: () => toast.success(`${u.name} diaktifkan lagi`),
        onError: (err) => toast.error(`Gagal mengaktifkan: ${errorMessage(err)}`),
      },
    )

  return (
    <TableRow className={cn(disabled && 'text-muted-foreground')} aria-busy={update.isPending || undefined}>
      <TableCell className="max-w-56 sm:max-w-none sm:min-w-48">
        <div className="flex items-center gap-2.5">
          <Avatar name={u.name} className={cn(disabled && 'opacity-60')} />
          <div className="flex min-w-0 flex-col">
            <span className={cn('truncate font-medium', disabled ? 'text-muted-foreground' : 'text-foreground')}>
              {u.name}
              {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(kamu)</span>}
            </span>
            <span className="truncate font-mono text-xs text-muted-foreground md:hidden">{u.email}</span>
            <span className="text-xs text-muted-foreground sm:hidden">{ROLE_LABEL[u.system_role]}</span>
          </div>
        </div>
      </TableCell>
      <TableCell className="hidden font-mono text-xs md:table-cell">{u.email}</TableCell>
      <TableCell className="hidden whitespace-nowrap sm:table-cell">
        <span className="inline-flex items-center gap-1.5">
          {u.system_role === 'admin' ? (
            <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden />
          ) : (
            <UserRound className="size-3.5 text-muted-foreground" aria-hidden />
          )}
          {ROLE_LABEL[u.system_role]}
        </span>
      </TableCell>
      <TableCell>
        <UserStatusBadge status={u.status} />
      </TableCell>
      <TableCell className="hidden whitespace-nowrap lg:table-cell">
        {u.last_login_at ? <time dateTime={u.last_login_at}>{formatRelative(u.last_login_at)}</time> : <span className="text-muted-foreground">Belum pernah</span>}
      </TableCell>
      <TableCell className="w-px text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Aksi untuk ${u.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-60">
            {u.status === 'invited' && (
              <DropdownMenuItem onSelect={makeLink}>
                <Link2 /> Buat ulang link undangan
              </DropdownMenuItem>
            )}
            {u.status === 'active' && (
              <DropdownMenuItem onSelect={makeLink}>
                <KeyRound /> Buat link reset password
              </DropdownMenuItem>
            )}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger disabled={isSelf}>
                <ShieldCheck /> Ubah role
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioGroup value={u.system_role} onValueChange={(v) => setRole(v as SystemRole)}>
                  <DropdownMenuRadioItem value="member">
                    <span className="flex flex-col">
                      Member
                      <span className="text-xs text-muted-foreground">Akses per project</span>
                    </span>
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value="admin">
                    <span className="flex flex-col">
                      Admin
                      <span className="text-xs text-muted-foreground">Kelola user & semua project</span>
                    </span>
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator />
            {disabled ? (
              <DropdownMenuItem onSelect={enable}>
                <UserCheck /> Aktifkan lagi
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem destructive disabled={isSelf} onSelect={onDisable}>
                <Ban /> Nonaktifkan
              </DropdownMenuItem>
            )}
            {isSelf && (
              <DropdownMenuLabel className="font-normal">Role dan status akunmu sendiri tidak bisa kamu ubah.</DropdownMenuLabel>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  )
}

function DisableDialog({ user, onClose }: { user: User | null; onClose: () => void }) {
  const update = useAdminUpdateUser()
  const [last, setLast] = React.useState<User | null>(user)
  if (user && user !== last) setLast(user)
  const u = user ?? last
  const first = u?.name.split(/\s+/)[0] ?? ''

  const confirm = () => {
    if (!u) return
    update.mutate(
      { id: u.id, status: 'disabled' },
      {
        onSuccess: () => {
          toast.success(`${u.name} dinonaktifkan`)
          onClose()
        },
      },
    )
  }

  return (
    <AlertDialog
      open={!!user}
      onOpenChange={(o) => {
        if (!o && !update.isPending) {
          update.reset()
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Nonaktifkan {u?.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Semua session dan API token {first} akan dicabut. {first} tidak bisa masuk sampai diaktifkan lagi; data test case dan run tetap tersimpan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {update.isError && <Banner>{errorMessage(update.error)}</Banner>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={update.isPending}>Batal</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} loading={update.isPending}>
            Nonaktifkan
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function UsersSkeleton() {
  return (
    <Delayed>
      <div className="flex flex-col gap-3" aria-hidden>
        <Skeleton className="h-8 w-full max-w-xs" />
        <div className="rounded-md border border-border">
          <div className="h-8 border-b border-border" />
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex h-11 items-center gap-6 border-b border-border px-3 last:border-0">
              <Skeleton className="size-6 rounded-full" />
              <Skeleton className="h-3.5 w-36" />
              <Skeleton className="hidden h-3.5 w-44 md:block" />
              <Skeleton className="h-3.5 w-16" />
            </div>
          ))}
        </div>
      </div>
    </Delayed>
  )
}
