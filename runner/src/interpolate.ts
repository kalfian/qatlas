import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { StepFailure } from './errors.js'
import { sleep } from './poll.js'
import { TotpError, decodeBase32, parseTotpArgs, totpAt, totpWaitMs } from './totp.js'

export interface Scope {
  env: Record<string, string>
  secrets: Record<string, string>
  /** Effective vars: env < run vars < case vars < runtime (already merged by the caller). */
  vars: Record<string, string>
  /**
   * Called with values that must never appear in events (generated TOTP codes and their seeds);
   * the run adds them to its masker.
   */
  sensitive?: (value: string) => void
}

const TOKEN = /\{\{\s*([A-Za-z_][\w]*)\.([\w-]+)((?:\s+[^{}]*?)?)\s*\}\}/g

/** Stringify a variable value: strings as-is, everything else as JSON. */
export function toVarString(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === undefined) return ''
  return JSON.stringify(v)
}

export function stringifyRecord(rec: Record<string, unknown> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(rec ?? {})) out[k] = toVarString(v)
  return out
}

/** `{{fn.totp …}}` as shown in messages: the reference is kept, a literal seed is never echoed. */
function totpLabel(args: string[]): string {
  const ref = args[0] ?? ''
  return /^(secret|env|vars)\.[\w-]+$/.test(ref) ? `{{fn.totp ${ref}}}` : '{{fn.totp …}}'
}

function resolveTotpSeed(ref: string, scope: Scope): string {
  const m = /^(secret|env|vars)\.([\w-]+)$/.exec(ref)
  if (!m) return ref // literal base32 seed
  const [, ns, key] = m
  const bag = ns === 'secret' ? scope.secrets : ns === 'env' ? scope.env : scope.vars
  if (key in bag) return bag[key]
  const what = ns === 'secret' ? `environment has no secret "${key}"` : ns === 'env' ? `environment has no "${key}"` : `no variable "${key}" is defined at this point`
  throw new StepFailure(`Unknown ${ns === 'secret' ? 'secret' : 'variable'} {{${ref}}} in {{fn.totp ${ref}}}: ${what}`)
}

function totp(args: string[], scope: Scope): string {
  const label = totpLabel(args)
  try {
    const { ref, options } = parseTotpArgs(args)
    const seed = resolveTotpSeed(ref, scope)
    const key = decodeBase32(seed)
    const code = totpAt(key, Date.now(), options)
    if (scope.sensitive) {
      scope.sensitive(code)
      scope.sensitive(seed)
      const compact = seed.replace(/[\s-]+/g, '')
      if (compact !== seed) scope.sensitive(compact)
    }
    return code
  } catch (e) {
    if (e instanceof TotpError) throw new StepFailure(`Invalid ${label}: ${e.message}`)
    throw e
  }
}

function callFn(name: string, args: string[], raw: string, scope: Scope): string {
  switch (name) {
    case 'totp':
      return totp(args, scope)
    case 'uuid':
      return randomUUID()
    case 'now':
      return new Date().toISOString()
    case 'random_email':
      return `qa+${randomBytes(5).toString('hex')}@example.com`
    case 'random_int': {
      const min = args.length >= 1 ? Number(args[0]) : 0
      const max = args.length >= 2 ? Number(args[1]) : 99
      if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
        throw new StepFailure(`Invalid arguments in ${raw}: expected "{{fn.random_int <min> <max>}}" with integers`)
      }
      return String(randomInt(min, max + 1))
    }
    default:
      throw new StepFailure(`Unknown function ${raw}`)
  }
}

/**
 * Replace {{env.X}}, {{secret.X}}, {{vars.x}} and {{fn.name args}} in a string.
 * Unknown keys in a known namespace fail the step (a silent "{{vars.x}}" sent to the target is worse).
 * Other {{…}} text is left untouched.
 */
export function interpolateString(text: string, scope: Scope): string {
  return text.replace(TOKEN, (raw, ns: string, key: string, argStr: string) => {
    const args = argStr.trim() ? argStr.trim().split(/\s+/) : []
    switch (ns) {
      case 'env':
        if (key in scope.env) return scope.env[key]
        throw new StepFailure(`Unknown variable ${raw}: environment has no "${key}"`)
      case 'secret':
        if (key in scope.secrets) return scope.secrets[key]
        throw new StepFailure(`Unknown secret ${raw}: environment has no secret "${key}"`)
      case 'vars':
        if (key in scope.vars) return scope.vars[key]
        throw new StepFailure(`Unknown variable ${raw}: no variable "${key}" is defined at this point`)
      case 'fn':
        return callFn(key, args, raw, scope)
      default:
        return raw
    }
  })
}

/** Deep-interpolate every string in a value (objects, arrays). */
export function interpolateDeep<T>(value: T, scope: Scope): T {
  if (typeof value === 'string') return interpolateString(value, scope) as T
  if (Array.isArray(value)) return value.map((v) => interpolateDeep(v, scope)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = interpolateDeep(v, scope)
    return out as T
  }
  return value
}

const NOT_INTERPOLATED = new Set(['step_id', 'id', 'action', 'description', 'expected'])

const FN_TOTP = /\{\{\s*fn\.totp((?:\s+[^{}]*?)?)\s*\}\}/g

/** Every `{{fn.totp …}}` period used in a step (only well-formed ones; bad args fail later with a message). */
function totpPeriods(value: unknown, out: Set<number>): Set<number> {
  if (typeof value === 'string') {
    for (const m of value.matchAll(FN_TOTP)) {
      try {
        out.add(parseTotpArgs(m[1].trim() ? m[1].trim().split(/\s+/) : []).options.period)
      } catch {
        /* reported by interpolation */
      }
    }
  } else if (Array.isArray(value)) value.forEach((v) => totpPeriods(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => totpPeriods(v, out))
  return out
}

/**
 * If the step uses {{fn.totp}} and fewer than 3 s remain in the current TOTP period, wait for the
 * next period so the code is not about to expire when the target checks it.
 */
export async function waitForFreshTotp(step: Record<string, unknown>, signal: AbortSignal): Promise<void> {
  const periods = totpPeriods(Object.entries(step).filter(([k]) => !NOT_INTERPOLATED.has(k)).map(([, v]) => v), new Set())
  for (let i = 0; i < 3 && periods.size; i++) {
    const now = Date.now()
    const wait = Math.max(...[...periods].map((p) => totpWaitMs(now, p)))
    if (wait <= 0) return
    await sleep(wait, signal)
  }
}

/** Interpolate the DSL params of a step (description/expected are human text, left as-is). */
export function interpolateStep<T extends Record<string, unknown>>(step: T, scope: Scope): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step)) out[k] = NOT_INTERPOLATED.has(k) ? v : interpolateDeep(v, scope)
  return out as T
}
