import { useNavigate } from '@tanstack/react-router'
import { Archive } from 'lucide-react'
import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useArchiveProject } from '@/api/queries'
import type { Project } from '@/api/types'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SettingsCard } from './SettingsCard'

export function DangerSection({ project }: { project: Project }) {
  const archive = useArchiveProject(project.key)
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [typed, setTyped] = React.useState('')
  const matches = typed.trim().toUpperCase() === project.key

  const onOpenChange = (o: boolean) => {
    if (archive.isPending) return
    setOpen(o)
    if (o) {
      setTyped('')
      archive.reset()
    }
  }

  const confirm = (e: React.FormEvent) => {
    e.preventDefault()
    if (!matches) return
    archive.mutate(undefined, {
      onSuccess: () => {
        toast.success(`Project ${project.key} diarsipkan`)
        setOpen(false)
        navigate({ to: '/projects' })
      },
    })
  }

  return (
    <SettingsCard id="settings-danger" title="Zona bahaya" tone="danger" description="Aksi di sini berdampak ke semua member project.">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">Arsipkan project</h3>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
            Project hilang dari daftar dan command palette, dan tidak bisa dijalankan lagi. Test case, flow, dan riwayat run tetap tersimpan.
          </p>
        </div>
        <Button
          variant="outline"
          className="shrink-0 border-destructive/60 text-destructive hover:bg-status-failed-bg hover:text-destructive"
          onClick={() => onOpenChange(true)}
        >
          <Archive /> Arsipkan project…
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <form onSubmit={confirm} className="grid gap-4" noValidate>
            <AlertDialogHeader>
              <AlertDialogTitle>Arsipkan project {project.key}?</AlertDialogTitle>
              <AlertDialogDescription>
                {project.name} akan hilang dari daftar project semua member dan run baru tidak bisa dibuat. Data test case, flow, dan run tetap tersimpan.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="archive-confirm">
                Ketik <span className="font-mono font-semibold">{project.key}</span> untuk konfirmasi
              </Label>
              <Input
                id="archive-confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoCapitalize="characters"
                className="font-mono uppercase"
              />
            </div>
            {archive.isError && (
              <p role="alert" className="rounded-md border border-status-failed/40 bg-status-failed-bg px-3 py-2 text-sm text-status-failed">
                {errorMessage(archive.error)}
              </p>
            )}
            <AlertDialogFooter>
              <AlertDialogCancel type="button" disabled={archive.isPending}>
                Batal
              </AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!matches} loading={archive.isPending}>
                Arsipkan {project.key}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
