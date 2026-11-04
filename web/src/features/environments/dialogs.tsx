import { Eye, EyeOff } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useEnvironmentMutations } from '@/api/queries'
import type { Environment } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { fieldErrorsOf, invalidProps } from '@/features/settings/shared'

export const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/

export function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null
  return (
    <p id={`${id}-error`} className="text-xs text-destructive">
      {message}
    </p>
  )
}

export function FormAlert({ error }: { error: unknown }) {
  if (!error) return null
  return (
    <div role="alert" className="rounded-md border border-status-failed/40 bg-status-failed-bg px-3 py-2 text-sm text-status-failed">
      {errorMessage(error)}
    </div>
  )
}

/* ------------------------------------------------------------------ create / rename */

export function EnvironmentNameDialog({
  projectKey,
  open,
  onOpenChange,
  env,
  existing,
  onCreated,
}: {
  projectKey: string
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Ada = mode ganti nama. */
  env?: Environment
  existing: Environment[]
  onCreated?: (env: Environment) => void
}) {
  const { create, update } = useEnvironmentMutations(projectKey)
  const mutation = env ? update : create
  const [name, setName] = React.useState('')
  const [makeDefault, setMakeDefault] = React.useState(false)
  const [touched, setTouched] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setName(env?.name ?? '')
    setMakeDefault(false)
    setTouched(false)
    create.reset()
    update.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, env?.id])

  const trimmed = name.trim()
  const clash = existing.some((e) => e.name.toLowerCase() === trimmed.toLowerCase() && e.id !== env?.id)
  const clientError = !trimmed ? 'Nama wajib diisi' : trimmed.length > 40 ? 'Maksimal 40 karakter' : clash ? 'Nama ini sudah dipakai environment lain' : undefined
  const serverErrors = fieldErrorsOf(mutation.error)
  const error = (touched ? clientError : undefined) ?? serverErrors.name

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (clientError) {
      inputRef.current?.focus()
      return
    }
    if (env) {
      if (trimmed === env.name) return onOpenChange(false)
      update.mutate(
        { id: env.id, name: trimmed },
        {
          onSuccess: () => {
            toast.success(`Environment diganti nama jadi ${trimmed}`)
            onOpenChange(false)
          },
        },
      )
    } else {
      create.mutate(
        { name: trimmed, is_default: makeDefault, variables: {} },
        {
          onSuccess: (created) => {
            toast.success(`Environment ${created.name} dibuat`)
            onCreated?.(created)
            onOpenChange(false)
          },
        },
      )
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{env ? 'Ganti nama environment' : 'Buat environment'}</DialogTitle>
            <DialogDescription>
              {env ? 'Run lama tetap menampilkan nama sebelumnya.' : 'Misalnya staging, production, atau qa. Variable dan secret diisi setelah dibuat.'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="env-name">Nama</Label>
            <Input
              ref={inputRef}
              {...invalidProps('env-name', error)}
              value={name}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => trimmed && setTouched(true)}
              className="font-mono"
              placeholder="staging"
            />
            <FieldError id="env-name" message={error} />
          </div>
          {!env && (
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={makeDefault} onCheckedChange={(v) => setMakeDefault(v === true)} />
              Jadikan default untuk run baru
            </label>
          )}
          {mutation.isError && !serverErrors.name && <FormAlert error={mutation.error} />}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button type="submit" loading={mutation.isPending}>
              {env ? 'Simpan nama' : 'Buat environment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ delete environment */

export function DeleteEnvironmentDialog({
  projectKey,
  env,
  open,
  onOpenChange,
  onDeleted,
}: {
  projectKey: string
  env: Environment
  open: boolean
  onOpenChange: (o: boolean) => void
  onDeleted: () => void
}) {
  const { remove } = useEnvironmentMutations(projectKey)
  const [typed, setTyped] = React.useState('')
  const needsTyping = env.secrets.length > 0
  const ok = !needsTyping || typed === env.name
  const varCount = Object.keys(env.variables).length

  React.useEffect(() => {
    if (open) {
      setTyped('')
      remove.reset()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const confirm = () => {
    if (!ok) return
    remove.mutate(env.id, {
      onSuccess: () => {
        toast.success(`Environment ${env.name} dihapus`)
        onOpenChange(false)
        onDeleted()
      },
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={(o) => !remove.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Hapus environment {env.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            {varCount} variable dan {env.secrets.length} secret akan dihapus permanen. Run lama tetap tersimpan, tapi run baru tidak bisa memakai environment ini.
            {env.is_default && ' Environment lain akan otomatis jadi default.'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {needsTyping && (
          <div className="grid gap-1.5">
            <Label htmlFor="env-delete-confirm">
              Ketik <span className="font-mono font-semibold">{env.name}</span> untuk konfirmasi
            </Label>
            <Input
              id="env-delete-confirm"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </div>
        )}
        {remove.isError && <FormAlert error={remove.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={remove.isPending}>Batal</AlertDialogCancel>
          <Button variant="destructive" onClick={confirm} disabled={!ok} loading={remove.isPending}>
            Hapus environment
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/* ------------------------------------------------------------------ secrets */

export function SecretDialog({
  projectKey,
  env,
  name: fixedName,
  open,
  onOpenChange,
}: {
  projectKey: string
  env: Environment
  /** Ada = ganti/isi nilai secret ini; kosong = secret baru. */
  name?: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { setSecret } = useEnvironmentMutations(projectKey)
  const [name, setName] = React.useState('')
  const [value, setValue] = React.useState('')
  const [reveal, setReveal] = React.useState(false)
  const [touched, setTouched] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement>(null)
  const valueRef = React.useRef<HTMLInputElement>(null)
  const isNew = !fixedName
  const exists = !!fixedName && env.secrets.some((s) => s.name === fixedName)

  React.useEffect(() => {
    if (!open) {
      // nilai tidak boleh tertinggal di memori komponen setelah dialog ditutup
      setValue('')
      return
    }
    setName(fixedName ?? '')
    setValue('')
    setReveal(false)
    setTouched(false)
    setSecret.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fixedName])

  const finalName = isNew ? name : fixedName!
  const nameError = !isNew
    ? undefined
    : !name
      ? 'Nama wajib diisi'
      : !SECRET_NAME_RE.test(name)
        ? 'Gunakan UPPER_SNAKE_CASE, diawali huruf (mis. QA_PASSWORD)'
        : env.secrets.some((s) => s.name === name)
          ? 'Secret ini sudah ada. Pakai "Ganti nilai" di daftar.'
          : undefined
  const valueError = !value ? 'Nilai wajib diisi' : undefined
  const server = fieldErrorsOf(setSecret.error)
  const shownName = (touched ? nameError : name && nameError !== 'Nama wajib diisi' ? nameError : undefined) ?? server.name
  const shownValue = (touched ? valueError : undefined) ?? server.value

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    setTouched(true)
    if (nameError) return nameRef.current?.focus()
    if (valueError) return valueRef.current?.focus()
    setSecret.mutate(
      { id: env.id, name: finalName, value },
      {
        onSuccess: () => {
          toast.success(`Secret ${finalName} tersimpan di ${env.name}`)
          onOpenChange(false)
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4" noValidate autoComplete="off">
          <DialogHeader>
            <DialogTitle>
              {isNew ? 'Tambah secret' : exists ? 'Ganti nilai secret' : 'Isi nilai secret'}
              {!isNew && <span className="ml-1.5 font-mono text-base font-medium">{fixedName}</span>}
            </DialogTitle>
            <DialogDescription>
              Environment <span className="font-medium text-foreground">{env.name}</span>. Nilai secret tidak bisa dilihat lagi setelah disimpan.
            </DialogDescription>
          </DialogHeader>

          {isNew && (
            <div className="grid gap-1.5">
              <Label htmlFor="secret-name">Nama</Label>
              <Input
                ref={nameRef}
                {...invalidProps('secret-name', shownName, 'secret-name-hint')}
                value={name}
                onChange={(e) => setName(e.target.value.toUpperCase().replace(/[\s-]+/g, '_'))}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder="QA_PASSWORD"
              />
              {shownName ? (
                <FieldError id="secret-name" message={shownName} />
              ) : (
                <p id="secret-name-hint" className="text-xs text-muted-foreground">
                  Dipakai di step sebagai <code className="font-mono">{`{{secret.${name || 'NAMA'}}}`}</code>
                </p>
              )}
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="secret-value">Nilai</Label>
            <div className="relative">
              <Input
                ref={valueRef}
                {...invalidProps('secret-value', shownValue)}
                type={reveal ? 'text' : 'password'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                autoComplete="new-password"
                spellCheck={false}
                autoFocus={!isNew}
                className="pr-9 font-mono"
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                aria-pressed={reveal}
                aria-label={reveal ? 'Sembunyikan nilai yang sedang diketik' : 'Tampilkan nilai yang sedang diketik'}
                className="absolute top-1/2 right-1 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
            </div>
            <FieldError id="secret-value" message={shownValue} />
            {exists && !shownValue && <p className="text-xs text-muted-foreground">Nilai lama langsung diganti saat kamu menyimpan.</p>}
          </div>

          {setSecret.isError && !server.name && !server.value && <FormAlert error={setSecret.error} />}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Batal
            </Button>
            <Button type="submit" loading={setSecret.isPending}>
              Simpan secret
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function DeleteSecretDialog({
  projectKey,
  env,
  name,
  open,
  onOpenChange,
}: {
  projectKey: string
  env: Environment
  name: string
  open: boolean
  onOpenChange: (o: boolean) => void
}) {
  const { deleteSecret } = useEnvironmentMutations(projectKey)
  React.useEffect(() => {
    if (open) deleteSecret.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
  return (
    <AlertDialog open={open} onOpenChange={(o) => !deleteSecret.isPending && onOpenChange(o)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Hapus secret <span className="font-mono">{name}</span>?
          </AlertDialogTitle>
          <AlertDialogDescription>
            Step yang memakai <code className="font-mono">{`{{secret.${name}}}`}</code> akan gagal saat dijalankan di environment {env.name}. Nilainya tidak bisa
            dipulihkan.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {deleteSecret.isError && <FormAlert error={deleteSecret.error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleteSecret.isPending}>Batal</AlertDialogCancel>
          <Button
            variant="destructive"
            loading={deleteSecret.isPending}
            onClick={() =>
              deleteSecret.mutate(
                { id: env.id, name },
                {
                  onSuccess: () => {
                    toast.success(`Secret ${name} dihapus dari ${env.name}`)
                    onOpenChange(false)
                  },
                },
              )
            }
          >
            Hapus secret
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
