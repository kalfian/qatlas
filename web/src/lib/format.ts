import { format, formatDistanceToNowStrict, parseISO, type Locale } from 'date-fns'
import { enUS, id as localeId } from 'date-fns/locale'
import { currentLanguage, i18n } from '@/i18n'

/** date-fns locale untuk bahasa UI aktif. */
export function dateLocale(): Locale {
  return currentLanguage() === 'id' ? localeId : enUS
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseISO(iso), 'd MMM yyyy, HH:mm', { locale: dateLocale() })
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—'
  return format(parseISO(iso), 'd MMM yyyy', { locale: dateLocale() })
}

/** "just now" / "3 hours ago" / "in 2 days" (dan padanan Indonesia). */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = parseISO(iso)
  const diff = Date.now() - at.getTime()
  if (Math.abs(diff) < 45_000) return i18n.t('common:time.justNow')
  const time = formatDistanceToNowStrict(at, { locale: dateLocale() })
  return diff >= 0 ? i18n.t('common:time.ago', { time }) : i18n.t('common:time.in', { time })
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return i18n.t('common:time.seconds', { value: s.toFixed(s < 10 ? 1 : 0) })
  const m = Math.floor(s / 60)
  const rs = Math.round(s % 60)
  if (m < 60) return i18n.t('common:time.minutesSeconds', { m: String(m), s: String(rs) })
  const h = Math.floor(m / 60)
  return i18n.t('common:time.hoursMinutes', { h: String(h), m: String(m % 60) })
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
