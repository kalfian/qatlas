import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Skeleton } from '@/components/ui/skeleton'
import type { JsonView as JsonViewImpl } from './JsonView'
import { useDelayed } from '../useDelayed'

/*
 * CodeMirror (~1 MB sebelum minify) hanya dipakai di mode JSON, jadi JsonView dimuat saat mode itu dibuka
 * pertama kali. Komponen ini hanya mekanisme import; logika ada di ./JsonView.
 */
const Impl = React.lazy(() => import('./JsonView').then((m) => ({ default: m.JsonView })))

/** Bentuk sama dengan editor (border, tinggi minimum 320px) agar layout tidak bergeser saat chunk tiba. */
function JsonViewPending() {
  const { t } = useTranslation()
  const show = useDelayed(true, 150)
  return (
    <div className="flex flex-col gap-3" aria-busy="true">
      <div className="flex min-h-80 flex-col gap-2 rounded-md border border-border p-3">
        {show && (
          <>
            <span role="status" className="sr-only">
              {t('states.loading')}
            </span>
            {[64, 40, 52, 36, 48, 28].map((w, i) => (
              <Skeleton key={i} className="h-3.5" style={{ width: `${w}%` }} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}

export function JsonView(props: React.ComponentProps<typeof JsonViewImpl>) {
  return (
    <React.Suspense fallback={<JsonViewPending />}>
      <Impl {...props} />
    </React.Suspense>
  )
}
