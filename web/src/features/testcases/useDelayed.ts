import * as React from 'react'

/** True setelah `flag` bertahan `ms` milidetik (skeleton tidak berkedip untuk respons cepat). */
export function useDelayed(flag: boolean, ms = 150): boolean {
  const [late, setLate] = React.useState(false)
  React.useEffect(() => {
    if (!flag) return
    const t = setTimeout(() => setLate(true), ms)
    return () => {
      clearTimeout(t)
      setLate(false)
    }
  }, [flag, ms])
  return flag && late
}
