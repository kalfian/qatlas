import { useRouter, useSearch } from '@tanstack/react-router'
import { LoaderCircle } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { ApiError } from '@/api/client'
import { useAuthConfig, useLogin, useMe, useMockGoogleLogin } from '@/api/queries'
import { IS_MOCK } from '@/app/config'
import { Avatar } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DEMO_PASSWORD, GOOGLE_ACCOUNTS } from '@/mocks/constants'
import {
  AuthShell,
  Banner,
  describedBy,
  Field,
  focusFirstError,
  GoogleIcon,
  OrDivider,
  PasswordInput,
  safeRedirect,
  type FieldErrors,
} from './shared'

function loginErrorMessage(err: unknown, t: TFunction<'auth'>): string {
  if (err instanceof ApiError) {
    if (err.code === 'invalid_credentials' || err.status === 401) return t('login.invalidCredentials')
    if (err.code === 'not_registered') return t('login.notRegistered')
    if (err.code === 'domain_not_allowed') return t('login.domainNotAllowed')
    // lockout / rate limit: pesan server menyebut durasinya
    return err.message
  }
  return t('login.network')
}

function searchErrorMessage(code: string | undefined, t: TFunction<'auth'>): string | null {
  if (!code) return null
  if (code === 'not_registered') return t('login.notRegistered')
  if (code === 'domain_not_allowed') return t('login.domainNotAllowed')
  return t('login.googleFailed')
}

export function LoginPage() {
  const search = useSearch({ from: '/login' })
  const router = useRouter()
  const { t } = useTranslation('auth')
  const me = useMe()
  const target = safeRedirect(search.redirect)
  const signedIn = !!me.data

  // Sesi masih aktif saat membuka /login → langsung ke tujuan.
  React.useEffect(() => {
    if (signedIn) router.history.replace(target)
  }, [signedIn, router, target])

  if (signedIn || me.isPending) return null
  // Login sukses: hook login memanggil queryClient.clear(), jadi observer useMe di atas tidak
  // ikut ter-update. Navigasi eksplisit; entri /login diganti agar tombol Back tidak kembali ke form.
  return <LoginForm searchError={searchErrorMessage(search.error, t)} onSignedIn={() => router.history.replace(target)} />
}

function LoginForm({ searchError, onSignedIn }: { searchError: string | null; onSignedIn: () => void }) {
  const { t } = useTranslation('auth')
  const login = useLogin()
  const [email, setEmail] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(searchError)
  const [googleOpen, setGoogleOpen] = React.useState(false)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const next: FieldErrors = {
      email: email.trim() ? undefined : t('login.emailRequired'),
      password: password ? undefined : t('login.passwordRequired'),
    }
    setErrors(next)
    if (next.email || next.password) {
      focusFirstError(next, [
        ['email', 'login-email'],
        ['password', 'login-password'],
      ])
      return
    }
    setBanner(null)
    login.mutate(
      { email: email.trim(), password },
      {
        onSuccess: onSignedIn,
        onError: (err) => {
          setBanner(loginErrorMessage(err, t))
          document.getElementById('login-password')?.focus()
        },
      },
    )
  }

  const authConfig = useAuthConfig()
  // Mode mock juga mengikuti /auth/config: Admin → Google sign-in (atau toggle env di dev toolbar) menyalakannya.
  const googleEnabled = authConfig.data?.google_enabled === true
  const google = () => {
    setBanner(null)
    if (IS_MOCK) setGoogleOpen(true)
    else window.location.href = '/api/v1/auth/google/start'
  }

  return (
    <AuthShell
      footer={
        <div className="flex flex-col gap-3 text-xs text-muted-foreground">
          <p>{t('login.noAccount')}</p>
          {IS_MOCK && (
            <p className="border-t border-border pt-3">
              {t('login.demoHint')} <span className="font-mono text-foreground">rina@tokoku.id</span> /{' '}
              <span className="font-mono text-foreground">{DEMO_PASSWORD}</span>{' '}
              <button
                type="button"
                className="rounded-sm text-link underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => {
                  setEmail('rina@tokoku.id')
                  setPassword(DEMO_PASSWORD)
                  setErrors({})
                }}
              >
                {t('login.autofill')}
              </button>
            </p>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{t('login.title')}</h1>
        <p className="text-sm text-muted-foreground">{t('login.subtitle')}</p>
      </div>

      {banner && <Banner>{banner}</Banner>}

      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <Field id="login-email" label={t('login.email')} error={errors.email}>
          <Input
            id="login-email"
            type="email"
            autoComplete="username"
            inputMode="email"
            autoFocus
            className="h-9"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-invalid={!!errors.email || undefined}
            aria-describedby={describedBy('login-email', { error: errors.email })}
          />
        </Field>
        <Field id="login-password" label={t('login.password')} error={errors.password}>
          <PasswordInput
            id="login-password"
            autoComplete="current-password"
            className="h-9"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-invalid={!!errors.password || undefined}
            aria-describedby={describedBy('login-password', { error: errors.password })}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={login.isPending}>
          {t('login.submit')}
        </Button>
      </form>

      {googleEnabled && (
        <>
          <OrDivider />

          <Button type="button" variant="outline" size="lg" className="w-full" onClick={google} disabled={login.isPending}>
            <GoogleIcon className="size-4" />
            {t('login.google')}
          </Button>
        </>
      )}

      {IS_MOCK && (
        <MockGoogleDialog
          open={googleOpen}
          onOpenChange={setGoogleOpen}
          onSuccess={onSignedIn}
          onError={(msg) => {
            setGoogleOpen(false)
            setBanner(msg)
          }}
        />
      )}
    </AuthShell>
  )
}

/** Mode mock: pengganti layar pilih akun Google. Menguji akun terdaftar vs tidak terdaftar. */
function MockGoogleDialog({
  open,
  onOpenChange,
  onSuccess,
  onError,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  onError: (message: string) => void
}) {
  const { t } = useTranslation('auth')
  const google = useMockGoogleLogin()
  const pendingEmail = google.isPending ? google.variables : null

  const pick = (email: string) =>
    google.mutate(email, {
      onSuccess,
      onError: (err) => onError(loginErrorMessage(err, t)),
    })

  return (
    <Dialog open={open} onOpenChange={(o) => !google.isPending && onOpenChange(o)}>
      <DialogContent className="max-w-sm gap-3">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GoogleIcon className="size-4" />
            {t('login.mockGoogleTitle')}
          </DialogTitle>
          <DialogDescription>{t('login.mockGoogleDescription')}</DialogDescription>
        </DialogHeader>
        <ul className="-mx-2 flex flex-col" aria-busy={google.isPending || undefined}>
          {GOOGLE_ACCOUNTS.map((a) => (
            <li key={a.email}>
              <button
                type="button"
                onClick={() => pick(a.email)}
                disabled={google.isPending}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left transition-colors duration-150 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-60"
              >
                <Avatar name={a.name} className="size-7" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-sm font-medium">{a.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">{a.email}</span>
                </span>
                {pendingEmail === a.email && <LoaderCircle className="size-4 animate-spin text-muted-foreground" aria-label={t('login.processing')} />}
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
