import { Variable } from 'lucide-react'
import { Trans, useTranslation } from 'react-i18next'
import { EmptyState } from '@/components/page'
import type { Draft } from '../lib'
import { KeyValueEditor } from './KeyValueEditor'

export function VariablesTab({ draft, update, readOnly }: { draft: Draft; update: (fn: (d: Draft) => Draft) => void; readOnly: boolean }) {
  const entries = Object.entries(draft.variables)
  const { t } = useTranslation('testcases')
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        <Trans
          t={t}
          i18nKey="variables.intro"
          values={{ token: `{{vars.${t('variables.tokenName')}}}` }}
          components={{ code: <code className="font-mono text-[12px] text-foreground" />, mono: <span className="font-mono text-[12px]" /> }}
        />
      </p>
      {readOnly ? (
        entries.length === 0 ? (
          <EmptyState icon={Variable} title={t('variables.empty')} />
        ) : (
          <table className="w-full max-w-2xl border-collapse rounded-md border border-border text-sm">
            <thead>
              <tr className="h-8 border-b border-border">
                <th scope="col" className="px-3 text-left text-xs font-medium text-muted-foreground">
                  {t('variables.name')}
                </th>
                <th scope="col" className="px-3 text-left text-xs font-medium text-muted-foreground">
                  {t('variables.value')}
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map(([k, v]) => (
                <tr key={k} className="h-9 border-b border-border last:border-0">
                  <td className="px-3 font-mono text-[12px]">{k}</td>
                  <td className="px-3 font-mono text-[12px] break-all">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      ) : (
        <KeyValueEditor
          idPrefix="tc-vars"
          value={draft.variables}
          onChange={(v) => update((d) => ({ ...d, variables: v }))}
          keyLabel={t('variables.name')}
          valueLabel={t('variables.value')}
          keyPlaceholder="email"
          valuePlaceholder="qa.bot@tokoku.id"
          addLabel={t('panel.kv.addVariable')}
          keyPattern={/^[A-Za-z_][A-Za-z0-9_]*$/}
          keyPatternMessage={t('variables.keyPattern')}
        />
      )}
    </div>
  )
}
