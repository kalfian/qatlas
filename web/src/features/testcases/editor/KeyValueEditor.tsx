import { Plus, X } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn, uid } from '@/lib/utils'
import { stableStringify } from '../lib'
import { VarField } from './VarField'

interface Row {
  id: string
  key: string
  value: string
}

const toRows = (rec: Record<string, string> | undefined): Row[] => Object.entries(rec ?? {}).map(([key, value]) => ({ id: uid('kv'), key, value }))

function toRecord(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value
  return out
}

/**
 * Editor pasangan key/value (variables, headers, query, save). Baris kosong & duplikat disimpan lokal
 * sampai valid, sehingga mengetik tidak "melompat".
 */
export function KeyValueEditor({
  value,
  onChange,
  idPrefix,
  keyLabel,
  valueLabel,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
  keyPattern,
  keyPatternMessage,
  autoFocusNew = true,
}: {
  value: Record<string, string> | undefined
  onChange: (v: Record<string, string>) => void
  idPrefix: string
  keyLabel?: string
  valueLabel?: string
  keyPlaceholder?: string
  valuePlaceholder?: string
  addLabel?: string
  keyPattern?: RegExp
  keyPatternMessage?: string
  autoFocusNew?: boolean
}) {
  const { t } = useTranslation('testcases')
  keyLabel ??= t('kv.key')
  valueLabel ??= t('kv.value')
  addLabel ??= t('kv.addRow')
  const incoming = stableStringify(value ?? {})
  const [rows, setRows] = React.useState<Row[]>(() => toRows(value))
  const [source, setSource] = React.useState(incoming)
  const [focusId, setFocusId] = React.useState<string | null>(null)
  // Nilai berubah dari luar (JSON, muat ulang, pulihkan revisi) → bangun ulang baris.
  if (incoming !== source) {
    setSource(incoming)
    if (stableStringify(toRecord(rows)) !== incoming) setRows(toRows(value))
  }

  const commit = (next: Row[]) => {
    setRows(next)
    const rec = toRecord(next)
    const s = stableStringify(rec)
    setSource(s)
    if (s !== incoming) onChange(rec)
  }

  const counts = new Map<string, number>()
  for (const r of rows) if (r.key.trim()) counts.set(r.key.trim(), (counts.get(r.key.trim()) ?? 0) + 1)

  return (
    <div className="flex flex-col gap-1.5">
      {rows.length > 0 && (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2rem] gap-x-1.5 text-xs font-medium text-muted-foreground" aria-hidden>
          <span>{keyLabel}</span>
          <span>{valueLabel}</span>
        </div>
      )}
      {rows.map((r, i) => {
        const k = r.key.trim()
        const dup = !!k && (counts.get(k) ?? 0) > 1
        const bad = !!k && keyPattern && !keyPattern.test(k)
        const err = dup ? t('kv.duplicate', { key: k }) : bad ? keyPatternMessage : undefined
        const errId = `${idPrefix}-${r.id}-err`
        return (
          <div key={r.id} className="flex flex-col gap-1">
            <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2rem] items-start gap-x-1.5">
              <Input
                autoFocus={autoFocusNew && focusId === r.id}
                aria-label={t('kv.rowLabel', { label: keyLabel, n: String(i + 1) })}
                aria-invalid={!!err || undefined}
                aria-describedby={err ? errId : undefined}
                value={r.key}
                placeholder={keyPlaceholder}
                spellCheck={false}
                className="font-mono text-[12px]"
                onChange={(e) => commit(rows.map((x) => (x.id === r.id ? { ...x, key: e.target.value } : x)))}
              />
              <VarField
                aria-label={t('kv.rowLabel', { label: valueLabel, n: String(i + 1) })}
                value={r.value}
                mono
                placeholder={valuePlaceholder}
                onValueChange={(v) => commit(rows.map((x) => (x.id === r.id ? { ...x, value: v } : x)))}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={k ? t('kv.removeRowKey', { n: String(i + 1), key: k }) : t('kv.removeRow', { n: String(i + 1) })}
                onClick={() => commit(rows.filter((x) => x.id !== r.id))}
              >
                <X />
              </Button>
            </div>
            {err && (
              <p id={errId} className={cn('text-xs', dup ? 'text-status-blocked' : 'text-destructive')}>
                {err}
              </p>
            )}
          </div>
        )
      })}
      <div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          onClick={() => {
            const row = { id: uid('kv'), key: '', value: '' }
            setRows([...rows, row])
            setFocusId(row.id)
          }}
        >
          <Plus /> {addLabel}
        </Button>
      </div>
    </div>
  )
}
