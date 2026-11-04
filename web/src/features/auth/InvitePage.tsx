import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { Link2Off } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { ApiError, errorMessage } from '@/api/client'
import { useAcceptInvite, useInvite, useMockGoogleLogin } from '@/api/queries'
import type { InviteInfo } from '@/api/types'
import { IS_MOCK } from '@/app/config'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDateTime } from '@/lib/format'
import {
  apiFieldErrors,
  AuthShell,
  Banner,
  Delayed,
  describedBy,
  Field,
  focusFirstError,
  GoogleIcon,
  MIN_PASSWORD,
  OrDivider,
  PasswordInput,
  PasswordLengthHint,
  type FieldErrors,
} from './shared'

export function InvitePage() {
  const { token } = useParams({ from: '/invite/$token' })
  const { t } = useTranslation(['auth', 'common'])
  const invite = useInvite(token)

  if (invite.isPending) {
    return (
      <AuthShell>
        <Delayed>
          <div className="flex flex-col gap-6" aria-hidden>
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-48" />
              <Skeleton className="h-4 w-64" />
            </div>
            <Skeleton className="h-12 w-full" />
            <div className="flex flex-col gap-4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          </div>
        </Delayed>
        <span className="sr-only" role="status">
          {t('invite.checking')}
        </span>
      </AuthShell>
    )
  }

  if (invite.isError) return <InviteInvalid error={invite.error} onRetry={() => invite.refetch()} />

  return <InviteForm token={token} invite={invite.data} />
}

function InviteInvalid({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useTranslation(['auth', 'common'])
  const status = error instanceof ApiError ? error.status : 0
  const known = status === 404 || status === 410
  const title =
    status === 404 ? t('invite.invalidTitle') : status === 410 ? t('invite.usedTitle') : t('invite.checkFailedTitle')
  const body = known
    ? t('invite.invalidBody')
    : errorMessage(error)

  return (
    <AuthShell>
      <div role="alert" className="flex flex-col items-start gap-3">
        <Link2Off className="size-5 text-muted-foreground" aria-hidden />
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {!known && (
          <Button variant="outline" onClick={onRetry}>
            {t('common:actions.retry')}
          </Button>
        )}
        <Button asChild variant={known ? 'default' : 'ghost'}>
          <Link to="/login">{t('invite.toLogin')}</Link>
        </Button>
      </div>
    </AuthShell>
  )
}

function InviteForm({ token, invite }: { token: string; invite: InviteInfo }) {
  const { t } = useTranslation(['auth', 'common'])
  const navigate = useNavigate()
  const accept = useAcceptInvite(token)
  const google = useMockGoogleLogin()
  const isReset = invite.kind === 'reset_password'
  const firstName = invite.name.split(/\s+/)[0]

  const [password, setPassword] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [confirmTouched, setConfirmTouched] = React.useState(false)
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(null)

  const mismatch = confirm.length > 0 && confirm !== password
  // Pesan "tidak sama" muncul live setelah field konfirmasi disentuh, atau saat submit.
  const confirmError = errors.confirm ?? (confirmTouched && mismatch ? t('invite.mismatch') : undefined)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const next: FieldErrors = {
      password: password.length < MIN_PASSWORD ? t('invite.tooShort', { count: MIN_PASSWORD }) : undefined,
      confirm: !confirm ? t('invite.confirmRequired') : confirm !== password ? t('invite.mismatch') : undefined,
    }
    setErrors(next)
    setConfirmTouched(true)
    if (next.password || next.confirm) {
      focusFirstError(next, [
        ['password', 'invite-password'],
        ['confirm', 'invite-confirm'],
      ])
      return
    }
    setBanner(null)
    accept.mutate(password, {
      onSuccess: () => navigate({ to: '/' }),
      onError: (err) => {
        const fe = apiFieldErrors(err)
        if (fe.password) {
          setErrors({ password: fe.password })
          document.getElementById('invite-password')?.focus()
        } else setBanner(errorMessage(err))
      },
    })
  }

  const continueWithGoogle = () => {
    setBanner(null)
    if (!IS_MOCK) {
      window.location.href = '/api/v1/auth/google/start'
      return
    }
    google.mutate(invite.email, {
      onSuccess: () => navigate({ to: '/' }),
      onError: (err) => setBanner(errorMessage(err)),
    })
  }

  const busy = accept.isPending || google.isPending

  return (
    <AuthShell
      footer={<p className="text-xs text-muted-foreground">{t('invite.footer', { date: formatDateTime(invite.expires_at) })}</p>}
    >
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold tracking-tight">{isReset ? t('invite.resetTitle') : t('invite.greeting', { name: firstName })}</h1>
        <p className="text-sm text-muted-foreground">
          {isReset
            ? t('invite.resetBody')
            : t('invite.inviteBody')}
        </p>
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 rounded-md border border-border px-3 py-2.5 text-sm">
        <dt className="text-muted-foreground">{t('invite.name')}</dt>
        <dd className="truncate">{invite.name}</dd>
        <dt className="text-muted-foreground">{t('invite.email')}</dt>
        <dd className="truncate font-mono text-xs leading-5">{invite.email}</dd>
      </dl>

      {banner && <Banner>{banner}</Banner>}

      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        {/* field username tersembunyi agar password manager menyimpan ke akun yang benar */}
        <input type="email" name="username" autoComplete="username" value={invite.email} readOnly hidden />
        <Field
          id="invite-password"
          label={isReset ? t('invite.newPassword') : t('invite.password')}
          error={errors.password}
          hint={<PasswordLengthHint value={password} />}
        >
          <PasswordInput
            id="invite-password"
            autoComplete="new-password"
            autoFocus
            className="h-9"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value)
              if (errors.password) setErrors((x) => ({ ...x, password: undefined }))
            }}
            aria-invalid={!!errors.password || undefined}
            aria-describedby={describedBy('invite-password', { error: errors.password, hint: true })}
          />
        </Field>
        <Field id="invite-confirm" label={t('invite.confirm')} error={confirmError}>
          <PasswordInput
            id="invite-confirm"
            autoComplete="new-password"
            className="h-9"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              if (errors.confirm) setErrors((x) => ({ ...x, confirm: undefined }))
            }}
            onBlur={() => confirm && setConfirmTouched(true)}
            aria-invalid={!!confirmError || undefined}
            aria-describedby={describedBy('invite-confirm', { error: confirmError })}
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={accept.isPending} disabled={google.isPending}>
          {isReset ? t('invite.submitReset') : t('invite.submitInvite')}
        </Button>
      </form>

      {!isReset && (
        <>
          <OrDivider />
          <Button type="button" variant="outline" size="lg" className="w-full" onClick={continueWithGoogle} loading={google.isPending} disabled={busy}>
            {!google.isPending && <GoogleIcon className="size-4" />}
            {t('invite.google')}
          </Button>
        </>
      )}
    </AuthShell>
  )
}
