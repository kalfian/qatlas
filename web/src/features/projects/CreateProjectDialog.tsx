import { useNavigate } from '@tanstack/react-router'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useCreateProject } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { apiFieldErrors, Banner, describedBy, Field, focusFirstError, type FieldErrors } from '@/features/auth/shared'

const KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/

/** Normalisasi input key: huruf besar, hanya A–Z/0–9, maks 10. */
const normalizeKey = (v: string) => v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)

/** Usulan key dari nama: inisial bila ≥2 kata ("Toko Online Web" → TOW), selain itu 6 huruf pertama. */
function suggestKey(name: string): string {
  const words = name
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
  if (!words.length) return ''
  const raw = words.length >= 2 ? words.map((w) => w[0]).join('') : words[0].slice(0, 6)
  return normalizeKey(raw.replace(/^[0-9]+/, ''))
}

function keyProblem(key: string, strict: boolean): string | undefined {
  if (!key) return strict ? 'Isi key project' : undefined
  if (!/^[A-Z]/.test(key)) return 'Key harus diawali huruf'
  if (key.length < 2) return strict ? 'Minimal 2 karakter' : undefined
  return KEY_RE.test(key) ? undefined : 'Hanya huruf besar dan angka, 2–10 karakter'
}

export function CreateProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [formKey, setFormKey] = React.useState(0)
  const close = () => {
    onOpenChange(false)
    setTimeout(() => setFormKey((k) => k + 1), 160)
  }
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent className="max-w-md">
        <CreateProjectForm key={formKey} onCancel={close} onCreated={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function CreateProjectForm({ onCancel, onCreated }: { onCancel: () => void; onCreated: () => void }) {
  const navigate = useNavigate()
  const create = useCreateProject()
  const [name, setName] = React.useState('')
  const [key, setKey] = React.useState('')
  const [keyEdited, setKeyEdited] = React.useState(false)
  const [keyBlurred, setKeyBlurred] = React.useState(false)
  const [description, setDescription] = React.useState('')
  const [errors, setErrors] = React.useState<FieldErrors>({})
  const [banner, setBanner] = React.useState<string | null>(null)

  const order: [string, string][] = [
    ['name', 'project-name'],
    ['key', 'project-key'],
    ['description', 'project-description'],
  ]
  // Validasi key live; pesan "terlalu pendek/kosong" baru muncul setelah field ditinggalkan.
  const keyError = errors.key ?? keyProblem(key, keyBlurred)
  const keyOk = KEY_RE.test(key)

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const v: FieldErrors = {
      name: name.trim() ? undefined : 'Isi nama project',
      key: keyProblem(key, true),
    }
    setErrors(v)
    setKeyBlurred(true)
    setBanner(null)
    if (v.name || v.key) return focusFirstError(v, order)
    create.mutate(
      { name: name.trim(), key, description: description.trim() || undefined },
      {
        onSuccess: (p) => {
          toast.success(`Project ${p.key} dibuat`)
          onCreated()
          navigate({ to: '/p/$key', params: { key: p.key } })
        },
        onError: (err) => {
          const fe = apiFieldErrors(err)
          if (fe.name || fe.key || fe.description) {
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
        <DialogTitle>Buat project</DialogTitle>
        <DialogDescription>Kamu otomatis jadi maintainer. Environment &ldquo;staging&rdquo; dibuat sebagai default.</DialogDescription>
      </DialogHeader>
      {banner && <Banner>{banner}</Banner>}

      <Field id="project-name" label="Nama" error={errors.name}>
        <Input
          id="project-name"
          autoFocus
          autoComplete="off"
          maxLength={80}
          value={name}
          onChange={(e) => {
            const v = e.target.value
            setName(v)
            if (!keyEdited) setKey(suggestKey(v))
            if (errors.name) setErrors((x) => ({ ...x, name: undefined }))
          }}
          aria-invalid={!!errors.name || undefined}
          aria-describedby={describedBy('project-name', { error: errors.name })}
        />
      </Field>

      <Field
        id="project-key"
        label="Key"
        error={keyError}
        hint={
          keyOk ? (
            <>
              Jadi awalan semua ID, mis. <span className="font-mono text-foreground">{key}-T1</span> dan{' '}
              <span className="font-mono text-foreground">{key}-R1</span>. Tidak bisa diubah setelah dibuat.
            </>
          ) : (
            '2–10 karakter huruf besar atau angka, diawali huruf.'
          )
        }
      >
        <Input
          id="project-key"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          maxLength={10}
          className="max-w-40 font-mono uppercase"
          value={key}
          onChange={(e) => {
            setKey(normalizeKey(e.target.value))
            setKeyEdited(true)
            if (errors.key) setErrors((x) => ({ ...x, key: undefined }))
          }}
          onBlur={() => setKeyBlurred(true)}
          aria-invalid={!!keyError || undefined}
          aria-describedby={describedBy('project-key', { error: keyError, hint: true })}
        />
      </Field>

      <Field id="project-description" label="Deskripsi" aside={<span className="text-xs text-muted-foreground">Opsional</span>} error={errors.description}>
        <Textarea
          id="project-description"
          rows={2}
          maxLength={200}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          aria-invalid={!!errors.description || undefined}
          aria-describedby={describedBy('project-description', { error: errors.description })}
        />
      </Field>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={create.isPending}>
          Batal
        </Button>
        <Button type="submit" loading={create.isPending}>
          Buat project
        </Button>
      </DialogFooter>
    </form>
  )
}
