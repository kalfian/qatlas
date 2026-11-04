import { useNavigate } from '@tanstack/react-router'
import { Archive } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
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
  const { t } = useTranslation(['settings', 'common'])
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
        toast.success(t('danger.archived', { key: project.key }))
        setOpen(false)
        navigate({ to: '/projects' })
      },
    })
  }

  return (
    <SettingsCard id="settings-danger" title={t('danger.title')} tone="danger" description={t('danger.description')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('danger.archiveTitle')}</h3>
          <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">{t('danger.archiveDescription')}</p>
        </div>
        <Button
          variant="outline"
          className="shrink-0 border-destructive/60 text-destructive hover:bg-status-failed-bg hover:text-destructive"
          onClick={() => onOpenChange(true)}
        >
          <Archive /> {t('danger.archiveButton')}
        </Button>
      </div>

      <AlertDialog open={open} onOpenChange={onOpenChange}>
        <AlertDialogContent>
          <form onSubmit={confirm} className="grid gap-4" noValidate>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('danger.dialogTitle', { key: project.key })}</AlertDialogTitle>
              <AlertDialogDescription>{t('danger.dialogDescription', { name: project.name })}</AlertDialogDescription>
            </AlertDialogHeader>
            <div className="grid gap-1.5">
              <Label htmlFor="archive-confirm">
                <Trans t={t} i18nKey="danger.typeToConfirm" values={{ key: project.key }} components={{ key: <span className="font-mono font-semibold" /> }} />
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
                {t('common:actions.cancel')}
              </AlertDialogCancel>
              <Button type="submit" variant="destructive" disabled={!matches} loading={archive.isPending}>
                {t('danger.confirm', { key: project.key })}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsCard>
  )
}
