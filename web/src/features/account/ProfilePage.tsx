import { CircleCheck, CircleDashed } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useUpdateMe } from '@/api/queries'
import { useAuth } from '@/app/auth'
import { PageContainer, PageHeader, Panel } from '@/components/page'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
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
import { formatDateTime } from '@/lib/format'

export function ProfilePage() {
  const me = useAuth()
  return (
    <PageContainer narrow>
      <PageHeader title="Akun" description="Nama, password, dan login Google untuk akun kamu." />
      <NameSection key={me.user.name} />
      <PasswordSection />
      <GoogleSection />
    </PageContainer>
  )
}

function NameSection() {
  const { user } = useAuth()
  const update = useUpdateMe()
  const [name, setName] = React.useState(user.name)
  const [error, setError] = React.useState<string>()
  const dirty = name.trim() !== user.name

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) {
      setError('Nama wajib diisi')
      document.getElementById('profile-name')?.focus()
      return
    }
    if (!dirty) return
    update.mutate(
      { name: name.trim() },
      {
        onSuccess: () => toast.success('Nama disimpan'),
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (fe.name) setError(fe.name)
          else toast.error(`Gagal menyimpan: ${errorMessage(err)}`)
        },
      },
    )
  }

  return (
    <Panel title="Profil">
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Email</dt>
          <dd className="min-w-0">
            <span className="font-mono text-xs break-all">{user.email}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">Email hanya bisa diubah oleh admin.</span>
          </dd>
          <dt className="text-muted-foreground">System role</dt>
          <dd>{user.system_role === 'admin' ? 'Admin' : 'Member'}</dd>
          <dt className="text-muted-foreground">Login terakhir</dt>
          <dd className="tabular">{formatDateTime(user.last_login_at)}</dd>
        </dl>
        <div className="h-px bg-border" />
        <Field id="profile-name" label="Nama" error={error} className="max-w-sm">
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
            Simpan nama
          </Button>
          {!dirty && (
            <span id="profile-name-state" className="text-xs text-muted-foreground">
              Belum ada perubahan
            </span>
          )}
        </div>
      </form>
    </Panel>
  )
}

function PasswordSection() {
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
      current_password: needsCurrent && !current ? 'Isi password saat ini' : undefined,
      new_password: next.length < MIN_PASSWORD ? `Minimal ${MIN_PASSWORD} karakter` : undefined,
      confirm: !confirm ? 'Ulangi password baru' : confirm !== next ? 'Password tidak sama' : undefined,
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
          toast.success(needsCurrent ? 'Password diganti' : 'Password dibuat. Sekarang kamu juga bisa login dengan email.')
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
    <Panel title={needsCurrent ? 'Ganti password' : 'Buat password'}>
      <form onSubmit={submit} noValidate className="flex max-w-sm flex-col gap-4">
        {!needsCurrent && (
          <p className="text-sm text-muted-foreground">Akun kamu belum punya password dan selama ini masuk lewat Google. Buat password agar bisa login dengan email juga.</p>
        )}
        {banner && <Banner>{banner}</Banner>}
        <input type="email" name="username" autoComplete="username" value={user.email} readOnly hidden />
        {needsCurrent && (
          <Field id="pw-current" label="Password saat ini" error={errors.current_password}>
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
        <Field id="pw-new" label="Password baru" error={errors.new_password} hint={<PasswordLengthHint value={next} />}>
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
        <Field id="pw-confirm" label="Ulangi password baru" error={errors.confirm}>
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
            {needsCurrent ? 'Ganti password' : 'Buat password'}
          </Button>
        </div>
      </form>
    </Panel>
  )
}

function GoogleSection() {
  const { user } = useAuth()
  return (
    <Panel title="Login Google">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border">
          <GoogleIcon className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          {user.google_linked ? (
            <p className="inline-flex items-center gap-1.5 text-sm font-medium">
              <CircleCheck className="size-4 text-status-passed" aria-hidden />
              Terhubung
            </p>
          ) : (
            <p className="inline-flex items-center gap-1.5 text-sm font-medium">
              <CircleDashed className="size-4 text-muted-foreground" aria-hidden />
              Belum terhubung
            </p>
          )}
          <p className="text-sm text-muted-foreground">
            {user.google_linked ? (
              <>
                Kamu bisa masuk dengan akun Google <span className="font-mono text-xs break-all text-foreground">{user.email}</span>.
              </>
            ) : (
              <>
                Pilih <span className="text-foreground">Lanjut dengan Google</span> di halaman login memakai{' '}
                <span className="font-mono text-xs break-all text-foreground">{user.email}</span>. Akun langsung terhubung saat pertama kali dipakai.
              </>
            )}
          </p>
        </div>
      </div>
    </Panel>
  )
}
