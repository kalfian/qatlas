import * as React from 'react'

export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (cb: () => void) => {
      const mql = window.matchMedia(query)
      mql.addEventListener('change', cb)
      return () => mql.removeEventListener('change', cb)
    },
    [query],
  )
  return React.useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}

export function useDebounced<T>(value: T, ms = 200): T {
  const [v, setV] = React.useState(value)
  React.useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

/** true hanya bila `on` bertahan lebih dari `ms` — mencegah skeleton berkedip (§6). */
export function useDelayedFlag(on: boolean, ms = 150): boolean {
  const [shown, setShown] = React.useState(false)
  React.useEffect(() => {
    if (!on) {
      setShown(false)
      return
    }
    const t = setTimeout(() => setShown(true), ms)
    return () => clearTimeout(t)
  }, [on, ms])
  return on && shown
}

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
