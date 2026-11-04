import { format, formatDistanceToNowStrict, parseISO } from 'date-fns'
import { id as localeId } from 'date-fns/locale'

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseISO(iso), 'd MMM yyyy, HH:mm', { locale: localeId })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseISO(iso), 'd MMM yyyy', { locale: localeId })
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  if (Math.abs(Date.now() - parseISO(iso).getTime()) < 45_000) return 'baru saja'
  return `${formatDistanceToNowStrict(parseISO(iso), { locale: localeId })} lalu`
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} dtk`
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return `${m}m ${rs}d`
  const h = Math.floor(m / 60)
  return `${h}j ${m % 60}m`
}

export function formatPercent(v: number | null | undefined): string {
  if (v == null) return '—'
  return `${Math.round(v * 100)}%`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
