import { CircleAlert, CircleCheck, Eye, EyeOff, FlaskConical, Info, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { ApiError } from '@/api/client'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * Perangkat form bersama untuk fitur auth, account, admin, dan projects.
 * Satu pola: <Field> memberi label + hint + error dengan id yang bisa dirujuk `aria-describedby`.
 */

export type FieldErrors = Record<string, string | undefined>

/** id hint/error yang dirujuk input. */
export function describedBy(id: string, opts: { error?: string; hint?: boolean }): string | undefined {
  const ids = [opts.error ? `${id}-error` : null, opts.hint ? `${id}-hint` : null].filter(Boolean)
  return ids.length ? ids.join(' ') : undefined
}

export function Field({
  id,
  label,
  hint,
  error,
  aside,
  children,
  className,
}: {
  id: string
  label: React.ReactNode
  hint?: React.ReactNode
  error?: string
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        {aside}
      </div>
      {children}
      {error && (
        <p id={`${id}-error`} className="flex items-start gap-1 text-xs text-status-failed">
          <CircleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
          <span>{error}</span>
        </p>
      )}
      {hint && (
        <div id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </div>
      )}
    </div>
  )
}

/** Ambil error per field dari ApiError.details (path → pesan). */
export function apiFieldErrors(err: unknown): FieldErrors {
  if (!(err instanceof ApiError)) return {}
  const out: FieldErrors = {}
  for (const d of err.details) if (!out[d.path]) out[d.path] = d.message
  return out
}

/** Pindahkan fokus ke field error pertama sesuai urutan form. */
export function focusFirstError(errors: FieldErrors, order: [field: string, elementId: string][]) {
  const hit = order.find(([f]) => errors[f])
  if (hit) document.getElementById(hit[1])?.focus()
}

type BannerTone = 'error' | 'warning' | 'info'

const TONE: Record<BannerTone, { cls: string; icon: typeof Info; iconCls: string }> = {
  error: { cls: 'bg-status-failed-bg', icon: CircleAlert, iconCls: 'text-status-failed' },
  warning: { cls: 'bg-status-blocked-bg', icon: TriangleAlert, iconCls: 'text-status-blocked' },
  info: { cls: 'bg-muted', icon: Info, iconCls: 'text-muted-foreground' },
}

/** Banner inline. `error` memakai role="alert" agar diumumkan saat muncul. */
export function Banner({
  tone = 'error',
  title,
  children,
  className,
  role,
}: {
  tone?: BannerTone
  title?: React.ReactNode
  children?: React.ReactNode
  className?: string
  role?: 'alert' | 'status' | 'note'
}) {
  const t = TONE[tone]
  const Icon = t.icon
  return (
    <div
      role={role ?? (tone === 'error' ? 'alert' : undefined)}
      className={cn('flex gap-2 rounded-md px-3 py-2.5 text-sm text-foreground', t.cls, className)}
    >
      <Icon className={cn('mt-0.5 size-4 shrink-0', t.iconCls)} aria-hidden />
      <div className="min-w-0 space-y-0.5">
        {title && <p className="font-medium">{title}</p>}
        {children && <div className={cn(title && 'text-foreground/85')}>{children}</div>}
      </div>
    </div>
  )
}

/** Input password dengan tombol tampilkan/sembunyikan. */
export const PasswordInput = React.forwardRef<HTMLInputElement, Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'>>(
  ({ className, ...props }, ref) => {
    const [shown, setShown] = React.useState(false)
    return (
      <div className="relative">
        <Input ref={ref} type={shown ? 'text' : 'password'} className={cn('pr-9', className)} {...props} />
        <button
          type="button"
          onClick={() => setShown((s) => !s)}
          aria-pressed={shown}
          aria-label={shown ? 'Sembunyikan password' : 'Tampilkan password'}
          className="absolute inset-y-0 right-0 flex w-9 items-center justify-center rounded-r-md text-muted-foreground transition-colors duration-150 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {shown ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      </div>
    )
  },
)
PasswordInput.displayName = 'PasswordInput'

export const MIN_PASSWORD = 10

/** Hint live panjang password (dipakai invite & profil). */
export function PasswordLengthHint({ value }: { value: string }) {
  const ok = value.length >= MIN_PASSWORD
  if (ok)
    return (
      <span className="inline-flex items-center gap-1 text-status-passed">
        <CircleCheck className="size-3" aria-hidden />
        Panjang cukup
      </span>
    )
  return (
    <span>
      Minimal {MIN_PASSWORD} karakter
      {value.length > 0 && <span className="tabular"> · {MIN_PASSWORD - value.length} lagi</span>}
    </span>
  )
}

/** Logo "G" resmi Google (multiwarna, sesuai pedoman branding). */
export function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 18 18" className={className} aria-hidden focusable="false">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z" />
      <path fill="#FBBC05" d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.05l3.01-2.33Z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z" />
    </svg>
  )
}

export function Wordmark() {
  return (
    <div className="flex items-center gap-2">
      <FlaskConical className="size-5 text-foreground" aria-hidden />
      <span className="text-lg font-semibold tracking-tight">QAtlas</span>
    </div>
  )
}

/** Shell halaman publik (login, invite): satu kolom 360px di tengah layar. */
export function AuthShell({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center bg-background px-4 py-10">
      <main id="main" className="flex w-full max-w-90 flex-col gap-6">
        <Wordmark />
        {children}
        {footer}
      </main>
    </div>
  )
}

/** Divider "atau". */
export function OrDivider() {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground" role="separator" aria-label="atau">
      <span className="h-px flex-1 bg-border" />
      atau
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

/** Render children setelah `delay` ms; mencegah skeleton berkedip untuk respons cepat. */
export function Delayed({ children, delay = 150 }: { children: React.ReactNode; delay?: number }) {
  const [show, setShow] = React.useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setShow(true), delay)
    return () => clearTimeout(t)
  }, [delay])
  return show ? <>{children}</> : null
}

/** Redirect setelah login hanya ke path internal (cegah open redirect). */
export function safeRedirect(target: string | undefined): string {
  if (!target || !target.startsWith('/') || target.startsWith('//') || target.startsWith('/login')) return '/'
  return target
}
