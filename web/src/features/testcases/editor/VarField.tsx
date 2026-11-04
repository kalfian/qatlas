import * as React from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

export interface VarSuggestion {
  /** token tanpa kurung kurawal, mis. `env.BASE_URL` */
  token: string
  ns: 'env' | 'secret' | 'vars' | 'fn'
  hint?: string
}

export const VarSuggestionsContext = React.createContext<VarSuggestion[]>([])

const NS_LABEL: Record<VarSuggestion['ns'], string> = { env: 'env', secret: 'secret', vars: 'vars', fn: 'fn' }

const inputCls =
  'flex w-full min-w-0 rounded-md border border-input bg-background px-2.5 text-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background aria-invalid:border-destructive'

type BaseProps = {
  value: string
  onValueChange: (v: string) => void
  multiline?: boolean
  rows?: number
  mono?: boolean
}

type VarFieldProps = BaseProps &
  Omit<React.InputHTMLAttributes<HTMLInputElement> & React.TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'rows'>

/**
 * Input/textarea dengan autocomplete variable: mengetik `{{` memunculkan daftar env/secret/vars/fn.
 * Pola ARIA: aria-autocomplete="list" + aria-controls + aria-activedescendant (tanpa role combobox di textarea).
 */
export const VarField = React.forwardRef<HTMLInputElement | HTMLTextAreaElement, VarFieldProps>(function VarField(
  { value, onValueChange, multiline, rows = 3, mono, className, onKeyDown, onBlur, id, ...rest },
  forwardedRef,
) {
  const all = React.useContext(VarSuggestionsContext)
  const ref = React.useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const [query, setQuery] = React.useState<{ start: number; text: string } | null>(null)
  const [active, setActive] = React.useState(0)
  const reactId = React.useId()
  const { t } = useTranslation('testcases')
  const listId = `${id ?? reactId}-vars`

  const matches = React.useMemo(() => {
    if (!query) return []
    const q = query.text.toLowerCase()
    return all.filter((s) => s.token.toLowerCase().includes(q)).slice(0, 8)
  }, [all, query])
  const open = matches.length > 0
  const activeIdx = Math.min(active, Math.max(matches.length - 1, 0))

  const setRefs = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    ref.current = el
    if (typeof forwardedRef === 'function') forwardedRef(el)
    else if (forwardedRef) forwardedRef.current = el
  }

  const detect = (el: HTMLInputElement | HTMLTextAreaElement) => {
    const pos = el.selectionStart ?? el.value.length
    const m = /\{\{\s*([\w.]*)$/.exec(el.value.slice(0, pos))
    if (m) setQuery({ start: pos - m[1].length, text: m[1] })
    else setQuery(null)
    setActive(0)
  }

  const accept = (s: VarSuggestion) => {
    const el = ref.current
    if (!el || !query) return
    const pos = el.selectionStart ?? el.value.length
    const after = el.value.slice(pos)
    const closing = /^\s*\}\}/.exec(after)
    const insert = closing ? s.token : `${s.token}}}`
    const next = el.value.slice(0, query.start) + insert + after
    onValueChange(next)
    setQuery(null)
    const caret = query.start + insert.length + (closing ? closing[0].length : 0)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(caret, caret)
    })
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement & HTMLTextAreaElement>) => {
    if (open) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (a + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (a - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        accept(matches[activeIdx])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        setQuery(null)
        return
      }
    }
    onKeyDown?.(e)
  }

  const shared = {
    ...rest,
    id,
    ref: setRefs,
    value,
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open ? `${listId}-${activeIdx}` : undefined,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onValueChange(e.target.value)
      detect(e.target)
    },
    onKeyDown: handleKeyDown,
    onClick: (e: React.MouseEvent<HTMLInputElement | HTMLTextAreaElement>) => detect(e.currentTarget),
    onBlur: (e: React.FocusEvent<HTMLInputElement & HTMLTextAreaElement>) => {
      setQuery(null)
      onBlur?.(e)
    },
    spellCheck: mono ? false : undefined,
    autoComplete: 'off',
  }

  return (
    <div className="relative">
      {multiline ? (
        <textarea
          {...(shared as React.TextareaHTMLAttributes<HTMLTextAreaElement> & { ref: typeof setRefs })}
          rows={rows}
          className={cn(inputCls, 'min-h-16 py-1.5', mono && 'font-mono text-[12px] leading-5', className)}
        />
      ) : (
        <input
          {...(shared as React.InputHTMLAttributes<HTMLInputElement> & { ref: typeof setRefs })}
          type="text"
          className={cn(inputCls, 'h-8', mono && 'font-mono text-[12px]', className)}
        />
      )}
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('varField.listLabel')}
          className="absolute top-full left-0 z-50 mt-1 max-h-56 w-full min-w-56 overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-overlay"
        >
          {matches.map((s, i) => (
            <li
              key={s.token}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === activeIdx}
              onMouseDown={(e) => {
                e.preventDefault()
                accept(s)
              }}
              onMouseEnter={() => setActive(i)}
              className={cn('flex h-8 cursor-default items-center gap-2 rounded-sm px-2 text-sm', i === activeIdx && 'bg-accent text-accent-foreground')}
            >
              <span className="w-12 shrink-0 text-xs text-muted-foreground">{NS_LABEL[s.ns]}</span>
              <span className="truncate font-mono text-[12px]">{`{{${s.token}}}`}</span>
              {s.hint && <span className="ml-auto truncate pl-2 text-xs text-muted-foreground">{s.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})
