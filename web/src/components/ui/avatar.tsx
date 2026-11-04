import { cn } from '@/lib/utils'

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('')
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      className={cn('inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold text-secondary-foreground', className)}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}
