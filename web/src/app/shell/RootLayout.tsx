import { Link, Outlet } from '@tanstack/react-router'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Toaster } from 'sonner'
import { Button } from '@/components/ui/button'
import { TooltipProvider } from '@/components/ui/tooltip'
import { IS_MOCK } from '../config'
import { useTheme } from '../theme'

/*
 * Root route tetap di bundle awal (login & shell sama-sama membutuhkannya), jadi file ini sengaja ringan:
 * AppShell (sidebar, palette, menu) dimuat lazy oleh router, dan dev toolbar hanya di mode mock — di build
 * real, IS_MOCK=false sehingga import dinamis ini (dan seluruh src/mocks) dibuang dari output.
 */
const DevToolbar = IS_MOCK ? React.lazy(() => import('./DevToolbar').then((m) => ({ default: m.DevToolbar }))) : null

export function RootLayout() {
  const { theme } = useTheme()
  const resolved = theme === 'system' ? undefined : theme
  return (
    <TooltipProvider delayDuration={300}>
      <Outlet />
      <Toaster position="bottom-right" theme={resolved ?? 'system'} toastOptions={{ className: 'text-sm' }} closeButton />
      {DevToolbar && (
        <React.Suspense fallback={null}>
          <DevToolbar />
        </React.Suspense>
      )}
    </TooltipProvider>
  )
}

export function NotFoundPage() {
  const { t } = useTranslation('nav')
  return (
    <div className="flex min-h-dvh flex-col items-start justify-center gap-2 px-6 md:px-16">
      <p className="font-mono text-xs text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">{t('notFound.title')}</h1>
      <p className="text-sm text-muted-foreground">{t('notFound.description')}</p>
      <Button asChild variant="outline" className="mt-2">
        <Link to="/">{t('notFound.home')}</Link>
      </Button>
    </div>
  )
}
