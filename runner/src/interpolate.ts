import { randomBytes, randomInt, randomUUID } from 'node:crypto'
import { StepFailure } from './errors.js'

export interface Scope {
  env: Record<string, string>
  secrets: Record<string, string>
  /** Effective vars: env < run vars < case vars < runtime (already merged by the caller). */
  vars: Record<string, string>
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

function callFn(name: string, args: string[], raw: string): string {
  switch (name) {
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
        return callFn(key, args, raw)
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

/** Interpolate the DSL params of a step (description/expected are human text, left as-is). */
export function interpolateStep<T extends Record<string, unknown>>(step: T, scope: Scope): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(step)) out[k] = NOT_INTERPOLATED.has(k) ? v : interpolateDeep(v, scope)
  return out as T
}
