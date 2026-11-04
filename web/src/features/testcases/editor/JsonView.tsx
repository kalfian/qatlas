import { json } from '@codemirror/lang-json'
import CodeMirror, { EditorView, gutter, GutterMarker, type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { CircleAlert, CircleCheck, TriangleAlert } from 'lucide-react'
import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'
import type { JsonIssue } from '../lib'

class ErrorMarker extends GutterMarker {
  constructor(readonly severity: 'error' | 'warning') {
    super()
  }
  eq(other: ErrorMarker) {
    return other.severity === this.severity
  }
  toDOM() {
    const el = document.createElement('span')
    el.className = this.severity === 'error' ? 'qa-gutter-error' : 'qa-gutter-warning'
    el.textContent = '●'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
}
const ERR = new ErrorMarker('error')
const WARN = new ErrorMarker('warning')

const surfaceTheme = EditorView.theme({
  '&': { backgroundColor: 'var(--background)', color: 'var(--foreground)', fontSize: '12px' },
  '.cm-content': { fontFamily: 'var(--font-mono)', fontVariantLigatures: 'none', caretColor: 'var(--foreground)' },
  '.cm-gutters': { backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)', borderRight: '1px solid var(--border)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklch, var(--accent) 60%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--accent)' },
  '&.cm-focused': { outline: 'none' },
  '.qa-gutter-error': { color: 'var(--destructive)', fontSize: '10px', padding: '0 2px' },
  '.qa-gutter-warning': { color: 'var(--status-blocked)', fontSize: '10px', padding: '0 2px' },
  '.cm-issue-gutter': { width: '14px' },
})

function useIsDark() {
  return React.useSyncExternalStore(
    (cb) => {
      const mo = new MutationObserver(cb)
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
      return () => mo.disconnect()
    },
    () => document.documentElement.classList.contains('dark'),
  )
}

export function JsonView({
  text,
  onTextChange,
  blocking,
  semantic,
  warnings,
  readOnly,
}: {
  text: string
  onTextChange: (t: string) => void
  /** sintaks/struktur: kembali ke Form diblokir */
  blocking: JsonIssue[]
  /** error validasi step (tetap bisa kembali ke Form) */
  semantic: JsonIssue[]
  warnings: JsonIssue[]
  readOnly: boolean
}) {
  const dark = useIsDark()
  const { t } = useTranslation('testcases')
  const editorLabel = t('jsonView.editorLabel')
  const cmRef = React.useRef<ReactCodeMirrorRef>(null)
  const errors = [...blocking, ...semantic]

  const extensions = React.useMemo(() => {
    const errLines = new Set(errors.map((e) => e.line))
    const warnLines = new Set(warnings.map((e) => e.line))
    return [
      json(),
      EditorView.lineWrapping,
      surfaceTheme,
      EditorView.contentAttributes.of({ 'aria-label': editorLabel }),
      gutter({
        class: 'cm-issue-gutter',
        lineMarker(view, line) {
          const n = view.state.doc.lineAt(line.from).number
          return errLines.has(n) ? ERR : warnLines.has(n) ? WARN : null
        },
        lineMarkerChange: () => true,
      }),
    ]
    // errors/warnings dibandingkan per isi agar editor tidak dikonfigurasi ulang tiap render
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(errors.map((e) => e.line)), JSON.stringify(warnings.map((e) => e.line)), editorLabel])

  const jump = (offset: number) => {
    const view = cmRef.current?.view
    if (!view) return
    const pos = Math.min(offset, view.state.doc.length)
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
    view.focus()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className={cn('overflow-hidden rounded-md border', blocking.length ? 'border-destructive' : 'border-border')}>
        <CodeMirror
          ref={cmRef}
          value={text}
          onChange={onTextChange}
          editable={!readOnly}
          readOnly={readOnly}
          theme={dark ? 'dark' : 'light'}
          extensions={extensions}
          minHeight="320px"
          maxHeight="calc(100dvh - 18rem)"
          basicSetup={{ foldGutter: true, highlightActiveLine: !readOnly, autocompletion: false }}
        />
      </div>
      <div aria-live="polite">
        {errors.length === 0 && warnings.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <CircleCheck className="size-3.5 text-status-passed" aria-hidden /> {t('jsonView.valid')}
          </p>
        ) : (
          <section aria-label={t('jsonView.issuesLabel')} className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              {errors.length} {t('editor.errorWord', { count: errors.length })}
              {warnings.length ? ` · ${warnings.length} ${t('editor.warningWord', { count: warnings.length })}` : ''}
              {blocking.length > 0 && ` · ${t('jsonView.fixToReturn')}`}
            </h3>
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {[...errors.map((e) => ({ ...e, sev: 'error' as const })), ...warnings.map((e) => ({ ...e, sev: 'warning' as const }))].map((e, i) => (
                <li key={i}>
                  <button
                    type="button"
                    onClick={() => jump(e.offset)}
                    className="flex min-h-8 w-full items-start gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  >
                    {e.sev === 'error' ? (
                      <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" aria-label={t('jsonView.error')} />
                    ) : (
                      <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-status-blocked" aria-label={t('jsonView.warning')} />
                    )}
                    <span className="w-14 shrink-0 font-mono text-xs leading-5 text-muted-foreground">{t('jsonView.line', { n: String(e.line) })}</span>
                    <span className="w-40 shrink-0 truncate font-mono text-xs leading-5">{e.path || '(root)'}</span>
                    <span className="min-w-0 flex-1">{e.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  )
}
