import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core'
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { CircleAlert, GripVertical, TriangleAlert, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ManualBadge, TC_STATUS_LABELS } from '@/components/misc'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { i18n } from '@/i18n'
import { cn } from '@/lib/utils'
import type { DraftItem } from './flow-draft'

export interface ItemsListProps {
  items: DraftItem[]
  readOnly: boolean
  stopOnFailure: boolean
  errors: Record<string, string>
  warnings: Record<string, string>
  onMove: (from: number, to: number) => void
  onChange: (uid: string, patch: Partial<Pick<DraftItem, 'continue_on_failure' | 'enabled'>>) => void
  onRemove: (uid: string) => void
  /** Pesan untuk region aria-live milik halaman. */
  announce: (msg: string) => void
}

function label(items: DraftItem[], id: UniqueIdentifier) {
  const it = items.find((i) => i.uid === id)
  return it ? `${it.test_case.key} ${it.test_case.title}` : i18n.t('flows:items.fallbackLabel')
}

export function FlowItemsList(props: ItemsListProps) {
  const { items, readOnly, onMove, announce } = props
  const { t } = useTranslation('flows')
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const pos = (id: UniqueIdentifier) => items.findIndex((i) => i.uid === id) + 1
  const total = String(items.length)
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('items.dnd.start', { label: label(items, active.id), n: String(pos(active.id)), total }),
    onDragOver: ({ active, over }) =>
      over
        ? t('items.dnd.over', { label: label(items, active.id), n: String(pos(over.id)), total })
        : t('items.dnd.outside', { label: label(items, active.id) }),
    onDragEnd: ({ active, over }) =>
      over
        ? t('items.dnd.end', { label: label(items, active.id), n: String(pos(over.id)), total })
        : t('items.dnd.endInPlace', { label: label(items, active.id), n: String(pos(active.id)) }),
    onDragCancel: ({ active }) => t('items.dnd.cancel', { label: label(items, active.id), n: String(pos(active.id)) }),
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || active.id === over.id) return
    onMove(pos(active.id) - 1, pos(over.id) - 1)
  }

  const moveBy = (index: number, delta: number) => {
    const to = index + delta
    if (to < 0 || to >= items.length) return
    const it = items[index]
    onMove(index, to)
    announce(t('items.moved', { key: it.test_case.key, n: String(to + 1), total: String(items.length) }))
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-grip="${it.uid}"]`)?.focus())
  }

  const list = (
    <ol className="@container divide-y divide-border" aria-label={t('items.label')}>
      {items.map((it, i) => (
        <ItemRow key={it.uid} index={i} item={it} {...props} onMoveBy={(d) => moveBy(i, d)} />
      ))}
    </ol>
  )

  if (readOnly) return list
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{
        announcements,
        screenReaderInstructions: {
          draggable: t('items.dnd.instructions'),
        },
      }}
    >
      <SortableContext items={items.map((i) => i.uid)} strategy={verticalListSortingStrategy}>
        {list}
      </SortableContext>
    </DndContext>
  )
}

function ItemRow({
  item,
  index,
  readOnly,
  stopOnFailure,
  errors,
  warnings,
  onChange,
  onRemove,
  onMoveBy,
}: ItemsListProps & { item: DraftItem; index: number; onMoveBy: (delta: number) => void }) {
  const tc = item.test_case
  const error = errors[item.uid]
  const warning = warnings[item.uid]
  const pos = index + 1
  const { t } = useTranslation('flows')
  const p = String(pos)
  const sortable = useSortable({ id: item.uid, disabled: readOnly, attributes: { roleDescription: t('items.roleDescription') } })
  const style: React.CSSProperties = readOnly
    ? {}
    : { transform: CSS.Transform.toString(sortable.transform && { ...sortable.transform, x: 0 }), transition: sortable.transition }
  const errorId = `flow-item-${item.uid}-error`
  const warnId = `flow-item-${item.uid}-warn`
  const showCof = stopOnFailure && (!readOnly || item.continue_on_failure)

  return (
    <li
      ref={readOnly ? undefined : sortable.setNodeRef}
      style={style}
      data-item={item.uid}
      data-invalid={error ? 'true' : undefined}
      onKeyDown={(e) => {
        if (readOnly || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
        e.preventDefault()
        onMoveBy(e.key === 'ArrowUp' ? -1 : 1)
      }}
      className={cn(
        'relative bg-card',
        sortable.isDragging && 'z-10 shadow-overlay',
        error && 'before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-destructive',
      )}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 pr-2 pl-3 @3xl:min-h-10 @3xl:flex-nowrap @3xl:py-1">
        <div className={cn('flex min-w-0 flex-1 basis-full items-center gap-2 @3xl:basis-auto', !item.enabled && 'opacity-60')}>
          <span className="w-5 shrink-0 text-right text-xs text-muted-foreground tabular" aria-hidden>
            {pos}
          </span>
          {!readOnly && (
            <button
              type="button"
              ref={sortable.setActivatorNodeRef}
              data-grip={item.uid}
              className="-ml-1 flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              {...sortable.attributes}
              {...sortable.listeners}
              aria-label={t('items.gripLabel', { n: p, key: tc.key, title: tc.title })}
              aria-describedby={[sortable.attributes['aria-describedby'], error && errorId].filter(Boolean).join(' ')}
            >
              <GripVertical className="size-4" aria-hidden />
            </button>
          )}
          <span className="shrink-0 font-mono text-xs font-medium">{tc.key}</span>
          <span className="min-w-0 truncate" title={tc.title}>
            {tc.title}
          </span>
          <span className="sr-only">, {t('items.position', { n: p })}</span>
          <ManualBadge execution={tc.execution} className="shrink-0" />
          {!item.enabled && <span className="shrink-0 text-xs text-muted-foreground">{t('items.disabled')}</span>}
        </div>

        <div className={cn('flex min-w-0 basis-full flex-wrap items-center gap-x-3 gap-y-1.5 @3xl:shrink-0 @3xl:basis-auto @3xl:pl-0', readOnly ? 'pl-7' : 'pl-15')}>
          {warning ? (
            <Tip label={warning}>
              <span
                tabIndex={0}
                aria-describedby={warnId}
                className="inline-flex items-center gap-1 rounded-sm text-xs font-medium text-status-blocked focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <TriangleAlert className="size-3.5" aria-hidden />
                {TC_STATUS_LABELS[tc.status]}
                <span id={warnId} className="sr-only">
                  {warning}
                </span>
              </span>
            </Tip>
          ) : (
            <span className="text-xs text-muted-foreground">{TC_STATUS_LABELS[tc.status]}</span>
          )}
          <span className="w-14 text-right text-xs whitespace-nowrap text-muted-foreground tabular">{t('items.stepCount', { count: tc.step_count })}</span>

          {showCof &&
            (readOnly ? (
              <span className="text-xs text-muted-foreground">{t('items.continueOnFailure')}</span>
            ) : (
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={item.continue_on_failure}
                  onCheckedChange={(v) => onChange(item.uid, { continue_on_failure: v })}
                  aria-label={t('items.cofLabel', { n: p, key: tc.key })}
                />
                <span aria-hidden className="whitespace-nowrap">
                  {t('items.continueOnFailure')}
                </span>
              </label>
            ))}

          {!readOnly && (
            <>
              <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Switch
                  checked={item.enabled}
                  onCheckedChange={(v) => onChange(item.uid, { enabled: v })}
                  aria-label={t('items.enableLabel', { n: p, key: tc.key })}
                />
                <span aria-hidden>{t('items.enabled')}</span>
              </label>
              <Tip label={t('items.remove')}>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => onRemove(item.uid)}
                  aria-label={t('items.removeLabel', { n: p, key: tc.key })}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X />
                </Button>
              </Tip>
            </>
          )}
        </div>
      </div>
      {error && (
        <p id={errorId} className={cn('flex items-start gap-1.5 pr-3 pb-2 text-xs text-destructive @3xl:-mt-1', readOnly ? 'pl-10' : 'pl-[4.5rem]')}>
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          {error}
        </p>
      )}
    </li>
  )
}
