import { useNavigate } from '@tanstack/react-router'
import { ChevronRight, Play, Star } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { errorMessage } from '@/api/client'
import { useCreateRun, useEnvironments, useMembers, useProject } from '@/api/queries'
import type { RunOptions } from '@/api/types'
import { useAuth, useCan } from '@/app/auth'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Segmented } from '@/components/ui/segmented'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'

export interface RunTarget {
  kind: 'test_case' | 'flow'
  key: string
  title: string
  /** Test case manual murni → hanya pilih environment + assignee. */
  manualOnly?: boolean
  /** Flow berisi case manual → tampilkan pilihan assignee juga. */
  hasManual?: boolean
}

const VIEWPORTS = {
  desktop: { width: 1280, height: 720 },
  laptop: { width: 1440, height: 900 },
  mobile: { width: 390, height: 844 },
} as const
type ViewportPreset = keyof typeof VIEWPORTS | 'custom'

const storageKey = (projectKey: string) => `qatlas.runOptions.${projectKey}`

function loadLast(projectKey: string): Partial<RunOptions> | null {
  try {
    const raw = localStorage.getItem(storageKey(projectKey))
    return raw ? (JSON.parse(raw) as Partial<RunOptions>) : null
  } catch {
    return null
  }
}

function presetOf(v: { width: number; height: number }): ViewportPreset {
  const hit = (Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).find((k) => VIEWPORTS[k].width === v.width && VIEWPORTS[k].height === v.height)
  return hit ?? 'custom'
}

/**
 * Dialog "Run" (docs/design/ui-direction.md §Run dialog).
 * Submit → navigasi ke halaman run (navigasi itu sendiri = feedback).
 */
export function RunDialog({
  projectKey,
  target,
  open,
  onOpenChange,
  initial,
}: {
  projectKey: string
  target: RunTarget
  open: boolean
  onOpenChange: (o: boolean) => void
  /** Nilai awal opsional (mis. "Ubah opsi & run…" dari halaman run: opsi run sebelumnya). */
  initial?: { options?: Partial<RunOptions>; environmentId?: string | null; assigneeId?: string | null }
}) {
  const me = useAuth()
  const navigate = useNavigate()
  const project = useProject(projectKey)
  const envs = useEnvironments(projectKey)
  const members = useMembers(projectKey)
  const canReassign = useCan('reassign_manual', projectKey)
  const create = useCreateRun(projectKey)
  const { t } = useTranslation(['runs', 'common'])

  const [envId, setEnvId] = React.useState<string>('')
  const [opts, setOpts] = React.useState<RunOptions | null>(null)
  const [preset, setPreset] = React.useState<ViewportPreset>('desktop')
  const [advanced, setAdvanced] = React.useState(false)
  const [assignee, setAssignee] = React.useState(me.user.id)

  // inisialisasi saat dibuka: pilihan terakhir project → default project
  React.useEffect(() => {
    if (!open || !project.data) return
    const base = { ...project.data.default_run_options, ...(loadLast(projectKey) ?? {}), ...(initial?.options ?? {}) }
    setOpts(base)
    setPreset(presetOf(base.viewport))
    setAssignee(initial?.assigneeId ?? me.user.id)
    if (initial?.environmentId) setEnvId(initial.environmentId)
    create.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.data, projectKey])

  React.useEffect(() => {
    if (!open || envId || !envs.data) return
    const def = envs.data.data.find((e) => e.is_default) ?? envs.data.data[0]
    if (def) setEnvId(def.id)
  }, [open, envs.data, envId])

  const set = <K extends keyof RunOptions>(k: K, v: RunOptions[K]) => setOpts((o) => (o ? { ...o, [k]: v } : o))

  const eligibleAssignees = (members.data?.data ?? []).filter((m) => m.role !== 'viewer')
  const showAssignee = (target.manualOnly || target.hasManual) && canReassign

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!opts) return
    try {
      localStorage.setItem(storageKey(projectKey), JSON.stringify(opts))
    } catch {
      // abaikan
    }
    create.mutate(
      {
        ...(target.kind === 'test_case' ? { test_case: target.key } : { flow: target.key }),
        environment_id: envId || null,
        options: target.manualOnly ? undefined : opts,
        assignee_id: showAssignee ? assignee : undefined,
      },
      {
        onSuccess: (run) => {
          onOpenChange(false)
          navigate({ to: '/p/$key/runs/$runKey', params: { key: projectKey, runKey: run.key } })
        },
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{target.kind === 'flow' ? t('dialog.titleFlow') : t('dialog.titleTestCase')}</DialogTitle>
            <DialogDescription>
              <span className="font-mono text-xs">{target.key}</span> · {target.title}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-1.5">
            <Label htmlFor="run-env">{t('dialog.environment')}</Label>
            <Select value={envId} onValueChange={setEnvId}>
              <SelectTrigger id="run-env">
                <SelectValue placeholder={t('dialog.environmentPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {envs.data?.data.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    <span className="inline-flex items-center gap-1.5">
                      {e.name}
                      {e.is_default && <Star className="size-3 text-muted-foreground" aria-label={t('dialog.default')} />}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showAssignee && (
            <div className="grid gap-1.5">
              <Label htmlFor="run-assignee">{t('dialog.assignee')}</Label>
              <Select value={assignee} onValueChange={setAssignee}>
                <SelectTrigger id="run-assignee">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {eligibleAssignees.map((m) => (
                    <SelectItem key={m.user.id} value={m.user.id}>
                      {m.user.name}
                      {m.user.id === me.user.id ? ` ${t('dialog.you')}` : ''}
                    </SelectItem>
                  ))}
                  {!eligibleAssignees.some((m) => m.user.id === me.user.id) && <SelectItem value={me.user.id}>{me.user.name} {t('dialog.you')}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
          )}

          {target.manualOnly ? (
            <p className="text-sm text-muted-foreground">
              <Trans t={t} i18nKey="dialog.manualOnly" components={{ b: <strong className="font-medium text-foreground" /> }} />
            </p>
          ) : (
            opts && (
              <>
                {target.hasManual && (
                  <p className="text-xs text-muted-foreground">{t('dialog.hasManual')}</p>
                )}
                <div className="grid gap-1.5">
                  <Label id="run-browser">{t('dialog.browser')}</Label>
                  <Segmented
                    ariaLabel={t('dialog.browser')}
                    value={opts.browser}
                    onChange={(v) => set('browser', v)}
                    options={[
                      { value: 'chromium', label: 'Chromium' },
                      { value: 'firefox', label: 'Firefox' },
                      { value: 'webkit', label: 'WebKit' },
                    ]}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="run-viewport">{t('dialog.viewport')}</Label>
                  <div className="flex gap-2">
                    <Select
                      value={preset}
                      onValueChange={(v) => {
                        const p = v as ViewportPreset
                        setPreset(p)
                        if (p !== 'custom') set('viewport', { width: VIEWPORTS[p].width, height: VIEWPORTS[p].height })
                      }}
                    >
                      <SelectTrigger id="run-viewport" className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]).map((k) => (
                          <SelectItem key={k} value={k}>
                            {t(`dialog.viewports.${k}`, { width: String(VIEWPORTS[k].width), height: String(VIEWPORTS[k].height) })}
                          </SelectItem>
                        ))}
                        <SelectItem value="custom">{t('dialog.viewports.custom')}</SelectItem>
                      </SelectContent>
                    </Select>
                    {preset === 'custom' && (
                      <>
                        <Input aria-label={t('dialog.width')} type="number" min={320} className="w-20 font-mono" value={opts.viewport.width} onChange={(e) => set('viewport', { ...opts.viewport, width: Number(e.target.value) })} />
                        <Input aria-label={t('dialog.height')} type="number" min={320} className="w-20 font-mono" value={opts.viewport.height} onChange={(e) => set('viewport', { ...opts.viewport, height: Number(e.target.value) })} />
                      </>
                    )}
                  </div>
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('dialog.screenshot')}</Label>
                  <Segmented
                    ariaLabel={t('dialog.screenshot')}
                    value={opts.screenshot}
                    onChange={(v) => set('screenshot', v)}
                    options={[
                      { value: 'off', label: t('labels.screenshot.off') },
                      { value: 'on_failure', label: t('labels.screenshot.on_failure') },
                      { value: 'every_step', label: t('labels.screenshot.every_step') },
                    ]}
                  />
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('dialog.video')}</Label>
                  <Segmented
                    ariaLabel={t('dialog.video')}
                    value={opts.video}
                    onChange={(v) => set('video', v)}
                    options={[
                      { value: 'off', label: t('labels.video.off') },
                      { value: 'on_failure', label: t('labels.video.on_failure') },
                      { value: 'always', label: t('labels.video.always') },
                    ]}
                  />
                  {opts.video === 'on_failure' && <p className="text-xs text-muted-foreground">{t('dialog.videoOnFailureHint')}</p>}
                </div>
                <div className="grid gap-1.5">
                  <Label>{t('dialog.retries')}</Label>
                  <Segmented
                    ariaLabel={t('dialog.retriesShort')}
                    value={String(opts.retries)}
                    onChange={(v) => set('retries', Number(v))}
                    options={[
                      { value: '0', label: '0' },
                      { value: '1', label: '1' },
                      { value: '2', label: '2' },
                    ]}
                    className="w-40"
                  />
                </div>
                <div>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
                    aria-expanded={advanced}
                    onClick={() => setAdvanced((a) => !a)}
                  >
                    <ChevronRight className={advanced ? 'size-4 rotate-90 transition-transform' : 'size-4 transition-transform'} aria-hidden /> {t('dialog.advanced')}
                  </button>
                  {advanced && (
                    <div className="mt-3 grid gap-3">
                      <label className="flex items-center justify-between gap-3 text-sm">
                        {t('dialog.headless')}
                        <Switch checked={opts.headless} onCheckedChange={(v) => set('headless', v)} />
                      </label>
                      <div className="grid gap-1.5">
                        <Label htmlFor="run-timeout">{t('dialog.stepTimeout')}</Label>
                        <Input id="run-timeout" type="number" min={1000} step={1000} className="font-mono" value={opts.step_timeout_ms} onChange={(e) => set('step_timeout_ms', Number(e.target.value))} />
                      </div>
                    </div>
                  )}
                </div>
              </>
            )
          )}

          {create.isError && (
            <div role="alert" className="rounded-md border border-status-failed/40 bg-status-failed-bg px-3 py-2 text-sm text-status-failed">
              {errorMessage(create.error)}
              {create.error && 'details' in create.error && Array.isArray(create.error.details) && create.error.details.length > 0 && (
                <ul className="mt-1 list-disc pl-4 text-xs">
                  {create.error.details.slice(0, 5).map((d, i) => (
                    <li key={i}>
                      <code className="font-mono">{d.path}</code>: {d.message}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t('common:actions.cancel')}
            </Button>
            <Button type="submit" loading={create.isPending} disabled={!opts && !target.manualOnly}>
              <Play /> {target.manualOnly ? t('dialog.startManual') : t('dialog.submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
