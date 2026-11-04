import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { FlaskRound, RotateCcw } from 'lucide-react'
import * as React from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { API_BASE } from '@/api/client'
import { qk } from '@/api/queries'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Segmented } from '@/components/ui/segmented'
import { mockDevtools } from '@/mocks/devtools'

/** Toolbar khusus mode mock: ganti user, kecepatan simulasi, reset data. */
export function DevToolbar() {
  const { t } = useTranslation('mock')
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = React.useState(false)
  const [speed, setSpeed] = React.useState(String(mockDevtools.speed()))
  const me = qc.getQueryData<{ user: { id: string } }>(qk.me)

  const switchUser = async (id: string) => {
    const res = await fetch(`${API_BASE}/__mock/switch-user`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user_id: id }) })
    if (!res.ok) return toast.error(t('toolbar.switchFailed'))
    const json = await res.json()
    qc.clear()
    qc.setQueryData(qk.me, json)
    setOpen(false)
    toast.success(t('toolbar.switched', { name: json.user.name }))
    navigate({ to: '/' })
  }

  const reset = async () => {
    await fetch(`${API_BASE}/__mock/reset`, { method: 'POST' })
    qc.clear()
    setOpen(false)
    toast.success(t('toolbar.resetDone'))
    navigate({ to: '/' })
  }

  return (
    <div className="fixed bottom-3 left-3 z-40 lg:left-[15.75rem] print:hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-popover px-2 text-xs font-medium text-muted-foreground shadow-overlay hover:text-foreground"
            aria-label={t('toolbar.trigger')}
          >
            <FlaskRound className="size-3.5" aria-hidden /> {t('toolbar.button')}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 space-y-4 text-sm">
          <div>
            <p className="font-semibold">{t('toolbar.title')}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('toolbar.intro')}{' '}
              <code className="font-mono text-foreground">{mockDevtools.demoPassword}</code>
            </p>
          </div>
          {me && (
            <div className="space-y-1.5">
              <Label>{t('toolbar.signInAs')}</Label>
              <div className="flex flex-col gap-1">
                {mockDevtools.users().map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    onClick={() => switchUser(u.id)}
                    className="flex items-center justify-between rounded-md border border-border px-2 py-1.5 text-left hover:bg-accent aria-pressed:border-foreground"
                    aria-pressed={me.user.id === u.id}
                  >
                    <span>
                      {u.name}
                      <span className="block text-xs text-muted-foreground">{u.email}</span>
                    </span>
                    <span className="text-xs text-muted-foreground">{u.system_role === 'admin' ? 'admin' : u.id === 'u_sari' ? 'viewer@SHOP' : 'editor@SHOP'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t('toolbar.speed')}</Label>
            <Segmented
              ariaLabel={t('toolbar.speedLabel')}
              value={speed}
              onChange={(v) => {
                setSpeed(v)
                mockDevtools.setSpeed(Number(v))
              }}
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '3', label: '3×' },
              ]}
              className="w-full"
            />
          </div>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-medium text-foreground">{t('toolbar.rulesTitle')}</p>
            <ul className="list-disc space-y-0.5 pl-4">
              {(['ruleFail', 'ruleVoucher', 'ruleFlaky'] as const).map((rule) => (
                <li key={rule}>
                  <Trans t={t} i18nKey={`toolbar.${rule}`} components={{ code: <code className="font-mono" /> }} />
                </li>
              ))}
            </ul>
          </div>
          <Button variant="outline" size="sm" onClick={reset} className="w-full">
            <RotateCcw /> {t('toolbar.reset')}
          </Button>
        </PopoverContent>
      </Popover>
    </div>
  )
}
