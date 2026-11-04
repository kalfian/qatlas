import * as React from 'react'
import { ApiError } from '@/api/client'

/**
 * true setelah `active` bertahan selama `ms` — dipakai agar skeleton tidak berkedip
 * untuk respons cepat (ui-direction §6: delay 150ms).
 */
export function useDelayedFlag(active: boolean, ms = 150): boolean {
  const [shown, setShown] = React.useState(false)
  React.useEffect(() => {
    if (!active) {
      setShown(false)
      return
    }
    const t = window.setTimeout(() => setShown(true), ms)
    return () => window.clearTimeout(t)
  }, [active, ms])
  return active && shown
}

/** Peta `path → pesan` dari ApiError.details (validation_failed / conflict). */
export function fieldErrorsOf(err: unknown): Record<string, string> {
  if (!(err instanceof ApiError)) return {}
  const out: Record<string, string> = {}
  for (const d of err.details) if (!out[d.path]) out[d.path] = d.message
  return out
}

/**
 * Props aksesibel untuk input dengan pesan error opsional. Error menggantikan hint
 * (hanya salah satu yang dirender), jadi describedby menunjuk yang sedang tampil.
 */
export function invalidProps(id: string, error: string | undefined, hintId?: string) {
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-error` : hintId,
  } as const
}

/**
 * Button `loading` memakai `disabled`, sehingga Chromium membuang fokus ke <body> saat
 * aksi berjalan. Kembalikan fokus ke tombol itu setelah selesai (hanya jika fokus memang hilang).
 */
export function useRefocusAfterPending(pending: boolean, ref: React.RefObject<HTMLElement | null>) {
  const was = React.useRef(pending)
  React.useEffect(() => {
    if (was.current && !pending && (document.activeElement === document.body || document.activeElement == null)) ref.current?.focus()
    was.current = pending
  }, [pending, ref])
}

/** Waktu relatif; < 1 menit = "baru saja" (bukan "0 detik lalu"). */
export function relativeTime(iso: string | null | undefined, format: (iso: string) => string): string {
  if (!iso) return '—'
  return Date.now() - Date.parse(iso) < 60_000 ? 'baru saja' : format(iso)
}
