import { StepFailure } from './errors.js'

export type MatchMode = 'equals' | 'contains' | 'regex'

export function matchMode(v: unknown): MatchMode {
  if (v === undefined || v === null || v === '') return 'contains' // UI default (web/src/lib/steps.ts newStep)
  if (v === 'equals' || v === 'contains' || v === 'regex') return v
  throw new StepFailure(`Invalid match "${String(v)}" (expected equals, contains or regex)`)
}

/** Accepts "pattern" or "/pattern/flags". */
export function toRegExp(pattern: string): RegExp {
  const lit = /^\/([\s\S]+)\/([dgimsuvy]*)$/.exec(pattern)
  try {
    return lit ? new RegExp(lit[1], lit[2]) : new RegExp(pattern)
  } catch (e) {
    throw new StepFailure(`Invalid regex "${pattern}": ${(e as Error).message}`)
  }
}

/** Collapse whitespace (incl. NBSP) and trim — the same normalisation Playwright's toHaveText uses. */
export const normalizeWs = (s: string) => s.replace(/[\s\u00a0]+/g, ' ').trim()

export function matches(actual: string, expected: string, mode: MatchMode): boolean {
  if (mode === 'equals') return actual === expected
  if (mode === 'contains') return actual.includes(expected)
  return toRegExp(expected).test(actual)
}

/** "to equal \"x\"" / "to contain \"x\"" / "to match /x/". */
export function matchPhrase(expected: string, mode: MatchMode): string {
  if (mode === 'equals') return `to equal ${JSON.stringify(expected)}`
  if (mode === 'contains') return `to contain ${JSON.stringify(expected)}`
  return `to match ${toRegExp(expected).toString()}`
}
