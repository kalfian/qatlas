import { Check, Copy } from 'lucide-react'
import * as React from 'react'
import { errorMessage } from '@/api/client'
import { useCreateToken } from '@/api/queries'
import type { TokenScope } from '@/api/types'
import { useAuth } from '@/app/auth'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { useCopy } from '@/components/misc'
import { apiFieldErrors, Banner, describedBy, Field, focusFirstError, type FieldErrors } from '@/features/auth/shared'
import { cn } from '@/lib/utils'

export function mcpCommand(secret: string): string {
  return `claude mcp add --transport http qatlas ${window.location.origin}/mcp --header "Authorization: Bearer ${secret}"`
}

/** Blok teks mono yang bisa disalin (snippet/command). */
export const CopyBlock = React.forwardRef<
  HTMLButtonElement,
  { value: string; label?: string; onCopied?: () => void; className?: string; id?: string }
>(({ value, label = 'Salin', onCopied, className, id }, ref) => {
  const { copied, copy } = useCopy()
  return (
    <div className={cn('flex flex-col gap-2 rounded-md border border-border bg-muted p-3', className)}>
      <pre id={id} className="font-mono text-xs leading-5 whitespace-pre-wrap wrap-anywhere text-foreground">
        {value}
      </pre>
      <div>
        <Button
          ref={ref}
          type="button"
          variant="outline"
          size="sm"
          onClick={async () => {
            await copy(value)
            onCopied?.()
          }}
        >
          {copied ? <Check /> : <Copy />}
          {copied ? 'Tersalin' : label}
        </Button>
      </div>
    </div>
  )
})
CopyBlock.displayName = 'CopyBlock'

const SCOPES: { value: TokenScope; description: string }[] = [
  { value: 'read', description: 'Lihat project, test case, flow, run, dan report.' },
  { value: 'write', description: 'Buat dan ubah test case, folder, dan flow.' },
  { value: 'run', description: 'Jalankan test case dan flow, lalu ambil hasilnya.' },
]

type Expiry = '30' | '90' | 'none'
type ProjectMode = 'all' | 'some'

interface Created {
  name: string
  secret: string
}

export function CreateTokenDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [created, setCreated] = React.useState<Created | null>(null)
  const [copiedOnce, setCopiedOnce] = React.useState(false)
  const [confirmClose, setConfirmClose] = React.useState(false)
  // Kunci form: di-reset setiap dialog dibuka ulang.
  const [formKey, setFormKey] = React.useState(0)

  const close = () => {
    onOpenChange(false)
    // Biarkan animasi tutup selesai sebelum state dibuang.
    setTimeout(() => {
      setCreated(null)
      setCopiedOnce(false)
      setFormKey((k) => k + 1)
    }, 160)
  }

  const requestClose = () => {
    if (created && !copiedOnce) setConfirmClose(true)
    else close()
  }

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
        <DialogContent className={cn(created ? 'max-w-xl' : 'max-w-md')}>
          {created ? (
            <SecretView created={created} onCopied={() => setCopiedOnce(true)} onDone={close} />
          ) : (
            <TokenForm key={formKey} onCancel={close} onCreated={setCreated} />
          )}
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Tutup tanpa menyalin token?</AlertDialogTitle>
            <AlertDialogDescription>
              Token &ldquo;{created?.name}&rdquo; tidak akan ditampilkan lagi. Kalau belum tersimpan, kamu harus mencabutnya dan membuat token baru.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Kembali</AlertDialogCancel>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirmClose(false)
                close()
              }}
            >
              Tutup tanpa menyalin
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function TokenForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: (c: Created) => void }) {
  const { projects } = useAuth()
  const create = useCreateToken()
  const [name, setName] = React.useState('')
  const [scopes, setScopes] = React.useState<TokenScope[]>(['read'])
  const [projectMode, setProjectMode] = React.useState<ProjectMode>('all')
  const [projectKeys, setProjectKeys] = React.useState<string[]>([])
  const [expiry, setExpiry] = React.useState<Expiry>('90')
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(null)

  const order: [string, string][] = [
    ['name', 'token-name'],
    ['scopes', 'token-scope-read'],
    ['project_keys', projects[0] ? `token-project-${projects[0].key}` : 'token-name'],
  ]

  const toggle = <T,>(list: T[], v: T, on: boolean) => (on ? [...list, v] : list.filter((x) => x !== v))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v: FieldErrors = {
      name: name.trim() ? undefined : 'Isi nama token',
      scopes: scopes.length ? undefined : 'Pilih minimal satu scope',
      project_keys: projectMode === 'some' && !projectKeys.length ? 'Pilih minimal satu project' : undefined,
    }
    setErrors(v)
    setBanner(null)
    if (Object.values(v).some(Boolean)) return focusFirstError(v, order)
    create.mutate(
      {
        name: name.trim(),
        // urutan scope konsisten read → write → run
        scopes: SCOPES.map((s) => s.value).filter((s) => scopes.includes(s)),
        project_keys: projectMode === 'some' ? projectKeys : null,
        expires_in_days: expiry === 'none' ? null : Number(expiry),
      },
      {
        onSuccess: (res) => onCreated({ name: res.token.name, secret: res.secret }),
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (Object.keys(fe).length) {
            setErrors(fe)
            focusFirstError(fe, order)
          } else setBanner(errorMessage(err))
        },
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Buat token</DialogTitle>
        <DialogDescription>Token ditampilkan sekali setelah dibuat. Hak efektifnya = scope token ∩ role kamu di tiap project.</DialogDescription>
      </DialogHeader>

      {banner && <Banner>{banner}</Banner>}

      <Field id="token-name" label="Nama" error={errors.name} hint="Mis. “Claude Code laptop” atau “CI GitHub Actions”.">
        <Input
          id="token-name"
          autoFocus
          maxLength={80}
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            if (errors.name) setErrors((x) => ({ ...x, name: undefined }))
          }}
          aria-invalid={!!errors.name || undefined}
          aria-describedby={describedBy('token-name', { error: errors.name, hint: true })}
        />
      </Field>

      <fieldset className="flex flex-col gap-2" aria-describedby={errors.scopes ? 'token-scopes-error' : undefined}>
        <legend className="mb-2 text-sm font-medium">Scope</legend>
        {SCOPES.map((s) => (
          <div key={s.value} className="flex items-start gap-2.5">
            <Checkbox
              id={`token-scope-${s.value}`}
              className="mt-0.5"
              checked={scopes.includes(s.value)}
              onCheckedChange={(c) => {
                setScopes((x) => toggle(x, s.value, c === true))
                if (errors.scopes) setErrors((x) => ({ ...x, scopes: undefined }))
              }}
              aria-describedby={`token-scope-${s.value}-desc`}
            />
            <div className="flex flex-col gap-0.5">
              <Label htmlFor={`token-scope-${s.value}`} className="font-mono text-xs leading-5">
                {s.value}
              </Label>
              <span id={`token-scope-${s.value}-desc`} className="text-xs text-muted-foreground">
                {s.description}
              </span>
            </div>
          </div>
        ))}
        {errors.scopes && (
          <p id="token-scopes-error" className="text-xs text-status-failed">
            {errors.scopes}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-2">
        <span id="token-projects-label" className="text-sm font-medium">
          Batas project
        </span>
        <Segmented<ProjectMode>
          ariaLabel="Batas project"
          value={projectMode}
          onChange={(v) => {
            setProjectMode(v)
            if (errors.project_keys) setErrors((x) => ({ ...x, project_keys: undefined }))
          }}
          options={[
            { value: 'all', label: 'Semua project saya' },
            { value: 'some', label: 'Project tertentu' },
          ]}
          className="self-start"
        />
        {projectMode === 'some' &&
          (projects.length ? (
            <fieldset
              aria-labelledby="token-projects-label"
              aria-describedby={errors.project_keys ? 'token-projects-error' : undefined}
              className="flex flex-col gap-1 rounded-md border border-border p-2"
            >
              {projects.map((p) => (
                <div key={p.key} className="flex h-8 items-center gap-2.5 px-1">
                  <Checkbox
                    id={`token-project-${p.key}`}
                    checked={projectKeys.includes(p.key)}
                    onCheckedChange={(c) => {
                      setProjectKeys((x) => toggle(x, p.key, c === true))
                      if (errors.project_keys) setErrors((x) => ({ ...x, project_keys: undefined }))
                    }}
                  />
                  <Label htmlFor={`token-project-${p.key}`} className="flex min-w-0 items-center gap-2 font-normal">
                    <span className="w-20 shrink-0 font-mono text-xs font-medium">{p.key}</span>
                    <span className="truncate text-muted-foreground">{p.name}</span>
                  </Label>
                </div>
              ))}
            </fieldset>
          ) : (
            <p className="text-xs text-muted-foreground">Kamu belum jadi member project mana pun.</p>
          ))}
        {errors.project_keys && (
          <p id="token-projects-error" className="text-xs text-status-failed">
            {errors.project_keys}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium">Kedaluwarsa</span>
        <Segmented<Expiry>
          ariaLabel="Kedaluwarsa"
          value={expiry}
          onChange={setExpiry}
          options={[
            { value: '30', label: '30 hari' },
            { value: '90', label: '90 hari' },
            { value: 'none', label: 'Tanpa kedaluwarsa' },
          ]}
          className="self-start"
        />
        {expiry === 'none' && <p className="text-xs text-muted-foreground">Token berlaku sampai kamu mencabutnya. Cocok untuk CI, tapi rotasi tetap disarankan.</p>}
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
          Batal
        </Button>
        <Button type="submit" loading={create.isPending}>
          Buat token
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecretView({ created, onCopied, onDone }: { created: Created; onCopied: () => void; onDone: () => void }) {
  const copyRef = React.useRef<HTMLButtonElement>(null)
  const { copied, copy } = useCopy()

  // Fokus pindah ke tombol Salin saat state berganti (a11y checklist §7).
  React.useEffect(() => {
    copyRef.current?.focus()
  }, [])

  return (
    <div className="flex flex-col gap-5">
      <DialogHeader>
        <DialogTitle>Token &ldquo;{created.name}&rdquo; dibuat</DialogTitle>
        <DialogDescription>Simpan di password manager atau langsung pasang ke Claude Code.</DialogDescription>
      </DialogHeader>

      <Banner tone="warning" role="status">
        <span className="font-medium">Salin sekarang</span> — token tidak akan ditampilkan lagi.
      </Banner>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="token-secret">Token</Label>
        <div className="flex gap-2">
          <Input
            id="token-secret"
            readOnly
            value={created.secret}
            className="font-mono text-xs"
            onFocus={(e) => e.currentTarget.select()}
          />
          <Button
            ref={copyRef}
            type="button"
            variant="outline"
            className="w-26"
            onClick={async () => {
              await copy(created.secret, 'Token disalin')
              onCopied()
            }}
          >
            {copied ? <Check /> : <Copy />}
            {copied ? 'Tersalin' : 'Salin'}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-medium" id="token-mcp-label">
          Setup MCP di Claude Code
        </span>
        <CopyBlock value={mcpCommand(created.secret)} label="Salin perintah" onCopied={onCopied} id="token-mcp" />
      </div>

      <DialogFooter>
        <Button type="button" onClick={onDone}>
          Saya sudah menyalin
        </Button>
      </DialogFooter>
    </div>
  )
}
