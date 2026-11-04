import { CircleCheck, CircleDashed } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useUpdateMe } from '@/api/queries'
import { useAuth } from '@/app/auth'
import { useChangeLanguage } from '@/app/language'
import { PageContainer, PageHeader, Panel } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import {
  apiFieldErrors,
  Banner,
  describedBy,
  Field,
  focusFirstError,
  GoogleIcon,
  MIN_PASSWORD,
  PasswordInput,
  PasswordLengthHint,
  type FieldErrors,
} from '@/features/auth/shared'
import { LANGUAGES, type Language } from '@/i18n'
import { formatDateTime } from '@/lib/format'

export function ProfilePage() {
  const { t } = useTranslation('account')
  const me = useAuth()
  return (
    <PageContainer narrow>
      <PageHeader title={t('profile.title')} description={t('profile.description')} />
      <NameSection key={me.user.name} />
      <LanguageSection />
      <PasswordSection />
      <GoogleSection />
    </PageContainer>
  )
}

function NameSection() {
  const { t } = useTranslation(['account', 'common'])
  const { user } = useAuth()
  const update = useUpdateMe()
  const [name, setName] = React.useState(user.name)
  const [error, setError] = React.useState<string>()
  const dirty = name.trim() !== user.name

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError(t('profile.nameRequired'))
      document.getElementById('profile-name')?.focus()
      return
    }
    if (!dirty) return
    update.mutate(
      { name: name.trim() },
      {
        onSuccess: () => toast.success(t('profile.nameSaved')),
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (fe.name) setError(fe.name)
          else toast.error(t('common:errors.saveFailed', { message: errorMessage(err) }))
        },
      },
    )
  }

  return (
    <Panel title={t('profile.section')}>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">{t('profile.email')}</dt>
          <dd className="min-w-0">
            <span className="font-mono text-xs break-all">{user.email}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{t('profile.emailHint')}</span>
          </dd>
          <dt className="text-muted-foreground">{t('profile.systemRole')}</dt>
          <dd>{user.system_role === 'admin' ? t('profile.roleAdmin') : t('profile.roleMember')}</dd>
          <dt className="text-muted-foreground">{t('profile.lastLogin')}</dt>
          <dd className="tabular">{formatDateTime(user.last_login_at)}</dd>
        </dl>
        <div className="h-px bg-border" />
        <Field id="profile-name" label={t('profile.name')} error={error} className="max-w-sm">
          <Input
            id="profile-name"
            autoComplete="name"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(undefined)
            }}
            aria-invalid={!!error || undefined}
            aria-describedby={describedBy('profile-name', { error })}
          />
        </Field>
        <div className="flex items-center gap-3">
          <Button type="submit" loading={update.isPending} aria-disabled={!dirty || undefined} aria-describedby={!dirty ? 'profile-name-state' : undefined}>
            {t('profile.saveName')}
          </Button>
          {!dirty && (
            <span id="profile-name-state" className="text-xs text-muted-foreground">
              {t('common:states.noChanges')}
            </span>
          )}
        </div>
      </form>
    </Panel>
  )
}

function LanguageSection() {
  const { t } = useTranslation(['account', 'common'])
  const { language, change, isPending, isSaved } = useChangeLanguage()
  return (
    <Panel title={t('language.title')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('language.description')}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Segmented<Language>
            ariaLabel={t('language.label')}
            value={language}
            onChange={(v) => void change(v)}
            options={LANGUAGES}
          />
          <span role="status" className="text-xs text-muted-foreground">
            {isPending ? t('common:states.saving') : isSaved ? t('language.saved') : null}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">{t('language.statusNote')}</p>
      </div>
    </Panel>
  )
}

function PasswordSection() {
  const { t } = useTranslation(['account', 'common'])
  const { user } = useAuth()
  const update = useUpdateMe()
  const needsCurrent = user.has_password
  const [current, setCurrent] = React.useState('')
  const [next, setNext] = React.useState('')
  const [confirm, setConfirm] = React.useState('')
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(null)

  const clear = (field: string) => errors[field] && setErrors((x) => ({ ...x, [field]: undefined }))
  const order: [string, string][] = [
    ['current_password', 'pw-current'],
    ['new_password', 'pw-new'],
    ['confirm', 'pw-confirm'],
  ]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v: FieldErrors = {
      current_password: needsCurrent && !current ? t('password.currentRequired') : undefined,
      new_password: next.length < MIN_PASSWORD ? t('common:validation.minChars', { count: MIN_PASSWORD }) : undefined,
      confirm: !confirm ? t('password.confirmRequired') : confirm !== next ? t('password.mismatch') : undefined,
    }
    setErrors(v)
    setBanner(null)
    if (Object.values(v).some(Boolean)) return focusFirstError(v, order)
    update.mutate(
      { new_password: next, ...(needsCurrent ? { current_password: current } : {}) },
      {
        onSuccess: () => {
          setCurrent('')
          setNext('')
          setConfirm('')
          toast.success(needsCurrent ? t('password.changed') : t('password.created'))
        },
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (fe.current_password || fe.new_password) {
            setErrors(fe)
            focusFirstError(fe, order)
          } else setBanner(errorMessage(err))
        },
      },
    )
  }

  return (
    <Panel title={needsCurrent ? t('password.changeTitle') : t('password.createTitle')}>
      <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-4">
        {!needsCurrent && (
          <p className="text-sm text-muted-foreground">{t('password.noPasswordIntro')}</p>
        )}
        {banner && <Banner>{banner}</Banner>}
        <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
        {needsCurrent && (
          <Field id="pw-current" label={t('password.current')} error={errors.current_password}>
            <PasswordInput
              id="pw-current"
              autoComplete="current-password"
              value={current}
              onChange={(e) => {
                setCurrent(e.target.value)
                clear('current_password')
              }}
              aria-invalid={!!errors.current_password || undefined}
              aria-describedby={describedBy('pw-current', { error: errors.current_password })}
            />
          </Field>
        )}
        <Field id="pw-new" label={t('password.new')} error={errors.new_password} hint={<PasswordLengthHint value={next} />}>
          <PasswordInput
            id="pw-new"
            autoComplete="new-password"
            value={next}
            onChange={(e) => {
              setNext(e.target.value)
              clear('new_password')
            }}
            aria-invalid={!!errors.new_password || undefined}
            aria-describedby={describedBy('pw-new', { error: errors.new_password, hint: true })}
          />
        </Field>
        <Field id="pw-confirm" label={t('password.confirm')} error={errors.confirm}>
          <PasswordInput
            id="pw-confirm"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value)
              clear('confirm')
            }}
            aria-invalid={!!errors.confirm || undefined}
            aria-describedby={describedBy('pw-confirm', { error: errors.confirm })}
          />
        </Field>
        <div>
          <Button type="submit" loading={update.isPending}>
            {needsCurrent ? t('password.changeTitle') : t('password.createTitle')}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function GoogleSection() {
  const { t } = useTranslation('account')
  const { user } = useAuth()
  const mono = <span className="font-mono text-xs break-all text-foreground" />
  return (
    <Panel title={t('google.title')}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <GoogleIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          {user.google_linked ? (
            <p className="inline-flex items-center gap-1.5 text-sm font-medium">
              <CircleCheck className="size-4 text-status-passed" aria-hidden />
              {t('google.linked')}
            </p>
          ) : (
            <p className="inline-flex items-center gap-1.5 text-sm font-medium">
              <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
              {t('google.notLinked')}
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {user.google_linked ? (
              <Trans t={t} i18nKey="google.linkedBody" values={{ email: user.email }} components={{ mono }} />
            ) : (
              <Trans t={t} i18nKey="google.notLinkedBody" values={{ email: user.email }} components={{ mono, em: <span className="text-foreground" /> }} />
            )}
          </p>
        </div>
      </div>
    </Panel>
  )
}
