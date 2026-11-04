import { Link } from '@tanstack/react-router'
import { RotateCw } from 'lucide-react'
import * as React from 'react'
import { useTestCases } from '@/api/queries'
import type { TestCaseSummary } from '@/api/types'
import { errorMessage } from '@/api/client'
import { ManualBadge, TC_STATUS_LABELS } from '@/components/misc'
import { Button } from '@/components/ui/button'
import { Command, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { FlowCaseRef } from './flow-draft'
import { useDebounced, useDelayedFlag } from './hooks'

export function toCaseRef(tc: TestCaseSummary): FlowCaseRef {
  return { id: tc.id, key: tc.key, title: tc.title, execution: tc.execution, status: tc.status, step_count: tc.step_count }
}

export function TestCasePicker({
  projectKey,
  usage,
  sharedSession,
  onAdd,
  inputRef,
  className,
}: {
  projectKey: string
  /** test_case_id → berapa kali sudah ada di flow */
  usage: Map<string, number>
  sharedSession: boolean
  onAdd: (tc: FlowCaseRef) => void
  inputRef?: React.Ref<HTMLInputElement>
  className?: string
}) {
  const [q, setQ] = React.useState('')
  const debounced = useDebounced(q.trim(), 200)
  const cases = useTestCases(projectKey, debounced ? { q: debounced } : {})
  // Hasil terakhir dari server langsung disaring dengan teks yang sedang diketik (aturan sama dengan API:
  // judul/key mengandung teks), jadi daftar selalu cocok dengan input walau debounce/fetch belum selesai.
  const needle = q.trim().toLowerCase()
  const list = (cases.data?.data ?? []).filter(
    (tc) => !needle || tc.title.toLowerCase().includes(needle) || tc.key.toLowerCase().includes(needle),
  )
  const settling = needle !== debounced.toLowerCase() || cases.isPlaceholderData
  const showSkeleton = useDelayedFlag(cases.isLoading)
  // cmdk tidak mereset pilihan saat daftar berganti → tiap query mulai dari hasil pertama.
  const [selected, setSelected] = React.useState({ q: '', id: '' })
  const active = selected.q === needle && list.some((tc) => tc.id === selected.id) ? selected.id : (list[0]?.id ?? '')

  return (
    <Command
      shouldFilter={false}
      loop
      value={active}
      onValueChange={(id) => setSelected({ q: needle, id })}
      className={cn('bg-transparent', className)}
      label="Cari test case untuk ditambahkan"
    >
      <CommandInput ref={inputRef} value={q} onValueChange={setQ} placeholder="Cari judul atau key…" />
      <CommandList className="max-h-none min-h-0 flex-1" aria-busy={settling || cases.isFetching || undefined}>
        {cases.isError ? (
          <div role="alert" className="flex flex-col items-start gap-2 px-2 py-4 text-sm">
            <p className="font-medium">Gagal memuat test case.</p>
            <p className="text-xs text-muted-foreground">{errorMessage(cases.error)}</p>
            <Button variant="outline" size="sm" onClick={() => cases.refetch()}>
              <RotateCw /> Coba lagi
            </Button>
          </div>
        ) : cases.isLoading ? (
          showSkeleton && (
            <div className="flex flex-col gap-3 px-2 py-2" aria-label="Memuat test case">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          )
        ) : list.length === 0 && settling ? null : list.length === 0 ? (
          <div className="flex flex-col items-start gap-1 px-2 py-4 text-sm text-muted-foreground">
            {debounced ? (
              <>
                <p>Tidak ada test case yang cocok dengan "{debounced}".</p>
                <Button variant="link" size="sm" onClick={() => setQ('')} className="text-xs">
                  Reset pencarian
                </Button>
              </>
            ) : (
              <>
                <p>Project ini belum punya test case.</p>
                <Link to="/p/$key/tests" params={{ key: projectKey }} className="text-xs text-link hover:underline">
                  Buka Test cases
                </Link>
              </>
            )}
          </div>
        ) : (
          list.map((tc) => {
            const used = usage.get(tc.id) ?? 0
            const blocked = sharedSession && tc.execution === 'manual'
            const warn = tc.status !== 'ready'
            return (
              <CommandItem
                key={tc.id}
                value={tc.id}
                onSelect={() => onAdd(toCaseRef(tc))}
                className="flex-col items-stretch gap-0.5 py-1.5"
              >
                <span className="flex items-center gap-2">
                  <span className="font-mono text-xs font-medium">{tc.key}</span>
                  <ManualBadge execution={tc.execution} />
                  <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span className="tabular">{tc.step_count} step</span>
                    <span aria-hidden>·</span>
                    <span className={cn(warn && 'font-medium text-status-blocked')}>{TC_STATUS_LABELS[tc.status]}</span>
                  </span>
                </span>
                <span className="line-clamp-2 text-sm">{tc.title}</span>
                {(used > 0 || blocked) && (
                  <span className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                    {used > 0 && <span>Sudah ada {used}× di flow</span>}
                    {blocked && <span className="text-destructive">Manual, tidak boleh di shared session</span>}
                  </span>
                )}
              </CommandItem>
            )
          })
        )}
      </CommandList>
    </Command>
  )
}
