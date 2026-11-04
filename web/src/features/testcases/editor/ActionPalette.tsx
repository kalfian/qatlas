import { Plus, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import type { StepAction } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Kbd } from '@/components/ui/kbd'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { ACTIONS, GROUP_LABELS, type ActionDef, type ActionGroup } from '@/lib/steps'
import { ACTION_ALIASES, actionIcon } from '../lib'

const GROUP_ORDER: ActionGroup[] = ['navigation', 'interaction', 'wait', 'assert_ui', 'data', 'http', 'assert_http']

/**
 * Skor pencarian: awal nama action/label/alias > awal kata > substring. Tanpa ini "isi" ikut
 * cocok dengan "visit" (alias goto) dan goto menang karena urutannya lebih dulu.
 */
function rankAction(value: string, search: string, keywords: string[] = []): number {
  const terms = search.toLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return 1
  const [action, ...labelWords] = value.toLowerCase().split(' ')
  const label = labelWords.join(' ')
  const aliases = keywords.slice(0, -1).map((k) => k.toLowerCase())
  const words = `${value} ${keywords.join(' ')}`.toLowerCase().split(/[\s_.,()]+/)
  const hay = `${value} ${keywords.join(' ')}`.toLowerCase()
  let score = 1
  for (const t of terms) {
    if (action.startsWith(t) || label.startsWith(t) || aliases.some((a) => a.startsWith(t))) score *= 1
    else if (words.some((w) => w.startsWith(t))) score *= 0.6
    else if (hay.includes(t)) score *= 0.2
    else return 0
  }
  return score
}

/** Palette action (Popover + Command), dibuka lewat tombol "Tambah step" atau shortcut N. */
export function ActionPalette({
  open,
  onOpenChange,
  onPick,
  afterLabel,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onPick: (action: StepAction) => void
  afterLabel?: string
}) {
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const [query, setQuery] = React.useState('')
  React.useEffect(() => {
    if (open) triggerRef.current?.scrollIntoView({ block: 'nearest' })
  }, [open])
  const ranked = React.useMemo(
    () =>
      ACTIONS.filter((a) => a.group !== 'manual')
        .map((a, i) => ({ a, i, score: rankAction(`${a.action} ${a.label}`, query, [...(ACTION_ALIASES[a.action] ?? []), a.description]) }))
        .filter((x) => x.score > 0)
        .sort((x, y) => y.score - x.score || x.i - y.i)
        .map((x) => x.a),
    [query],
  )

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o)
        if (!o) setQuery('')
      }}
    >
      <PopoverTrigger asChild>
        <Button ref={triggerRef} variant="ghost" className="justify-start text-muted-foreground" aria-keyshortcuts="N">
          <Plus /> Tambah step
          <Kbd className="ml-1">N</Kbd>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(26rem,calc(100vw-2rem))] p-0" align="start" side="top" collisionPadding={16}>
        <Command shouldFilter={false}>
          <CommandInput placeholder="Cari action… (klik, isi, tunggu, api)" aria-label="Cari action" value={query} onValueChange={setQuery} />
          {afterLabel && <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">Disisipkan {afterLabel}</p>}
          <CommandList className="max-h-[min(24rem,50dvh)]">
            <CommandEmpty>Action tidak ditemukan.</CommandEmpty>
            {query.trim() ? (
              <CommandGroup heading="Hasil">
                {ranked.map((a) => (
                  <ActionItem key={a.action} def={a} onPick={onPick} />
                ))}
              </CommandGroup>
            ) : (
              GROUP_ORDER.map((g) => (
                <CommandGroup key={g} heading={GROUP_LABELS[g]}>
                  {ACTIONS.filter((a) => a.group === g).map((a) => (
                    <ActionItem key={a.action} def={a} onPick={onPick} />
                  ))}
                </CommandGroup>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function ActionItem({ def: a, onPick }: { def: ActionDef; onPick: (action: StepAction) => void }) {
  const Icon = actionIcon(a.action)
  return (
    <CommandItem value={a.action} onSelect={() => onPick(a.action)} className="items-start py-1.5">
      <Icon className="mt-0.5" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="font-medium">{a.label}</span>
          <span className="font-mono text-xs text-muted-foreground">{a.action}</span>
          {a.action === 'wait' && (
            <span className="inline-flex items-center gap-1 rounded-sm bg-status-blocked-bg px-1 text-xs text-status-blocked">
              <TriangleAlert className="!size-3 !text-status-blocked" aria-hidden /> lebih baik wait_for
            </span>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">{a.description}</span>
      </span>
    </CommandItem>
  )
}
