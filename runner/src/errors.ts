// Step outcome classification.
//  - StepFailure  → status "failed": assertion mismatch, timeout, target misbehaving, bad step params.
//  - InfraError   → status "error" + runner.error: browser launch/context problems, runner bugs.
//  - Cancelled    → status "skipped": the run was cancelled while the step was running.

export class StepFailure extends Error {
  readonly details: Record<string, unknown> | null
  constructor(message: string, details: Record<string, unknown> | null = null) {
    super(message)
    this.name = 'StepFailure'
    this.details = details
  }
}

export class InfraError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'InfraError'
  }
}

export class CancelledError extends Error {
  constructor() {
    super('Run cancelled')
    this.name = 'CancelledError'
  }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

/**
 * Turn a Playwright error into a one-or-two line human message.
 * Playwright messages look like "locator.click: Timeout 10000ms exceeded.\nCall log:\n  - waiting for …".
 */
export function cleanPlaywrightMessage(err: unknown, subject?: string): string {
  const raw = (err instanceof Error ? err.message : String(err)).replace(ANSI, '')
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean)
  let first = lines[0] ?? 'Unknown error'
  // Drop the "locator.click: " / "page.goto: " API prefix and a nested "Error: "; we describe the subject ourselves.
  first = first.replace(/^[a-zA-Z]+\.[a-zA-Z]+:\s*/, '').replace(/^Error:\s*/, '')
  const logIdx = lines.findIndex((l) => /^Call log:?$/i.test(l))
  const body = lines.slice(1, logIdx >= 0 ? logIdx : undefined)
  // "strict mode violation: … resolved to 2 elements:" is followed by the element list.
  if (first.endsWith(':') && body.length) {
    first = `${first} ${body.slice(0, 3).join('; ')}${body.length > 3 ? '; …' : ''}`
  }
  const callLog = logIdx >= 0 ? lines.slice(logIdx + 1).map((l) => l.replace(/^-\s*/, '')) : []
  const lastWaiting = [...callLog].reverse().find((l) => /^waiting for|^locator resolved|^element is/.test(l))
  let msg = subject ? `${subject}: ${first}` : first
  if (lastWaiting && !msg.includes(lastWaiting)) msg += ` (${lastWaiting})`
  return msg.length > 1500 ? msg.slice(0, 1500) + '…' : msg
}

/** True for errors Playwright raises when its page/context/browser was closed underneath it. */
export function isTargetClosed(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return /Target page, context or browser has been closed|Target closed|has been closed|Browser has been closed|Request context disposed/i.test(msg)
}
