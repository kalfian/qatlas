import { KeyRound, Plus, TerminalSquare } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
import { i18n } from '@/i18n'
import { formatDate, formatRelative } from '@/lib/format'
import { cn } from '@/lib/utils'
import { CopyBlock, CreateTokenDialog, mcpCommand } from './CreateTokenDialog'

type TokenState = 'active' | 'expired' | 'revoked'

function tokenState(t: ApiToken, now: number): TokenState {
  if (t.revoked_at) return 'revoked'
  if (t.expires_at && Date.parse(t.expires_at) <= now) return 'expired'
  return 'active'
}

/** "just now" untuk < 1 menit; formatRelative menulis "0 seconds ago". */
function ago(iso: string | null): string {
  if (iso && Date.now() - Date.parse(iso) < 60_000) return i18n.t('common:time.justNow')
  return formatRelative(iso)
}

const STATE_ORDER: Record<TokenState, number> = { active: 0, expired: 1, revoked: 2 }

export function TokensPage() {
  const { t } = useTranslation('account')
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
      <Plus /> {t('tokens.create')}
    </Button>
  )

  return (
    <PageContainer>
      <PageHeader
        title={t('tokens.title')}
        description={t('tokens.description')}
        actions={rows.length > 0 ? createButton : undefined}
      />

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section aria-labelledby="tokens-heading" className="min-w-0">
          <h2 id="tokens-heading" className="sr-only">
            {t('tokens.listHeading')}
          </h2>
          {tokens.isPending ? (
            <TokensSkeleton />
          ) : tokens.isError ? (
            <ErrorState error={tokens.error} onRetry={() => tokens.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={KeyRound}
              title={t('tokens.emptyTitle')}
              description={t('tokens.emptyDescription')}
              action={createButton}
            />
          ) : (
            <div className="rounded-md border border-border">
              <Table>
                <caption className="sr-only">
                  {t('tokens.caption', { active: String(activeCount), total: String(rows.length) })}
                </caption>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('tokens.columns.name')}</TableHead>
                    <TableHead className="hidden sm:table-cell">{t('tokens.columns.scope')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('tokens.columns.project')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('tokens.columns.lastUsed')}</TableHead>
                    <TableHead className="hidden md:table-cell">{t('tokens.columns.expires')}</TableHead>
                    <TableHead>
                      <span className="sr-only">{t('tokens.columns.actions')}</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map(({ token: tk, state }) => (
                    <TokenRow key={tk.id} token={tk} state={state} onRevoke={() => setRevoking(tk)} />
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

function TokenRow({ token: tk, state, onRevoke }: { token: ApiToken; state: TokenState; onRevoke: () => void }) {
  const { t } = useTranslation('account')
  const inactive = state !== 'active'
  return (
    <TableRow className={cn(inactive && 'text-muted-foreground')}>
      <TableCell className="py-2 md:min-w-44">
        <span className={cn('block font-medium', inactive ? 'text-muted-foreground' : 'text-foreground')}>{tk.name}</span>
        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
          <span className="font-mono">
            <span className="sr-only">{t('tokens.prefix')} </span>
            {tk.prefix}…
          </span>
          {state === 'revoked' && <span>{t('tokens.revokedAgo', { time: ago(tk.revoked_at) })}</span>}
          {state === 'expired' && <span>{t('tokens.expired')}</span>}
        </span>
        {/* Layar sempit: kolom sekunder diringkas di bawah nama. */}
        <span className="mt-1 block text-xs text-muted-foreground md:hidden">
          <span className="sm:hidden">
            <span className="font-mono">{tk.scopes.join(' ')}</span> ·{' '}
          </span>
          {tk.project_keys?.length ? <span className="font-mono">{tk.project_keys.join(', ')}</span> : t('tokens.allProjects')} ·{' '}
          {tk.last_used_at ? t('tokens.usedAgo', { time: ago(tk.last_used_at) }) : t('tokens.neverUsed')} ·{' '}
          {tk.expires_at ? t('tokens.validUntil', { date: formatDate(tk.expires_at) }) : t('tokens.noExpiry')}
        </span>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <span className="flex gap-1">
          {tk.scopes.map((s) => (
            <Badge key={s} variant="mono" className={cn(inactive && 'bg-transparent px-0 text-muted-foreground')}>
              {s}
            </Badge>
          ))}
        </span>
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {tk.project_keys?.length ? (
          <span className="flex flex-wrap gap-1">
            {tk.project_keys.map((k) => (
              <span key={k} className="font-mono text-xs">
                {k}
              </span>
            ))}
          </span>
        ) : (
          <span className="text-muted-foreground">{t('tokens.allProjects')}</span>
        )}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {tk.last_used_at ? <time dateTime={tk.last_used_at}>{ago(tk.last_used_at)}</time> : <span className="text-muted-foreground">{t('tokens.never')}</span>}
      </TableCell>
      <TableCell className="hidden whitespace-nowrap md:table-cell">
        {tk.expires_at ? <time dateTime={tk.expires_at}>{formatDate(tk.expires_at)}</time> : <span className="text-muted-foreground">{t('tokens.expiresNever')}</span>}
      </TableCell>
      <TableCell className="w-px text-right">
        {state !== 'revoked' && (
          <Button variant="ghost" size="sm" onClick={onRevoke} aria-label={t('tokens.revokeLabel', { name: tk.name })} className="text-destructive hover:text-destructive">
            {t('tokens.revoke')}
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
  const { t } = useTranslation(['account', 'common'])
  const code = <code className="font-mono text-xs" />
  return (
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <TerminalSquare className="size-4 text-muted-foreground" aria-hidden />
          {t('mcp.title')}
        </span>
      }
      bodyClassName="flex flex-col gap-4 text-sm"
    >
      <ol className="flex flex-col gap-3">
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">1.</span>
          <span>
            <Trans t={t} i18nKey="mcp.step1" components={{ code }} />
          </span>
        </li>
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">2.</span>
          <div className="flex min-w-0 flex-col gap-2">
            <span>
              <Trans t={t} i18nKey="mcp.step2" components={{ placeholder: <code className="font-mono text-xs">{'<token>'}</code> }} />
            </span>
            <CopyBlock value={mcpCommand('<token>')} label={t('common:actions.copyCommand')} />
          </div>
        </li>
        <li className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-x-2">
          <span className="tabular text-muted-foreground">3.</span>
          <span>
            <Trans t={t} i18nKey="mcp.step3" components={{ em: <span className="text-foreground" /> }} />
          </span>
        </li>
      </ol>
      <p className="border-t border-border pt-3 text-xs text-muted-foreground">
        <Trans t={t} i18nKey="mcp.footer" components={{ code: <code className="font-mono" /> }} />
      </p>
    </Panel>
  )
}

function RevokeDialog({ token, onClose }: { token: ApiToken | null; onClose: () => void }) {
  const { t } = useTranslation(['account', 'common'])
  const revoke = useRevokeToken()
  // Simpan token terakhir agar teks tidak hilang saat animasi tutup.
  const [last, setLast] = React.useState<ApiToken | null>(token)
  if (token && token !== last) setLast(token)
  const tk = token ?? last

  const confirm = () => {
    if (!tk) return
    revoke.mutate(tk.id, {
      onSuccess: () => {
        toast.success(t('revoke.done', { name: tk.name }))
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
          <AlertDialogTitle>{t('revoke.title', { name: tk?.name ?? '' })}</AlertDialogTitle>
          <AlertDialogDescription>
            <Trans
              t={t}
              i18nKey="revoke.description"
              values={{ prefix: tk?.prefix ?? '' }}
              components={{ code: <span className="font-mono text-xs text-foreground" /> }}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        {revoke.isError && <Banner>{t('revoke.failed', { message: errorMessage(revoke.error) })}</Banner>}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={revoke.isPending}>{t('common:actions.cancel')}</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} loading={revoke.isPending}>
            {t('revoke.confirm')}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
