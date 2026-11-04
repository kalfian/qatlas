import { KeyRound, Plus, TerminalSquare } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useRevokeToken, useTokens } from '@/api/queries'
import type { ApiToken } from '@/api/types'
import { EmptyState, ErrorState, PageContainer, PageHeader, Panel } from '@/components/page'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Banner, Delayed } from '@/features/auth/shared'
import { formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CopyBlock, CreateTokenDialog, mcpCommand } from './CreateTokenDialog'

type TokenState = 'active' | 'expired' | 'revoked'

function tokenState(t: ApiToken, now: number): TokenState {
  if (t.revoked_at) return 'revoked'
  if (t.expires_at && Date.parse(t.expires_at) <= now) return 'expired'
  return 'active'
}

/** "baru saja" untuk < 1 menit; formatRelative menulis "0 detik lalu". */
function ago(iso: string | null): string {
  if (iso && Date.now() - Date.parse(iso) < 60_000) return 'baru saja'
  return formatRelative(iso)
}

const STATE_ORDER: Record<TokenState, number> = { active: 0, expired: 1, revoked: 2 }

export function TokensPage() {
  const tokens = useTokens()
  const [createOpen, setCreateOpen] = React.useState(false)
  const [revoking, setRevoking] = React.useState<ApiToken | null>(null)
  // Waktu acuan status kedaluwarsa = saat data token terakhir diambil.
  const now = tokens.dataUpdatedAt

  const rows = React.useMemo(() => {
    const list = tokens.data?.data ?? []
    return [...list]
      .map((t) => ({ token: t, state: tokenState(t, now) }))
      .sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.token.created_at.localeCompare(a.token.created_at))
  }, [tokens.data, now])
  const activeCount = rows.filter((r) => r.state === 'active').length

  const createButton = (
    <Button onClick={() => setCreateOpen(true)}>
      <Plus /> Buat token
    </Button>
  )

  return (
    <PageContainer>
      <PageHeader
        title="API token"
        description="Token untuk MCP (Claude Code) dan CI. Hak token tidak pernah melebihi role kamu di project."
        actions={rows.length > 0 ? createButton : undefined}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="tokens-heading" className="min-w-0">
          <h2 id="tokens-heading" className="sr-only">
            Daftar token
          </h2>
          {tokens.isPending ? (
            <TokensSkeleton />
          ) : tokens.isError ? (
            <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title="Belum ada token"
              description="Buat token untuk menghubungkan Claude Code lewat MCP, atau untuk menjalankan test dari CI."
              action={createButton}
            />
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <caption className="sr-only">
                  {activeCount} token aktif dari {rows.length}
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>Nama</TableHead>
                    <TableHead className="hidden sm:table-cell">Scope</TableHead>
                    <TableHead className="hidden md:table-cell">Project</TableHead>
                    <TableHead className="hidden md:table-cell">Terakhir dipakai</TableHead>
                    <TableHead className="hidden md:table-cell">Kedaluwarsa</TableHead>
                    <TableHead>
                      <span className="sr-only">Aksi</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ token: t, state }) => (
                    <TokenRow key={t.id} token={t} state={state} onRevoke={() => setRevoking(t)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <McpHelp />
      </div>

      <CreateTokenDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RevokeDialog token={revoking} onClose={() => setRevoking(null)} />
    </PageContainer>
  )
}

function TokenRow({ token: t, state, onRevoke }: { token: ApiToken; state: TokenState; onRevoke: () => void }) {
  const inactive = state !== 'active'
  return (
    <TableRow className={cn(inactive && 'text-muted-foreground')}>
      <TableCell className="py-2 md:min-w-44">
        <span className={cn('block font-medium', inactive ? 'text-muted-foreground' : 'text-foreground')}>{t.name}</span>
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">
            <span className="sr-only">Prefix </span>
            {t.prefix}…
          </span>
          {state === 'revoked' && <span>Dicabut {ago(t.revoked_at)}</span>}
          {state === 'expired' && <span>Kedaluwarsa</span>}
        </span>
        {/* Layar sempit: kolom sekunder diringkas di bawah nama. */}
        <span className="mt-1 block text-xs text-muted-foreground md:hidden">
          <span className="sm:hidden">
            <span className="font-mono">{t.scopes.join(' ')}</span> ·{' '}
          </span>
          {t.project_keys?.length ? <span className="font-mono">{t.project_keys.join(', ')}</span> : 'Semua project'} ·{' '}
          {t.last_used_at ? `dipakai ${ago(t.last_used_at)}` : 'belum pernah dipakai'} ·{' '}
          {t.expires_at ? `berlaku s.d. ${formatDate(t.expires_at)}` : 'tanpa kedaluwarsa'}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex gap-1">
          {t.scopes.map((s) => (
            <Badge key={s} variant="mono" className={cn(inactive && 'bg-transparent px-0 text-muted-foreground')}>
              {s}
            </Badge>
          ))}
        </span>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {t.project_keys?.length ? (
          <span className="flex flex-wrap gap-1">
            {t.project_keys.map((k) => (
              <span key={k} className="font-mono text-xs">
                {k}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">Semua project</span>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {t.last_used_at ? <time dateTime={t.last_used_at}>{ago(t.last_used_at)}</time> : <span className="text-muted-foreground">Belum pernah</span>}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {t.expires_at ? <time dateTime={t.expires_at}>{formatDate(t.expires_at)}</time> : <span className="text-muted-foreground">Tidak ada</span>}
      </TableCell>
      <TableCell className="w-px text-right">
        {state !== 'revoked' && (
          <Button variant="ghost" size="sm" onClick={onRevoke} aria-label={`Cabut token ${t.name}`} className="text-destructive hover:text-destructive">
            Cabut
          </Button>
        )}
      </TableCell>
    </TableRow>
  )
}

function TokensSkeleton() {
  return (
    <Delayed>
      <div className="flex flex-col rounded-md border border-border" aria-hidden>
        <div className="h-8 border-b border-border" />
        {Array.from({ length: 3 }, (_, i) => (
          <div key={i} className="flex h-9 items-center gap-6 border-b border-border px-3 last:border-0">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-3.5 w-28" />
            <Skeleton className="hidden h-3.5 w-20 md:block" />
          </div>
        ))}
      </div>
    </Delayed>
  )
}

function McpHelp() {
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
          Cara pakai MCP
        </span>
      }
      bodyClassName="flex flex-col gap-4 text-sm"
    >
      <ol className="flex flex-col gap-3">
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">1.</span>
          <span>
            Buat token. Pilih scope seperlunya: <code className="font-mono text-xs">read</code> untuk membaca,{' '}
            <code className="font-mono text-xs">write</code> untuk membuat atau mengubah test case,{' '}
            <code className="font-mono text-xs">run</code> untuk menjalankan.
          </span>
        </li>
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">2.</span>
          <div className="flex min-w-0 flex-col gap-2">
            <span>Daftarkan server MCP di Claude Code. Ganti <code className="font-mono text-xs">&lt;token&gt;</code> dengan token kamu:</span>
            <CopyBlock value={mcpCommand('<token>')} label="Salin perintah" />
          </div>
        </li>
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">3.</span>
          <span>
            Minta Claude, misalnya: <span className="text-foreground">&ldquo;Buat test case login untuk project SHOP, jalankan di staging, lalu ringkas hasilnya.&rdquo;</span>
          </span>
        </li>
      </ol>
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        Token yang sama dipakai untuk REST API (CI) lewat header <code className="font-mono">Authorization: Bearer</code>. Cabut token yang tidak dipakai lagi.
      </p>
    </Panel>
  )
}

function RevokeDialog({ token, onClose }: { token: ApiToken | null; onClose: () => void }) {
  const revoke = useRevokeToken()
  // Simpan token terakhir agar teks tidak hilang saat animasi tutup.
  const [last, setLast] = React.useState<ApiToken | null>(token)
  if (token && token !== last) setLast(token)
  const t = token ?? last

  const confirm = () => {
    if (!t) return
    revoke.mutate(t.id, {
      onSuccess: () => {
        toast.success(`Token "${t.name}" dicabut`)
        onClose()
      },
    })
  }

  return (
    <AlertDialog
      open={!!token}
      onOpenChange={(o) => {
        if (!o && !revoke.isPending) {
          revoke.reset()
          onClose()
        }
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Cabut token &ldquo;{t?.name}&rdquo;?</AlertDialogTitle>
          <AlertDialogDescription>
            MCP atau CI yang memakai token <span className="font-mono text-xs text-foreground">{t?.prefix}…</span> langsung kehilangan akses. Token yang
            sudah dicabut tidak bisa dipulihkan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {revoke.isError && <Banner>Gagal mencabut token: {errorMessage(revoke.error)}</Banner>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>Batal</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} loading={revoke.isPending}>
            Cabut token
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
