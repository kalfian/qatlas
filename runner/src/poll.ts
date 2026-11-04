import { CancelledError } from './errors.js'

/** Sleep that rejects with CancelledError as soon as the signal aborts. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new CancelledError())
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CancelledError())
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

const INTERVALS = [0, 100, 250, 500, 1000]

export interface PollResult<T> {
  ok: boolean
  /** Last probed value (undefined if every probe threw). */
  value: T | undefined
  /** Last probe error, if the last probe threw. */
  error: unknown
}

/**
 * Re-evaluate `probe` until `check` passes or `timeoutMs` elapses (Playwright's expect intervals:
 * 0, 100, 250, 500, then every 1000 ms). Probe errors (e.g. navigation in progress) count as
 * "not yet"; the last one is returned so the caller can report it. At least one probe always runs.
 */
export async function pollUntil<T>(
  probe: () => Promise<T>,
  check: (v: T) => boolean,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PollResult<T>> {
  const deadline = Date.now() + timeoutMs
  let value: T | undefined
  let error: unknown
  for (let i = 0; ; i++) {
    if (signal.aborted) throw new CancelledError()
    try {
      value = await probe()
      error = undefined
      if (check(value)) return { ok: true, value, error }
    } catch (e) {
      if (signal.aborted) throw new CancelledError()
      error = e
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) return { ok: false, value, error }
    await sleep(Math.min(INTERVALS[Math.min(i + 1, INTERVALS.length - 1)], remaining), signal)
  }
}

/** Race a promise against cancellation; the losing promise's rejection is swallowed. */
export function withCancel<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  p.catch(() => {})
  if (signal.aborted) return Promise.reject(new CancelledError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new CancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(
      (v) => {
        signal.removeEventListener('abort', onAbort)
        resolve(v)
      },
      (e) => {
        signal.removeEventListener('abort', onAbort)
        reject(e)
      },
    )
  })
}
