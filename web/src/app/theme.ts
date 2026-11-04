import * as React from 'react'

export type Theme = 'light' | 'dark' | 'system'
const KEY = 'qatlas.theme'

function apply(theme: Theme) {
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export function useTheme() {
  const [theme, setThemeState] = React.useState<Theme>(() => {
    try {
      return (localStorage.getItem(KEY) as Theme) || 'system'
    } catch {
      return 'system'
    }
  })
  React.useEffect(() => {
    apply(theme)
    if (theme !== 'system') return
    const mq = matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => apply('system')
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [theme])
  const setTheme = (t: Theme) => {
    try {
      localStorage.setItem(KEY, t)
    } catch {
      // abaikan
    }
    setThemeState(t)
  }
  return { theme, setTheme }
}
