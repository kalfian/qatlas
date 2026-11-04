import * as DialogPrimitive from '@radix-ui/react-dialog'
import { ChevronLeft, ChevronRight, Download, ExternalLink, FileText, ImageOff, Video, X } from 'lucide-react'
import * as React from 'react'
import { Button } from '@/components/ui/button'
import { StatusIcon } from '@/components/status'
import { cn } from '@/lib/utils'
import type { MediaItem } from './runUtils'

/** Placeholder abu untuk artifact kedaluwarsa — ukuran sama dengan aslinya. */
export function ExpiredArtifact({ className, label = 'Artifact kedaluwarsa' }: { className?: string; label?: string }) {
  return (
    <div className={cn('flex flex-col items-center justify-center gap-1 rounded-sm border border-dashed border-border bg-muted text-xs text-muted-foreground', className)}>
      <ImageOff className="size-4" aria-hidden />
      <span>{label}</span>
    </div>
  )
}

/**
 * Thumbnail screenshot/lampiran. Tombol → lightbox. `size="sm"` dipakai inline di baris step,
 * `size="lg"` di detail step gagal (320px; lebar penuh di mobile).
 */
export function Thumb({ item, size = 'sm', onOpen, className }: { item: MediaItem; size?: 'sm' | 'lg'; onOpen: () => void; className?: string }) {
  const box = size === 'sm' ? 'h-7 w-12' : 'aspect-video w-full sm:w-80'
  if (item.expired)
    return <ExpiredArtifact className={cn(box, className)} label={size === 'sm' ? 'Kedaluwarsa' : 'Artifact kedaluwarsa'} />
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(
        'group relative shrink-0 overflow-hidden rounded-sm border border-border bg-muted transition-colors duration-150 hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        box,
        className,
      )}
      aria-label={`Buka ${item.alt}`}
    >
      <img src={item.url} alt="" loading="lazy" className="size-full object-cover object-top" />
    </button>
  )
}

/** Tile untuk lampiran non-gambar (video/file): link unduh. */
export function FileTile({ name, url, mime, sizeLabel }: { name: string; url: string; mime: string; sizeLabel?: string }) {
  const Icon = mime.startsWith('video/') ? Video : FileText
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      download={name}
      className="flex h-9 max-w-56 items-center gap-2 rounded-sm border border-border bg-muted px-2 text-xs hover:border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="truncate">{name}</span>
      {sizeLabel && <span className="shrink-0 text-muted-foreground tabular">{sizeLabel}</span>}
    </a>
  )
}

/**
 * Lightbox (ui-direction §Run view): dialog layar penuh solid, ←/→ antar item, klik gambar = 100%/fit,
 * Unduh / Buka di tab baru, Esc menutup, fokus kembali ke thumbnail asal (Radix FocusScope).
 */
export function Lightbox({
  items,
  index,
  onIndexChange,
  onClose,
  returnFocusTo,
}: {
  items: MediaItem[]
  index: number | null
  onIndexChange: (i: number) => void
  onClose: () => void
  /** Elemen asal (thumbnail) — dialog dibuka tanpa Radix Trigger, jadi fokus dikembalikan manual. */
  returnFocusTo?: React.RefObject<HTMLElement | null>
}) {
  const open = index != null && items.length > 0
  const i = open ? Math.min(index, items.length - 1) : 0
  const item = items[i]
  const [zoom, setZoom] = React.useState(false)
  const [prevId, setPrevId] = React.useState<string | undefined>(item?.id)
  if (item?.id !== prevId) {
    setPrevId(item?.id)
    setZoom(false)
  }

  const go = (d: number) => {
    if (items.length < 2) return
    onIndexChange((i + d + items.length) % items.length)
  }

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            returnFocusTo?.current?.focus()
          }}
          className="fixed inset-0 z-50 flex flex-col bg-background/95 text-foreground outline-none"
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              go(-1)
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              go(1)
            }
          }}
        >
          {item && (
            <>
              <div className="flex min-h-12 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-background px-3 py-1.5 md:px-4">
                {item.status && <StatusIcon status={item.status} />}
                <DialogPrimitive.Title className="min-w-0 flex-1 truncate font-mono text-xs font-medium sm:text-sm">{item.caption}</DialogPrimitive.Title>
                <span className="text-xs text-muted-foreground tabular" aria-hidden>
                  {i + 1} / {items.length}
                </span>
                <div className="flex items-center gap-1">
                  {!item.expired && (
                    <>
                      <Button asChild variant="ghost" size="sm" className="max-sm:h-11">
                        <a href={item.url} download={item.name}>
                          <Download /> <span className="max-sm:sr-only">Unduh</span>
                        </a>
                      </Button>
                      <Button asChild variant="ghost" size="sm" className="max-sm:h-11">
                        <a href={item.url} target="_blank" rel="noreferrer">
                          <ExternalLink /> <span className="max-sm:sr-only">Buka di tab baru</span>
                        </a>
                      </Button>
                    </>
                  )}
                  <DialogPrimitive.Close asChild>
                    <Button variant="ghost" size="icon" className="max-sm:size-11" aria-label="Tutup (Esc)">
                      <X />
                    </Button>
                  </DialogPrimitive.Close>
                </div>
              </div>

              <div className="relative flex min-h-0 flex-1">
                <div className="flex min-h-0 flex-1 overflow-auto p-4 md:px-16">
                  {item.expired ? (
                    <ExpiredArtifact className="m-auto aspect-video w-full max-w-3xl" />
                  ) : (
                    <img
                      src={item.url}
                      alt={item.alt}
                      onClick={() => setZoom((z) => !z)}
                      className={cn(
                        'm-auto rounded-sm border border-border bg-white',
                        zoom ? 'max-w-none cursor-zoom-out' : 'max-h-full max-w-full cursor-zoom-in object-contain',
                      )}
                    />
                  )}
                </div>
                {items.length > 1 && (
                  <>
                    <Button
                      variant="outline"
                      size="icon"
                      className="absolute top-1/2 left-2 -translate-y-1/2 max-sm:top-auto max-sm:bottom-3 max-sm:size-11 max-sm:translate-y-0 md:left-4"
                      onClick={() => go(-1)}
                      aria-label="Screenshot sebelumnya (←)"
                    >
                      <ChevronLeft />
                    </Button>
                    <Button
                      variant="outline"
                      size="icon"
                      className="absolute top-1/2 right-2 -translate-y-1/2 max-sm:top-auto max-sm:bottom-3 max-sm:size-11 max-sm:translate-y-0 md:right-4"
                      onClick={() => go(1)}
                      aria-label="Screenshot berikutnya (→)"
                    >
                      <ChevronRight />
                    </Button>
                  </>
                )}
              </div>
              <p className="sr-only" aria-live="polite">
                {`Gambar ${i + 1} dari ${items.length}`}
              </p>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
