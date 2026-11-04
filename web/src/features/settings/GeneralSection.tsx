import * as React from 'react'
import { toast } from 'sonner'
import { useUpdateProject } from '@/api/queries'
import type { Project } from '@/api/types'
import { KeyBadge } from '@/components/misc'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { FieldHint, SaveBar, SettingsCard } from './SettingsCard'
import { fieldErrorsOf, invalidProps } from './shared'

const NAME_MAX = 80
const DESC_MAX = 500

export function GeneralSection({ project }: { project: Project }) {
  const update = useUpdateProject(project.key)
  const [name, setName] = React.useState(project.name)
  const [description, setDescription] = React.useState(project.description)
  const [submitted, setSubmitted] = React.useState(false)
  const nameRef = React.useRef<HTMLInputElement>(null)

  const dirty = name.trim() !== project.name || description.trim() !== project.description
  const server = fieldErrorsOf(update.error)
  const nameClientError = !name.trim() ? 'Nama project wajib diisi' : name.trim().length > NAME_MAX ? `Maksimal ${NAME_MAX} karakter` : undefined
  const descClientError = description.length > DESC_MAX ? `Maksimal ${DESC_MAX} karakter` : undefined
  const nameError = (submitted || name.length > NAME_MAX ? nameClientError : undefined) ?? server.name
  const descError = descClientError ?? server.description

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!dirty || update.isPending) return
    setSubmitted(true)
    if (nameClientError) return nameRef.current?.focus()
    if (descClientError) return
    update.mutate(
      { name: name.trim(), description: description.trim() },
      {
        onSuccess: (p) => {
          setName(p.name)
          setDescription(p.description)
          setSubmitted(false)
          toast.success('Info project tersimpan')
        },
      },
    )
  }

  return (
    <form onSubmit={submit} noValidate>
      <SettingsCard
        id="settings-general"
        title="Umum"
        description="Nama dan deskripsi tampil di daftar project dan command palette."
        footer={<SaveBar id="general" dirty={dirty} pending={update.isPending} error={update.isError && !server.name ? update.error : undefined} />}
        bodyClassName="grid gap-4"
      >
        <div className="grid gap-1.5">
          <span className="text-sm font-medium">Key</span>
          <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <KeyBadge>{project.key}</KeyBadge>
            Tidak bisa diubah, karena dipakai di semua key test case, flow, dan run (mis. <span className="font-mono">{project.key}-T12</span>).
          </p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="project-name">Nama project</Label>
          <Input
            ref={nameRef}
            {...invalidProps('project-name', nameError)}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={NAME_MAX + 20}
            autoComplete="off"
          />
          <FieldHint id="project-name" error={nameError} />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="project-desc">Deskripsi</Label>
          <Textarea
            {...invalidProps('project-desc', descError, 'project-desc-hint')}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
            placeholder="Cakupan pengujian project ini, mis. smoke & regression storefront."
          />
          <FieldHint id="project-desc" error={descError}>
            <span className="tabular">
              {description.length}/{DESC_MAX}
            </span>
          </FieldHint>
        </div>
      </SettingsCard>
    </form>
  )
}
