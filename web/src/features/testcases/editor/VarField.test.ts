import { describe, expect, it } from 'vitest'
import { withFnHelpers, type VarSuggestion } from './VarField'

describe('withFnHelpers', () => {
  const t = (k: string) => k
  it('menambah fn.totp untuk tiap secret + token parsial, tanpa duplikat', () => {
    const base: VarSuggestion[] = [
      { token: 'env.BASE_URL', ns: 'env' },
      { token: 'secret.OTP_SEED', ns: 'secret' },
      { token: 'fn.uuid', ns: 'fn', hint: 'from context' },
    ]
    const out = withFnHelpers(base, t)
    const tokens = out.map((s) => s.token)
    expect(new Set(tokens).size).toBe(tokens.length)
    expect(out.find((s) => s.token === 'fn.uuid')?.hint).toBe('from context')
    expect(tokens).toEqual(expect.arrayContaining(['fn.now', 'fn.random_email', 'fn.random_int 1 100', 'fn.totp secret.', 'fn.totp secret.OTP_SEED']))
    expect(out.find((s) => s.token === 'fn.totp secret.')?.partial).toBe(true)
    expect(out.find((s) => s.token === 'fn.totp secret.OTP_SEED')?.partial).toBeUndefined()
  })
})
