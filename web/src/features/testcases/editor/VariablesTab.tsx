import { Variable } from 'lucide-react'
import { EmptyState } from '@/components/page'
import type { Draft } from '../lib'
import { KeyValueEditor } from './KeyValueEditor'

export function VariablesTab({ draft, update, readOnly }: { draft: Draft; update: (fn: (d: Draft) => Draft) => void; readOnly: boolean }) {
  const entries = Object.entries(draft.variables)
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        Dipakai di step sebagai <code className="font-mono text-[12px] text-foreground">{'{{vars.NAMA}}'}</code>. Nilai di sini menimpa variable flow dan
        environment dengan nama sama; hasil <span className="font-mono text-[12px]">save</span> / <span className="font-mono text-[12px]">set_variable</span>{' '}
        saat run menimpa keduanya. Jangan simpan password di sini, pakai secret environment.
      </p>
      {readOnly ? (
        entries.length === 0 ? (
          <EmptyState icon={Variable} title="Belum ada variable" />
        ) : (
          <table className="w-full max-w-2xl border-collapse rounded-md border border-border text-sm">
            <thead>
              <tr className="h-8 border-b border-border">
                <th scope="col" className="px-3 text-left text-xs font-medium text-muted-foreground">
                  Nama
                </th>
                <th scope="col" className="px-3 text-left text-xs font-medium text-muted-foreground">
                  Nilai
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
          keyLabel="Nama"
          valueLabel="Nilai"
          keyPlaceholder="email"
          valuePlaceholder="qa.bot@tokoku.id"
          addLabel="Tambah variable"
          keyPattern={/^[A-Za-z_][A-Za-z0-9_]*$/}
          keyPatternMessage="Nama hanya boleh huruf, angka, dan _ (tidak diawali angka)."
        />
      )}
    </div>
  )
}
