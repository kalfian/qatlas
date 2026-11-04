import { Link } from '@tanstack/react-router'
import { ArrowRight, Check, ChevronsUpDown, Trash2, UserPlus, Users } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useAssignableUsers, useMemberMutations, useMembers } from '@/api/queries'
import type { Member, ProjectRole, UserRef } from '@/api/types'
import { useAuth, useIsAdmin } from '@/app/auth'
import { ErrorState } from '@/components/page'
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
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tip } from '@/components/ui/tooltip'
import { formatDate, formatRelative } from '@/lib/format'
import { ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/permissions'
import { cn } from '@/lib/utils'
import { SettingsCard } from './SettingsCard'
import { relativeTime, useDelayedFlag } from './shared'

const ROLES: ProjectRole[] = ['maintainer', 'editor', 'viewer']
const ROLE_ORDER: Record<ProjectRole, number> = { maintainer: 0, editor: 1, viewer: 2 }

type Pending = { kind: 'remove'; member: Member } | { kind: 'self-demote'; member: Member; role: ProjectRole } | null

export function MembersSection({ projectKey }: { projectKey: string }) {
  const me = useAuth()
  const isAdmin = useIsAdmin()
  const members = useMembers(projectKey)
  const { update, remove } = useMemberMutations(projectKey)
  const [pending, setPending] = React.useState<Pending>(null)
  const showSkeleton = useDelayedFlag(members.isPending)

  const list = React.useMemo(
    () => [...(members.data?.data ?? [])].sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.user.name.localeCompare(b.user.name)),
    [members.data],
  )
  const maintainerCount = list.filter((m) => m.role === 'maintainer').length

  const applyRole = (m: Member, role: ProjectRole) =>
    update.mutate(
      { userId: m.user.id, role },
      {
        onSuccess: () => toast.success(`Role ${m.user.name} jadi ${ROLE_LABELS[role]}`),
        onError: (err) => toast.error(`Gagal mengubah role: ${errorMessage(err)}`),
      },
    )

  const changeRole = (m: Member, role: ProjectRole) => {
    if (role === m.role) return
    // maintainer non-admin yang menurunkan dirinya sendiri kehilangan akses halaman ini
    if (m.user.id === me.user.id && !isAdmin && role !== 'maintainer') setPending({ kind: 'self-demote', member: m, role })
    else applyRole(m, role)
  }

  return (
    <SettingsCard
      id="settings-members"
      title="Member"
      description="Siapa yang bisa membuka project ini dan apa yang boleh mereka lakukan."
      bodyClassName="flex flex-col px-0 pt-4 pb-0"
    >
      <AddMemberForm projectKey={projectKey} isAdmin={isAdmin} />

      {members.isError ? (
        <ErrorState error={members.error} onRetry={() => members.refetch()} className="mx-4 mb-4" />
      ) : members.isPending ? (
        <div aria-busy="true" className="border-t border-border">
          <span className="sr-only">Memuat member…</span>
          {Array.from({ length: 3 }, (_, i) => (
            <div key={i} className="flex h-12 items-center gap-3 border-b border-border px-4">
              {showSkeleton && (
                <>
                  <Skeleton className="size-6 rounded-full" />
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="ml-auto h-7 w-28" />
                </>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="border-t border-border">
          <Table>
            <caption className="sr-only">Member project {projectKey}</caption>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">
                  Member <span className="tabular font-normal">({list.length})</span>
                </TableHead>
                <TableHead>Role</TableHead>
                <TableHead className="hidden sm:table-cell">Ditambahkan</TableHead>
                <TableHead className="w-10 pr-4">
                  <span className="sr-only">Aksi</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {list.map((m) => {
                const isSelf = m.user.id === me.user.id
                const soleMaintainer = m.role === 'maintainer' && maintainerCount === 1
                const rowPending = update.isPending && update.variables?.userId === m.user.id
                return (
                  <TableRow key={m.user.id} className="h-12">
                    {/* w-full + max-w-0: kolom nama mengambil sisa lebar dan memotong teks, bukan melebarkan tabel */}
                    <TableCell className="w-full max-w-0 pl-4">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={m.user.name} />
                        <div className="min-w-0">
                          <p className="truncate font-medium">
                            {m.user.name}
                            {isSelf && <span className="ml-1.5 text-xs font-normal text-muted-foreground">(kamu)</span>}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">{m.user.email}</p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {soleMaintainer ? (
                        <span className="text-sm">
                          Maintainer
                          <span className="block text-xs text-muted-foreground">satu-satunya maintainer</span>
                        </span>
                      ) : (
                        <Select value={m.role} onValueChange={(v) => changeRole(m, v as ProjectRole)} disabled={rowPending}>
                          <SelectTrigger className="h-7 w-[6.75rem] sm:w-[7.5rem]" aria-label={`Role ${m.user.name}`} aria-busy={rowPending || undefined}>
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {ROLES.map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABELS[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </TableCell>
                    <TableCell className="hidden whitespace-nowrap text-muted-foreground sm:table-cell">
                      <time dateTime={m.added_at} title={formatDate(m.added_at)}>
                        {relativeTime(m.added_at, formatRelative)}
                      </time>
                    </TableCell>
                    <TableCell className="py-0 pr-4 text-right">
                      {soleMaintainer ? (
                        <Tip label="Project harus punya minimal satu maintainer">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-disabled="true"
                            aria-label={`Hapus ${m.user.name} dari project (tidak tersedia: project harus punya minimal satu maintainer)`}
                            onClick={(e) => e.preventDefault()}
                            className="text-muted-foreground"
                          >
                            <Trash2 />
                          </Button>
                        </Tip>
                      ) : (
                        <Tip label="Hapus dari project">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={`Hapus ${m.user.name} dari project`}
                            onClick={() => setPending({ kind: 'remove', member: m })}
                            className="text-muted-foreground hover:text-destructive"
                          >
                            <Trash2 />
                          </Button>
                        </Tip>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <dl className="grid gap-2 border-t border-border px-4 py-4 text-sm sm:grid-cols-[6.5rem_minmax(0,1fr)] sm:gap-x-4">
        {ROLES.map((r) => (
          <React.Fragment key={r}>
            <dt className="font-medium">{ROLE_LABELS[r]}</dt>
            <dd className="-mt-1.5 text-muted-foreground sm:mt-0">{ROLE_DESCRIPTIONS[r]}</dd>
          </React.Fragment>
        ))}
      </dl>

      <AlertDialog open={pending != null} onOpenChange={(o) => !o && !remove.isPending && setPending(null)}>
        <AlertDialogContent>
          {pending?.kind === 'remove' && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  Hapus {pending.member.user.name} dari {projectKey}?
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {pending.member.user.id === me.user.id
                    ? 'Kamu tidak akan bisa membuka project ini lagi kecuali ditambahkan kembali.'
                    : `${pending.member.user.name} tidak bisa lagi membuka project ini.`}{' '}
                  Test case, flow, dan run yang pernah dibuat tetap tersimpan.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={remove.isPending}>Batal</AlertDialogCancel>
                <Button
                  variant="destructive"
                  loading={remove.isPending}
                  onClick={() => {
                    const m = pending.member
                    remove.mutate(m.user.id, {
                      onSuccess: () => {
                        toast.success(`${m.user.name} dihapus dari ${projectKey}`)
                        setPending(null)
                      },
                      onError: (err) => toast.error(`Gagal menghapus member: ${errorMessage(err)}`),
                    })
                  }}
                >
                  Hapus member
                </Button>
              </AlertDialogFooter>
            </>
          )}
          {pending?.kind === 'self-demote' && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Turunkan role kamu jadi {ROLE_LABELS[pending.role]}?</AlertDialogTitle>
                <AlertDialogDescription>
                  Kamu akan kehilangan akses ke pengaturan, member, dan environment project ini. Maintainer lain perlu mengembalikannya.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Batal</AlertDialogCancel>
                <Button
                  variant="destructive"
                  onClick={() => {
                    applyRole(pending.member, pending.role)
                    setPending(null)
                  }}
                >
                  Turunkan role
                </Button>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}

/* ------------------------------------------------------------------ add member */

function AddMemberForm({ projectKey, isAdmin }: { projectKey: string; isAdmin: boolean }) {
  const assignable = useAssignableUsers(projectKey)
  const { add } = useMemberMutations(projectKey)
  const [open, setOpen] = React.useState(false)
  const [user, setUser] = React.useState<UserRef | null>(null)
  const [role, setRole] = React.useState<ProjectRole>('editor')
  const [error, setError] = React.useState<string | null>(null)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const users = assignable.data?.data ?? []

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!user) {
      setError('Pilih user yang akan ditambahkan')
      triggerRef.current?.focus()
      return
    }
    add.mutate(
      { user_id: user.id, role },
      {
        onSuccess: () => {
          toast.success(`${user.name} ditambahkan sebagai ${ROLE_LABELS[role]}`)
          setUser(null)
          setError(null)
          triggerRef.current?.focus()
        },
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="grid gap-2 px-4 pb-5" aria-labelledby="add-member-title">
      <h3 id="add-member-title" className="text-sm font-medium">
        Tambah member
      </h3>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-start">
        <div className="grid gap-1">
          <Label htmlFor="add-member-user" className="sr-only">
            User
          </Label>
          <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
              <Button
                ref={triggerRef}
                id="add-member-user"
                type="button"
                variant="outline"
                role="combobox"
                aria-expanded={open}
                aria-invalid={error ? true : undefined}
                aria-describedby={error ? 'add-member-error' : undefined}
                className={cn('w-full justify-between px-2.5 font-normal', !user && 'text-muted-foreground', error && 'border-destructive')}
              >
                <span className="truncate">{user ? `${user.name} · ${user.email}` : 'Pilih user terdaftar…'}</span>
                <ChevronsUpDown className="opacity-60" aria-hidden />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[var(--radix-popover-trigger-width)] min-w-72 p-0">
              <Command>
                <CommandInput placeholder="Cari nama atau email…" aria-label="Cari user" />
                <CommandList>
                  {assignable.isPending ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">Memuat user…</p>
                  ) : assignable.isError ? (
                    <p className="px-3 py-4 text-sm text-destructive">{errorMessage(assignable.error)}</p>
                  ) : users.length === 0 ? (
                    <p className="px-3 py-4 text-sm text-muted-foreground">Semua user aktif sudah jadi member project ini.</p>
                  ) : (
                    <>
                      <CommandEmpty>Tidak ada user yang cocok.</CommandEmpty>
                      <CommandGroup>
                        {users.map((u) => (
                          <CommandItem
                            key={u.id}
                            value={`${u.name} ${u.email}`}
                            onSelect={() => {
                              setUser(u)
                              setError(null)
                              setOpen(false)
                            }}
                          >
                            <Avatar name={u.name} />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate">{u.name}</span>
                              <span className="block truncate text-xs text-muted-foreground">{u.email}</span>
                            </span>
                            {user?.id === u.id && <Check aria-hidden />}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </>
                  )}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <div>
          <Label htmlFor="add-member-role" className="sr-only">
            Role
          </Label>
          <Select value={role} onValueChange={(v) => setRole(v as ProjectRole)}>
            <SelectTrigger id="add-member-role" aria-describedby="add-member-role-desc">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABELS[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button type="submit" loading={add.isPending}>
          <UserPlus /> Tambah
        </Button>
      </div>
      {error ? (
        <p id="add-member-error" className="text-xs text-destructive">
          {error}
        </p>
      ) : add.isError ? (
        <p role="alert" className="text-xs text-destructive">
          {errorMessage(add.error)}
        </p>
      ) : (
        <p id="add-member-role-desc" className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{ROLE_LABELS[role]}</span> · {ROLE_DESCRIPTIONS[role]}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        <Users className="mr-1 inline size-3.5 align-[-3px]" aria-hidden />
        Hanya user yang sudah terdaftar dan aktif yang bisa dipilih.{' '}
        {isAdmin ? (
          <Link to="/admin/users" className="inline-flex items-center gap-0.5 rounded-sm text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Undang orang baru di Admin · Users <ArrowRight className="size-3" aria-hidden />
          </Link>
        ) : (
          <span>Minta admin mengundang orang baru.</span>
        )}
      </p>
    </form>
  )
}
