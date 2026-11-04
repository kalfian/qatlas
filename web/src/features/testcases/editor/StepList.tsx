import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type DraggableAttributes,
  type DraggableSyntheticListeners,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { ArrowDown, ArrowUp, CircleAlert, Copy, Ellipsis, GripVertical, Plus, Power, PowerOff, Trash2, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import type { Execution, FieldError, Step, StepAction, StepStatus } from '@/api/types'
import { StepSummaryText } from '@/components/misc'
import { STATUS_META, StatusIcon } from '@/components/status'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { summarizeStep } from '@/lib/steps'
import { cn } from '@/lib/utils'
import { actionIcon } from '../lib'
import { ActionPalette } from './ActionPalette'

export interface StepListHandlers {
  onSelect: (id: string) => void
  /** klik baris: desktop memilih, tablet membuka Sheet */
  onRowClick: (id: string) => void
  onOpen: (id: string) => void
  onReorder: (from: number, to: number) => void
  onDuplicate: (id: string) => void
  onToggle: (id: string) => void
  onDelete: (id: string) => void
  onAdd: (action: StepAction) => void
}

const RUN_WORD: Partial<Record<StepStatus, string>> = {
  passed: 'lolos di run terakhir',
  failed: 'gagal di run terakhir',
  error: 'error di run terakhir',
  skipped: 'di-skip di run terakhir',
  blocked: 'blocked di run terakhir',
  running: 'sedang berjalan',
}

export function stepAccessibleName(step: Step, index: number, runStatus?: StepStatus, errorCount = 0): string {
  const parts = [`Step ${index + 1}`]
  if (step.action !== 'manual') parts.push(step.action)
  parts.push(summarizeStep(step))
  if (step.enabled === false) parts.push('nonaktif')
  if (errorCount) parts.push(`${errorCount} error`)
  if (runStatus && RUN_WORD[runStatus]) parts.push(RUN_WORD[runStatus]!)
  return parts.join(', ')
}

export function StepList({
  steps,
  execution,
  selectedId,
  readOnly,
  errors,
  warnings,
  runStatus,
  paletteOpen,
  setPaletteOpen,
  handlers,
  rowRefs,
}: {
  steps: Step[]
  execution: Execution
  selectedId: string | null
  readOnly: boolean
  errors: Map<number, FieldError[]>
  warnings: Map<number, FieldError[]>
  runStatus: Map<string, StepStatus>
  paletteOpen: boolean
  setPaletteOpen: (o: boolean) => void
  handlers: StepListHandlers
  rowRefs: React.MutableRefObject<Map<string, HTMLElement>>
}) {
  const manual = execution === 'manual'
  const [dragging, setDragging] = React.useState<UniqueIdentifier | null>(null)
  const [menuFor, setMenuFor] = React.useState<string | null>(null)
  const [announce, setAnnounce] = React.useState('')
  const ids = steps.map((s) => s.id)
  const posOf = (id: UniqueIdentifier) => ids.indexOf(String(id)) + 1

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] },
    }),
  )

  const announcements: Announcements = {
    onDragStart: ({ active }) => `Step ${posOf(active.id)} diangkat. Pakai panah atas/bawah untuk memindah, spasi untuk melepas, Escape untuk batal.`,
    onDragOver: ({ active, over }) => (over ? `Step ${posOf(active.id)} sekarang di posisi ${posOf(over.id)}.` : `Step ${posOf(active.id)} di luar daftar.`),
    onDragEnd: ({ active, over }) =>
      over ? `Step ${posOf(active.id)} dipindah ke posisi ${posOf(over.id)}.` : `Step ${posOf(active.id)} dilepas di posisi semula.`,
    onDragCancel: ({ active }) => `Pemindahan dibatalkan. Step ${posOf(active.id)} kembali ke posisi semula.`,
  }

  const focusId = (id: string | undefined) => {
    if (!id) return
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus())
  }

  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir
    if (to < 0 || to >= steps.length) return
    handlers.onReorder(index, to)
    setAnnounce(`Step ${index + 1} dipindah ke posisi ${to + 1}`)
    focusId(steps[index].id)
  }

  const onRowKeyDown = (e: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (dragging || e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return
    const step = steps[index]
    const k = e.key
    if (e.altKey && (k === 'ArrowUp' || k === 'ArrowDown')) {
      if (readOnly) return
      e.preventDefault()
      move(index, k === 'ArrowUp' ? -1 : 1)
      return
    }
    if (e.altKey) return
    switch (k) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault()
        const next = steps[index + (k === 'ArrowDown' ? 1 : -1)]
        if (next) {
          handlers.onSelect(next.id)
          focusId(next.id)
        }
        return
      }
      case 'Home':
      case 'End': {
        e.preventDefault()
        const next = k === 'Home' ? steps[0] : steps[steps.length - 1]
        handlers.onSelect(next.id)
        focusId(next.id)
        return
      }
      case 'Enter':
        e.preventDefault()
        handlers.onOpen(step.id)
        return
    }
    if (readOnly) return
    switch (k.toLowerCase()) {
      case 'd':
        e.preventDefault()
        handlers.onDuplicate(step.id)
        return
      case 'e':
        e.preventDefault()
        handlers.onToggle(step.id)
        setAnnounce(step.enabled === false ? `Step ${index + 1} diaktifkan` : `Step ${index + 1} dinonaktifkan`)
        return
      case 'delete':
      case 'backspace': {
        e.preventDefault()
        const next = steps[index + 1] ?? steps[index - 1]
        handlers.onDelete(step.id)
        if (next) {
          handlers.onSelect(next.id)
          focusId(next.id)
        }
        return
      }
      case 'contextmenu':
        e.preventDefault()
        setMenuFor(step.id)
        return
      case 'f10':
        if (e.shiftKey) {
          e.preventDefault()
          setMenuFor(step.id)
        }
        return
    }
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null)
    if (!over || active.id === over.id) return
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from < 0 || to < 0) return
    handlers.onReorder(from, to)
    focusId(String(active.id))
  }

  const tabStop = selectedId && ids.includes(selectedId) ? selectedId : ids[0]

  const list = (
    <div
      role="listbox"
      aria-label={manual ? 'Langkah manual' : 'Daftar step'}
      aria-describedby="step-list-help"
      className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border"
    >
      {steps.map((step, i) => (
        <SortableStepRow
          key={step.id}
          step={step}
          index={i}
          manual={manual}
          selected={step.id === selectedId}
          tabbable={step.id === tabStop}
          readOnly={readOnly}
          errors={errors.get(i) ?? []}
          warnings={warnings.get(i) ?? []}
          runStatus={runStatus.get(step.id)}
          menuOpen={menuFor === step.id}
          setMenuOpen={(o) => setMenuFor(o ? step.id : null)}
          onKeyDown={(e) => onRowKeyDown(e, i)}
          onClick={() => handlers.onRowClick(step.id)}
          onSelectOnly={() => handlers.onSelect(step.id)}
          onDoubleClick={() => handlers.onOpen(step.id)}
          onMove={(dir) => move(i, dir)}
          handlers={handlers}
          isFirst={i === 0}
          isLast={i === steps.length - 1}
          rowRef={(el) => {
            if (el) rowRefs.current.set(step.id, el)
            else rowRefs.current.delete(step.id)
          }}
          returnFocus={() => focusId(step.id)}
        />
      ))}
    </div>
  )

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p id="step-list-help" className="sr-only">
        Panah atas/bawah memilih step, Enter membuka detail.
        {readOnly ? '' : ' Alt+panah memindah step, spasi untuk mulai drag, N tambah, D duplikat, E aktif/nonaktif, Delete hapus.'}
      </p>
      <div aria-live="polite" className="sr-only">
        {announce}
      </div>
      {steps.length > 0 &&
        (readOnly ? (
          list
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragStart={({ active }) => setDragging(active.id)}
            onDragCancel={() => setDragging(null)}
            onDragEnd={onDragEnd}
            accessibility={{
              announcements,
              screenReaderInstructions: {
                draggable: 'Tekan spasi untuk mengangkat step. Pakai panah atas/bawah untuk memindah, spasi untuk melepas, Escape untuk batal.',
              },
            }}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {list}
            </SortableContext>
          </DndContext>
        ))}
      {!readOnly && (
        <div className="flex items-center gap-2">
          {manual ? (
            <Button variant="ghost" className="justify-start text-muted-foreground" onClick={() => handlers.onAdd('manual')} aria-keyshortcuts="N">
              <Plus /> Tambah langkah
              <Kbd className="ml-1">N</Kbd>
            </Button>
          ) : (
            <ActionPalette
              open={paletteOpen}
              onOpenChange={setPaletteOpen}
              onPick={(a) => {
                setPaletteOpen(false)
                handlers.onAdd(a)
              }}
              afterLabel={(() => {
                const idx = selectedId ? ids.indexOf(selectedId) : -1
                return idx >= 0 ? `setelah step ${idx + 1}` : steps.length ? 'di akhir' : undefined
              })()}
            />
          )}
        </div>
      )}
    </div>
  )
}

function SortableStepRow(props: RowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.step.id, disabled: props.readOnly })
  return (
    <StepRow
      {...props}
      sortable={{
        setNodeRef,
        attributes,
        listeners,
        style: { transform: CSS.Translate.toString(transform), transition },
        isDragging,
      }}
    />
  )
}

interface RowProps {
  step: Step
  index: number
  manual: boolean
  selected: boolean
  tabbable: boolean
  readOnly: boolean
  errors: FieldError[]
  warnings: FieldError[]
  runStatus?: StepStatus
  menuOpen: boolean
  setMenuOpen: (o: boolean) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void
  onClick: () => void
  onSelectOnly: () => void
  onDoubleClick: () => void
  onMove: (dir: -1 | 1) => void
  handlers: StepListHandlers
  isFirst: boolean
  isLast: boolean
  rowRef: (el: HTMLElement | null) => void
  returnFocus: () => void
}

function StepRow({
  step,
  index,
  manual,
  selected,
  tabbable,
  readOnly,
  errors,
  warnings,
  runStatus,
  menuOpen,
  setMenuOpen,
  onKeyDown,
  onClick,
  onSelectOnly,
  onDoubleClick,
  onMove,
  handlers,
  isFirst,
  isLast,
  rowRef,
  returnFocus,
  sortable,
}: RowProps & {
  sortable?: {
    setNodeRef: (el: HTMLElement | null) => void
    attributes: DraggableAttributes
    listeners: DraggableSyntheticListeners
    style: React.CSSProperties
    isDragging: boolean
  }
}) {
  const Icon = actionIcon(step.action)
  const disabled = step.enabled === false
  const hasError = errors.length > 0
  const summary = summarizeStep(step)
  const showStatus = runStatus && runStatus !== 'pending'

  return (
    <div
      ref={(el) => {
        sortable?.setNodeRef(el)
        rowRef(el)
      }}
      role="option"
      aria-selected={selected}
      aria-label={stepAccessibleName(step, index, runStatus, errors.length)}
      aria-describedby={sortable?.attributes['aria-describedby']}
      tabIndex={tabbable ? 0 : -1}
      data-step-id={step.id}
      style={sortable?.style}
      onKeyDown={(e) => {
        sortable?.listeners?.onKeyDown?.(e)
        if (e.defaultPrevented) return
        onKeyDown(e)
      }}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        if (readOnly) return
        e.preventDefault()
        onSelectOnly()
        setMenuOpen(true)
      }}
      className={cn(
        'group relative flex cursor-default items-center gap-2 bg-card pr-1.5 pl-1 text-sm outline-none transition-colors duration-150 hover:bg-muted/60 focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
        manual ? 'min-h-14 py-2' : 'h-9',
        selected && 'bg-accent hover:bg-accent',
        sortable?.isDragging && 'z-20 bg-popover shadow-overlay',
      )}
    >
      {hasError && <span className="absolute inset-y-0 left-0 w-0.5 bg-destructive" aria-hidden />}
      {readOnly ? (
        <span className="w-1" aria-hidden />
      ) : (
        <span
          aria-hidden
          onPointerDown={sortable?.listeners?.onPointerDown as React.PointerEventHandler<HTMLSpanElement> | undefined}
          className="flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </span>
      )}
      <span className={cn('w-5 shrink-0 text-right text-xs tabular text-muted-foreground', disabled && 'opacity-60')}>{index + 1}</span>

      {manual ? (
        <div className={cn('flex min-w-0 flex-1 flex-col gap-0.5', disabled && 'opacity-60')}>
          <p className={cn('line-clamp-2 text-sm', !step.description && 'text-muted-foreground')}>
            {step.description ? <StepSummaryText text={step.description} /> : 'Instruksi belum diisi'}
          </p>
          {step.expected && (
            <p className="line-clamp-1 text-xs text-muted-foreground">
              <span className="font-medium">Expected:</span> {step.expected}
            </p>
          )}
        </div>
      ) : (
        <div className={cn('flex min-w-0 flex-1 items-center gap-2', disabled && 'opacity-60')}>
          <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="hidden w-28 shrink-0 truncate font-mono text-xs text-muted-foreground sm:inline" title={step.action}>{step.action}</span>
          <StepSummaryText text={summary} className="min-w-0 flex-1 truncate" />
        </div>
      )}

      {disabled && <span className="shrink-0 rounded-sm bg-secondary px-1.5 text-xs text-muted-foreground">Nonaktif</span>}
      {hasError ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-destructive" title={errors.map((e) => e.message).join('\n')}>
          <CircleAlert className="size-3.5" aria-hidden />
          {errors.length > 1 && <span className="tabular">{errors.length}</span>}
        </span>
      ) : warnings.length > 0 ? (
        <span className="inline-flex shrink-0 text-status-blocked" title={warnings.map((e) => e.message).join('\n')}>
          <TriangleAlert className="size-3.5" aria-hidden />
        </span>
      ) : null}
      <span className="flex w-4 shrink-0 justify-center">
        {showStatus && (
          <span title={`Run terakhir: ${STATUS_META[runStatus].label}`}>
            <StatusIcon status={runStatus} className="[&_svg]:size-3.5" />
          </span>
        )}
      </span>
      {!readOnly && (
        <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              tabIndex={-1}
              aria-hidden
              onClick={(e) => e.stopPropagation()}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100 group-focus-visible:opacity-100',
                (selected || menuOpen) && 'opacity-100',
              )}
            >
              <Ellipsis className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <StepMenuContent
            step={step}
            isFirst={isFirst}
            isLast={isLast}
            onDuplicate={() => handlers.onDuplicate(step.id)}
            onToggle={() => handlers.onToggle(step.id)}
            onMove={onMove}
            onDelete={() => handlers.onDelete(step.id)}
            onCloseAutoFocus={(e) => {
              e.preventDefault()
              returnFocus()
            }}
          />
        </DropdownMenu>
      )}
    </div>
  )
}

export function StepMenuContent({
  step,
  isFirst,
  isLast,
  onDuplicate,
  onToggle,
  onMove,
  onDelete,
  onCloseAutoFocus,
}: {
  step: Step
  isFirst: boolean
  isLast: boolean
  onDuplicate: () => void
  onToggle: () => void
  onMove: (dir: -1 | 1) => void
  onDelete: () => void
  onCloseAutoFocus?: (e: Event) => void
}) {
  const disabled = step.enabled === false
  return (
    <DropdownMenuContent align="end" className="w-56" onClick={(e) => e.stopPropagation()} onCloseAutoFocus={onCloseAutoFocus}>
      <DropdownMenuItem onSelect={onDuplicate}>
        <Copy /> Duplikat <DropdownMenuShortcut>D</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onToggle}>
        {disabled ? <Power /> : <PowerOff />} {disabled ? 'Aktifkan' : 'Nonaktifkan'} <DropdownMenuShortcut>E</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem disabled={isFirst} onSelect={() => onMove(-1)}>
        <ArrowUp /> Pindah ke atas <DropdownMenuShortcut>Alt ↑</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem disabled={isLast} onSelect={() => onMove(1)}>
        <ArrowDown /> Pindah ke bawah <DropdownMenuShortcut>Alt ↓</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem destructive onSelect={onDelete}>
        <Trash2 /> Hapus <DropdownMenuShortcut>Del</DropdownMenuShortcut>
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}
