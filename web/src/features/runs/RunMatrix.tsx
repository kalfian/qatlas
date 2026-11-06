import * as React from 'react'
import { useTranslation } from 'react-i18next'
import type { Run, RunCase } from '@/api/types'
import { DeviceIcon } from '@/components/devices'
import { KeyBadge } from '@/components/misc'
import { STATUS_META, StatusBadge } from '@/components/status'
import { categoryLabel, deviceLabel, sizeLabel } from '@/lib/devices'
import { formatDuration } from '@/lib/format'
import { cn } from '@/lib/utils'
import { caseDisplayStatus, casesByDevice, matrixRows, runDevices } from './runUtils'

/**
 * Matrix of a multi-device run (docs/14): rows = cases in flow order, columns = devices in run order,
 * cells = case status on that device. A real <table> (row/column headers announced by screen readers);
 * the first column sticks while the device columns scroll horizontally on narrow screens.
 */
export function RunMatrix({ run, onOpenCase }: { run: Run; onOpenCase: (caseId: string) => void }) {
  const { t } = useTranslation(['runs', 'status', 'devices'])
  const devices = runDevices(run)
  const rows = matrixRows(run)
  const byDevice = casesByDevice(run)
  const captionId = React.useId()

  return (
    <div className="grid gap-2">
      <p className="text-xs text-muted-foreground">{t('matrix.hint')}</p>
      {/* focusable region so keyboard users can scroll it (axe: scrollable-region-focusable) */}
      <div
        role="region"
        aria-labelledby={captionId}
        tabIndex={0}
        className="overflow-x-auto rounded-md border border-border bg-card focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <table className="w-full border-separate border-spacing-0 text-sm">
          <caption id={captionId} className="sr-only">
            {t('matrix.caption')}
          </caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 h-12 border-r border-b border-border bg-card px-3 text-left align-bottom text-xs font-medium text-muted-foreground"
              >
                <span className="block pb-2">{t('matrix.testCase')}</span>
              </th>
              {devices.map((d, i) => (
                <th key={i} scope="col" className="h-12 min-w-32 border-b border-border px-3 text-left align-bottom font-normal">
                  <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <DeviceIcon category={d.category} className="text-muted-foreground" />
                    <span className="truncate">{d.label === sizeLabel(d) ? categoryLabel(d.category) : d.label}</span>
                  </span>
                  <span className="block pb-1.5 font-mono text-[11px] text-muted-foreground tabular">{sizeLabel(d)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, k) => {
              const first = row.find((c): c is RunCase => !!c)
              return (
                <tr key={k} className="group">
                  <th
                    scope="row"
                    className="sticky left-0 z-10 h-10 max-w-[11rem] border-r border-b border-border bg-card px-3 text-left font-normal group-last:border-b-0 sm:max-w-[20rem]"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="w-4 shrink-0 text-right text-xs text-muted-foreground tabular">{k + 1}</span>
                      {first && <KeyBadge className="shrink-0">{first.test_case_key}</KeyBadge>}
                      <span className="min-w-0 truncate max-sm:sr-only" title={first?.title}>
                        {first?.title}
                      </span>
                    </span>
                  </th>
                  {row.map((c, di) => (
                    <td key={di} className="h-10 border-b border-border p-0 group-last:border-b-0">
                      {c ? <MatrixCell run={run} c={c} deviceName={deviceLabel(devices[di])} onOpen={() => onOpenCase(c.id)} /> : <span className="px-3 text-muted-foreground">—</span>}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row" className="sticky left-0 z-10 h-9 border-t border-r border-border bg-muted/60 px-3 text-left text-xs font-medium text-muted-foreground">
                {t('matrix.total')}
              </th>
              {byDevice.map((list, di) => {
                const passed = list.filter((c) => c.status === 'passed').length
                const failed = list.filter((c) => c.status === 'failed' || c.status === 'error').length
                return (
                  <td key={di} className="h-9 border-t border-border bg-muted/60 px-3 text-xs text-muted-foreground tabular">
                    {t('matrix.passedOf', { passed: String(passed), count: list.length })}
                    {failed > 0 && (
                      <>
                        <span aria-hidden> · </span>
                        <span className="font-medium text-status-failed">{t('list.failedCount', { count: failed })}</span>
                      </>
                    )}
                  </td>
                )
              })}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  )
}

function MatrixCell({ run, c, deviceName, onOpen }: { run: Run; c: RunCase; deviceName: string; onOpen: () => void }) {
  const { t } = useTranslation('runs')
  const status = caseDisplayStatus(run, c)
  const duration = c.status === 'running' ? '…' : c.duration_ms != null ? formatDuration(c.duration_ms) : ''
  return (
    <button
      type="button"
      onClick={onOpen}
      data-case-id={c.id}
      aria-label={t('matrix.cellLabel', { key: c.test_case_key, title: c.title, device: deviceName, status: STATUS_META[status].label })}
      className={cn(
        'flex h-10 w-full items-center gap-2 px-3 text-left transition-colors duration-150 hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-sm:h-11',
        (status === 'failed' || status === 'error') && 'bg-status-failed-bg/40 hover:bg-status-failed-bg/70',
      )}
    >
      <StatusBadge status={status} />
      <span className="text-xs text-muted-foreground tabular max-sm:hidden">{duration}</span>
    </button>
  )
}
