import { Check, Copy } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { errorMessage } from '@/api/client'
import { useAdminCreateUser } from '@/api/queries'
import type { SystemRole, User, UserInvite } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { Skeleton } from '@/components/ui/skeleton'
import { useCopy } from '@/components/misc'
import { apiFieldErrors, Banner, describedBy, Field, focusFirstError, type FieldErrors } from '@/features/auth/shared'
import { formatDateTime } from '@/lib/format'

export interface LinkDialogState {
  user: User
  kind: 'invite' | 'reset_password'
  result: UserInvite | null
  error?: string
}

const firstName = (name: string) => name.split(/\s+/)[0]

/** Isi state "Link undangan": input mono read-only + Salin. Fokus pindah ke Salin saat muncul. */
function InviteLinkBody({ invite, kind, onDone }: { invite: UserInvite; kind: 'invite' | 'reset_password'; onDone: () => void }) {
  const { t } = useTranslation(['admin', 'common'])
  const { copied, copy } = useCopy()
  const copyRef = React.useRef<HTMLButtonElement>(null)
  React.useEffect(() => {
    copyRef.current?.focus()
  }, [])
  const name = firstName(invite.user.name)

  return (
    <>
      <DialogHeader>
        <DialogTitle>{kind === 'invite' ? t('link.inviteTitle', { name }) : t('link.resetTitle', { name })}</DialogTitle>
        <DialogDescription>
          {t('link.sendHint', { name })}{' '}
          {kind === 'invite' ? t('link.inviteHint', { name, email: invite.user.email }) : t('link.resetHint')}
        </DialogDescription>
      </DialogHeader>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="invite-url" className="text-sm font-medium">
          {kind === 'invite' ? t('link.inviteLabel') : t('link.resetLabel')}
        </label>
        <div className="flex gap-2">
          <Input id="invite-url" readOnly value={invite.invite_url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} aria-describedby="invite-url-hint" />
          <Button ref={copyRef} type="button" variant="outline" className="w-26" onClick={() => copy(invite.invite_url, t('link.copiedToast'))}>
            {copied ? <Check /> : <Copy />}
            {copied ? t('common:actions.copied') : t('common:actions.copy')}
          </Button>
        </div>
        <p id="invite-url-hint" className="text-xs text-muted-foreground">
          {t('link.validity', { date: formatDateTime(invite.expires_at) })}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" onClick={onDone}>
          {t('common:actions.done')}
        </Button>
      </DialogFooter>
    </>
  )
}

/** Dialog untuk "Buat ulang link undangan" / "Buat link reset password" dari menu baris. */
export function InviteLinkDialog({ state, onClose }: { state: LinkDialogState | null; onClose: () => void }) {
  const { t } = useTranslation(['admin', 'common'])
  const [last, setLast] = React.useState(state)
  if (state && state !== last) setLast(state)
  const s = state ?? last

  return (
    <Dialog open={!!state} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        {s?.result ? (
          <InviteLinkBody invite={s.result} kind={s.kind} onDone={onClose} />
        ) : s?.error ? (
          <>
            <DialogHeader>
              <DialogTitle>{t('link.failedTitle')}</DialogTitle>
              <DialogDescription className="sr-only">{t('link.failedDescription', { name: s.user.name })}</DialogDescription>
            </DialogHeader>
            <Banner>{s.error}</Banner>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>
                {t('common:actions.close')}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <div className="flex flex-col gap-4" aria-busy>
            <DialogHeader>
              <DialogTitle>{s?.kind === 'reset_password' ? t('link.creatingReset') : t('link.creatingInvite')}</DialogTitle>
              <DialogDescription>{t('link.forUser', { name: s?.user.name ?? '' })}</DialogDescription>
            </DialogHeader>
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-3.5 w-56" />
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [created, setCreated] = React.useState<UserInvite | null>(null)
  const [formKey, setFormKey] = React.useState(0)

  const close = () => {
    onOpenChange(false)
    setTimeout(() => {
      setCreated(null)
      setFormKey((k) => k + 1)
    }, 160)
  }

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className={created ? 'max-w-lg' : 'max-w-md'}>
        {created ? <InviteLinkBody invite={created} kind="invite" onDone={close} /> : <CreateUserForm key={formKey} onCancel={close} onCreated={setCreated} />}
      </DialogContent>
    </Dialog>
  )
}

function CreateUserForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (res: UserInvite) => void }) {
  const { t } = useTranslation(['admin', 'common'])
  const create = useAdminCreateUser()
  const [email, setEmail] = React.useState('')
  const [name, setName] = React.useState('')
  const [role, setRole] = React.useState<SystemRole>('member')
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(null)
  const order: [string, string][] = [
    ['email', 'user-email'],
    ['name', 'user-name'],
  ]

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const em = email.trim()
    const v: FieldErrors = {
      email: !em ? t('createDialog.emailRequired') : !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em) ? t('createDialog.emailInvalid') : undefined,
      name: name.trim() ? undefined : t('createDialog.nameRequired'),
    }
    setErrors(v)
    setBanner(null)
    if (v.email || v.name) return focusFirstError(v, order)
    create.mutate(
      { email: em, name: name.trim(), system_role: role },
      {
        onSuccess: onCreated,
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (fe.email || fe.name) {
            setErrors(fe)
            focusFirstError(fe, order)
          } else setBanner(errorMessage(err))
        },
      },
    )
  }

  const clear = (f: string) => errors[f] && setErrors((x) => ({ ...x, [f]: undefined }))

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>{t('createDialog.title')}</DialogTitle>
        <DialogDescription>{t('createDialog.description')}</DialogDescription>
      </DialogHeader>
      {banner && <Banner>{banner}</Banner>}
      <Field id="user-email" label={t('createDialog.email')} error={errors.email}>
        <Input
          id="user-email"
          type="email"
          inputMode="email"
          autoComplete="off"
          autoFocus
          placeholder={t('createDialog.emailPlaceholder')}
          className="font-mono text-xs"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value)
            clear('email')
          }}
          aria-invalid={!!errors.email || undefined}
          aria-describedby={describedBy('user-email', { error: errors.email })}
        />
      </Field>
      <Field id="user-name" label={t('createDialog.name')} error={errors.name}>
        <Input
          id="user-name"
          autoComplete="off"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            clear('name')
          }}
          aria-invalid={!!errors.name || undefined}
          aria-describedby={describedBy('user-name', { error: errors.name })}
        />
      </Field>
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">{t('createDialog.systemRole')}</span>
        <Segmented<SystemRole>
          ariaLabel={t('createDialog.systemRole')}
          value={role}
          onChange={setRole}
          options={[
            { value: 'member', label: 'Member' },
            { value: 'admin', label: 'Admin' },
          ]}
          className="self-start"
        />
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {role === 'member'
            ? t('createDialog.memberDescription')
            : t('createDialog.adminDescription')}
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
          {t('common:actions.cancel')}
        </Button>
        <Button type="submit" loading={create.isPending}>
          {t('createDialog.submit')}
        </Button>
      </DialogFooter>
    </form>
  )
}
