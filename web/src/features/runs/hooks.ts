import * as React from 'react'

const RM_QUERY = '(prefers-reduced-motion: reduce)'

function subscribeRM(cb: () => void) {
  const mq = window.matchMedia(RM_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}

export function usePrefersReducedMotion(): boolean {
  return React.useSyncExternalStore(
    subscribeRM,
    () => window.matchMedia(RM_QUERY).matches,
    () => false,
  )
}

/** Waktu sekarang yang ber-tick selama `active`. */
export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [active, intervalMs])
  return now
}

/** True setelah `flag` bertahan `delay` ms — mencegah skeleton berkedip. */
export function useDelayedFlag(flag: boolean, delay = 150): boolean {
  const [on, setOn] = React.useState(false)
  React.useEffect(() => {
    if (!flag) {
      setOn(false)
      return
    }
    const t = setTimeout(() => setOn(true), delay)
    return () => clearTimeout(t)
  }, [flag, delay])
  return on
}

export function scrollToElement(el: Element | null, reduced: boolean) {
  el?.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' })
}
