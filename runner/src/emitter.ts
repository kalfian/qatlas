import type { OutboundEvent } from './protocol.js'
import { log } from './log.js'

const MASK = '••••'

let stdoutBroken = false
let onBroken: (() => void) | null = null

process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  // EPIPE: the worker went away. Nothing more can be reported; let main shut down.
  if (!stdoutBroken) {
    stdoutBroken = true
    log.error('stdout closed, shutting down', { code: err.code })
    onBroken?.()
  }
})

export function onStdoutBroken(cb: () => void): void {
  onBroken = cb
}

/** Write one event as a single NDJSON line. On Linux pipes, stdout writes are synchronous. */
export function emit(event: OutboundEvent): void {
  if (stdoutBroken) return
  process.stdout.write(JSON.stringify(event) + '\n')
}

/** Replace every secret value in strings (deep). The worker masks too; this is defence in depth. */
export class Masker {
  private values: string[]
  constructor(secrets: Record<string, unknown> | undefined) {
    this.values = Object.values(secrets ?? {})
      .map((v) => (v === null || v === undefined ? '' : String(v)))
      .filter((v) => v.length >= 3)
      .sort((a, b) => b.length - a.length)
  }

  /** Mask a value produced during the run as well (e.g. a generated TOTP code), from now on. */
  add(value: string): void {
    if (value.length < 3 || this.values.includes(value)) return
    this.values = [...this.values, value].sort((a, b) => b.length - a.length)
  }

  str(s: string): string {
    let out = s
    for (const v of this.values) if (out.includes(v)) out = out.split(v).join(MASK)
    return out
  }

  deep<T>(value: T): T {
    if (this.values.length === 0) return value
    if (typeof value === 'string') return this.str(value) as T
    if (Array.isArray(value)) return value.map((v) => this.deep(v)) as T
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = this.deep(v)
      return out as T
    }
    return value
  }
}
