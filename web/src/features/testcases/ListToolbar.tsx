import { Check, ChevronDown, FolderTree as FolderTreeIcon, Search, X } from 'lucide-react'
import * as React from 'react'
import type { RunStatus } from '@/api/types'
import type { TestCasesSearch } from '@/app/router'
import { PriorityLabel, PRIORITY_LABELS, TC_STATUS_LABELS } from '@/components/misc'
import { STATUS_META, StatusIcon } from '@/components/status'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

type FilterKey = 'status' | 'priority' | 'execution' | 'last_run_status' | 'tags'

const RUN_STATUS_OPTIONS: RunStatus[] = ['passed', 'failed', 'error', 'blocked', 'running', 'queued', 'awaiting_manual', 'cancelled']

interface Option {
  value: string
  label: string
  render?: React.ReactNode
}

const OPTIONS: Record<Exclude<FilterKey, 'tags'>, { title: string; options: Option[] }> = {
  status: {
    title: 'Status',
    options: (['draft', 'ready', 'deprecated'] as const).map((v) => ({ value: v, label: TC_STATUS_LABELS[v] })),
  },
  priority: {
    title: 'Prioritas',
    options: (['critical', 'high', 'medium', 'low'] as const).map((v) => ({ value: v, label: PRIORITY_LABELS[v], render: <PriorityLabel priority={v} /> })),
  },
  execution: {
    title: 'Execution',
    options: [
      { value: 'automated', label: 'Automated' },
      { value: 'manual', label: 'Manual' },
    ],
  },
  last_run_status: {
    title: 'Last run',
    options: RUN_STATUS_OPTIONS.map((v) => ({
      value: v,
      label: STATUS_META[v].label,
      render: (
        <span className="inline-flex items-center gap-1.5">
          <StatusIcon status={v} className="[&_svg]:size-3.5" />
          {STATUS_META[v].label}
        </span>
      ),
    })),
  },
}

export function labelForFilter(key: Exclude<FilterKey, 'tags'>, value: string): string {
  return OPTIONS[key].options.find((o) => o.value === value)?.label ?? value
}

export function ListToolbar({
  search,
  setSearch,
  tags,
  onOpenFolders,
  folderLabel,
  folderButtonRef,
}: {
  search: TestCasesSearch
  setSearch: (patch: Partial<TestCasesSearch>) => void
  tags: { tag: string; count: number }[]
  onOpenFolders: () => void
  folderLabel: string
  folderButtonRef?: React.Ref<HTMLButtonElement>
}) {
  const [q, setQ] = React.useState(search.q ?? '')
  const [lastUrlQ, setLastUrlQ] = React.useState(search.q ?? '')
  // URL berubah dari luar (Reset, back/forward) → sinkronkan input.
  if ((search.q ?? '') !== lastUrlQ) {
    setLastUrlQ(search.q ?? '')
    setQ(search.q ?? '')
  }
  const setSearchRef = React.useRef(setSearch)
  React.useEffect(() => {
    setSearchRef.current = setSearch
  })
  React.useEffect(() => {
    if (q === lastUrlQ) return
    const t = setTimeout(() => setSearchRef.current({ q: q.trim() || undefined }), 250)
    return () => clearTimeout(t)
  }, [q, lastUrlQ])

  const activeTags = search.tags?.split(',').filter(Boolean) ?? []

  return (
    <div className="flex flex-wrap items-center gap-2" role="search" aria-label="Cari dan filter test case">
      <Button ref={folderButtonRef} variant="outline" className="xl:hidden" onClick={onOpenFolders} aria-label={`Folder: ${folderLabel}`}>
        <FolderTreeIcon /> <span className="max-w-32 truncate">{folderLabel}</span>
      </Button>
      <div className="relative w-full sm:w-64">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <Input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') setSearch({ q: q.trim() || undefined })
            if (e.key === 'Escape' && q) {
              e.preventDefault()
              e.stopPropagation()
              setQ('')
              setSearch({ q: undefined })
            }
          }}
          placeholder="Cari judul atau key…"
          aria-label="Cari judul atau key test case"
          className="pl-8"
        />
      </div>
      {(['status', 'priority'] as const).map((k) => (
        <SingleFilter key={k} filterKey={k} value={search[k]} onChange={(v) => setSearch({ [k]: v } as Partial<TestCasesSearch>)} />
      ))}
      <TagFilter tags={tags} value={activeTags} onChange={(v) => setSearch({ tags: v.length ? v.join(',') : undefined })} />
      {(['execution', 'last_run_status'] as const).map((k) => (
        <SingleFilter key={k} filterKey={k} value={search[k]} onChange={(v) => setSearch({ [k]: v } as Partial<TestCasesSearch>)} />
      ))}
    </div>
  )
}

function FilterButton({ title, active, valueLabel, ...props }: { title: string; active: boolean; valueLabel?: string } & React.ComponentProps<typeof Button>) {
  return (
    <Button
      variant="outline"
      className={cn('gap-1 px-2.5', active && 'border-foreground/40 bg-accent')}
      aria-label={active ? `Filter ${title}: ${valueLabel}` : `Filter ${title}`}
      {...props}
    >
      <span className={cn(!active && 'text-muted-foreground')}>{title}</span>
      {active && valueLabel && <span className="max-w-28 truncate font-normal">· {valueLabel}</span>}
      <ChevronDown className="opacity-60" />
    </Button>
  )
}

function SingleFilter({ filterKey, value, onChange }: { filterKey: Exclude<FilterKey, 'tags'>; value?: string; onChange: (v: string | undefined) => void }) {
  const [open, setOpen] = React.useState(false)
  const def = OPTIONS[filterKey]
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FilterButton title={def.title} active={!!value} valueLabel={value ? labelForFilter(filterKey, value) : undefined} />
      </PopoverTrigger>
      <PopoverContent className="w-52 p-0">
        <Command>
          <CommandList>
            <CommandGroup heading={def.title}>
              {def.options.map((o) => (
                <CommandItem
                  key={o.value}
                  value={o.label}
                  onSelect={() => {
                    onChange(value === o.value ? undefined : o.value)
                    setOpen(false)
                  }}
                  aria-checked={value === o.value}
                >
                  <Check className={cn('size-4', value === o.value ? 'opacity-100' : 'opacity-0')} aria-hidden />
                  {o.render ?? o.label}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          {value && (
            <div className="border-t border-border p-1">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  onChange(undefined)
                  setOpen(false)
                }}
              >
                <X /> Hapus filter
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function TagFilter({ tags, value, onChange }: { tags: { tag: string; count: number }[]; value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = React.useState(false)
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <FilterButton title="Tag" active={value.length > 0} valueLabel={value.length === 1 ? value[0] : `${value.length} tag`} />
      </PopoverTrigger>
      <PopoverContent className="w-60 p-0">
        <Command>
          <CommandInput placeholder="Cari tag…" aria-label="Cari tag" />
          <CommandList>
            <CommandEmpty>Tag tidak ditemukan.</CommandEmpty>
            <CommandGroup heading="Harus punya semua tag terpilih">
              {tags.map(({ tag, count }) => {
                const on = value.includes(tag)
                return (
                  <CommandItem key={tag} value={tag} onSelect={() => toggle(tag)} aria-checked={on}>
                    <span
                      className={cn(
                        'flex size-4 items-center justify-center rounded-sm border border-input',
                        on && 'border-primary bg-primary text-primary-foreground [&_svg]:!text-primary-foreground',
                      )}
                      aria-hidden
                    >
                      {on && <Check className="size-3" />}
                    </span>
                    <span className="flex-1 truncate">{tag}</span>
                    <span className="text-xs tabular text-muted-foreground">{count}</span>
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
          {value.length > 0 && (
            <div className="border-t border-border p-1">
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={() => onChange([])}>
                <X /> Hapus filter tag
              </Button>
            </div>
          )}
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Chip filter aktif + Reset. */
export function ActiveFilters({ search, setSearch, onReset }: { search: TestCasesSearch; setSearch: (patch: Partial<TestCasesSearch>) => void; onReset: () => void }) {
  const chips: { key: string; label: string; onRemove: () => void }[] = []
  if (search.q) chips.push({ key: 'q', label: `Cari: "${search.q}"`, onRemove: () => setSearch({ q: undefined }) })
  for (const k of ['status', 'priority', 'execution', 'last_run_status'] as const) {
    const v = search[k]
    if (v) chips.push({ key: k, label: `${OPTIONS[k].title}: ${labelForFilter(k, v)}`, onRemove: () => setSearch({ [k]: undefined } as Partial<TestCasesSearch>) })
  }
  const tags = search.tags?.split(',').filter(Boolean) ?? []
  for (const t of tags) {
    chips.push({
      key: `tag-${t}`,
      label: `Tag: ${t}`,
      onRemove: () => {
        const rest = tags.filter((x) => x !== t)
        setSearch({ tags: rest.length ? rest.join(',') : undefined })
      },
    })
  }
  if (!chips.length) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter aktif">
      {chips.map((c) => (
        <span key={c.key} className="inline-flex h-6 items-center gap-1 rounded-sm bg-secondary pr-0.5 pl-2 text-xs text-secondary-foreground">
          {c.label}
          <button
            type="button"
            onClick={c.onRemove}
            aria-label={`Hapus filter ${c.label}`}
            className="flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
      <Button variant="ghost" size="sm" onClick={onReset}>
        Reset filter
      </Button>
    </div>
  )
}
