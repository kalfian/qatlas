// RFC 6238 TOTP for {{fn.totp <ref> [digits=6] [period=30] [algorithm=SHA1|SHA256|SHA512]}}.
// Ranges and messages are mirrored by the editor/back-end validation (web/src/lib/steps.ts, backend/internal/dsl).

import { createHmac } from 'node:crypto'

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpOptions {
  digits: number
  period: number
  algorithm: TotpAlgorithm
}

export const TOTP_DEFAULTS: TotpOptions = { digits: 6, period: 30, algorithm: 'SHA1' }
export const TOTP_DIGITS = { min: 6, max: 8 }
export const TOTP_PERIOD = { min: 10, max: 300 }
/** Fewer seconds than this left in the current period → wait for the next one (avoids expiry races). */
export const TOTP_MIN_REMAINING_S = 3

export const TOTP_OPTIONS_HINT = `digits=${TOTP_DIGITS.min}..${TOTP_DIGITS.max}, period=${TOTP_PERIOD.min}..${TOTP_PERIOD.max}, algorithm=SHA1|SHA256|SHA512`

export class TotpError extends Error {}

/** Parsed `fn.totp` arguments: the seed reference (first argument) and the options. */
export interface TotpArgs {
  ref: string
  options: TotpOptions
}

/** Parse `<ref> [digits=N] [period=N] [algorithm=X]`. Messages never echo the seed. */
export function parseTotpArgs(args: string[]): TotpArgs {
  if (args.length === 0 || args[0].includes('=')) {
    throw new TotpError('needs a seed as its first argument, e.g. {{fn.totp secret.OTP_SEED}}')
  }
  const options: TotpOptions = { ...TOTP_DEFAULTS }
  const seen = new Set<string>()
  for (const a of args.slice(1)) {
    const m = /^(digits|period|algorithm)=(.+)$/i.exec(a)
    if (!m) {
      // Never echo a bare argument: it may be part of a literal seed written with spaces.
      throw new TotpError(
        a.includes('=')
          ? `unknown option "${a.split('=')[0]}" (supported: ${TOTP_OPTIONS_HINT})`
          : `unexpected argument after the seed (options are key=value: ${TOTP_OPTIONS_HINT}; a literal seed must not contain spaces)`,
      )
    }
    const key = m[1].toLowerCase()
    if (seen.has(key)) throw new TotpError(`"${key}" is given twice`)
    seen.add(key)
    if (key === 'algorithm') {
      const alg = m[2].toUpperCase().replace('-', '')
      if (alg !== 'SHA1' && alg !== 'SHA256' && alg !== 'SHA512') throw new TotpError(`invalid algorithm "${m[2]}" (expected SHA1, SHA256 or SHA512)`)
      options.algorithm = alg
    } else {
      const n = /^\d+$/.test(m[2]) ? Number(m[2]) : NaN
      const range = key === 'digits' ? TOTP_DIGITS : TOTP_PERIOD
      if (!Number.isInteger(n) || n < range.min || n > range.max) {
        throw new TotpError(`invalid ${key} "${m[2]}" (expected an integer ${range.min}..${range.max})`)
      }
      if (key === 'digits') options.digits = n
      else options.period = n
    }
  }
  return { ref: args[0], options }
}

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/**
 * Decode an RFC 4648 base32 seed. Tolerates spaces, dashes, lowercase and `=` padding (how
 * authenticator setup pages usually display it). Throws TotpError without echoing the input.
 */
export function decodeBase32(seed: string): Buffer {
  const clean = seed.replace(/[\s-]+/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean) throw new TotpError('the seed is empty')
  const out: number[] = []
  let bits = 0
  let acc = 0
  for (const ch of clean) {
    const v = B32.indexOf(ch)
    if (v < 0) throw new TotpError('the seed is not valid base32 (allowed: A–Z, 2–7)')
    acc = (acc << 5) | v
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((acc >>> bits) & 0xff)
    }
    acc &= (1 << bits) - 1
  }
  if (out.length === 0) throw new TotpError('the seed is too short')
  return Buffer.from(out)
}

/** HOTP (RFC 4226) value for a counter. */
export function hotp(key: Buffer, counter: number, digits: number, algorithm: TotpAlgorithm): string {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac(algorithm.toLowerCase(), key).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(bin % 10 ** digits).padStart(digits, '0')
}

/** TOTP (RFC 6238) code for `key` at `unixMs`. */
export function totpAt(key: Buffer, unixMs: number, opts: TotpOptions): string {
  return hotp(key, Math.floor(unixMs / 1000 / opts.period), opts.digits, opts.algorithm)
}

/** Milliseconds to wait so a code generated now stays valid for at least TOTP_MIN_REMAINING_S. */
export function totpWaitMs(unixMs: number, period: number): number {
  const remainingMs = period * 1000 - (unixMs % (period * 1000))
  return remainingMs < TOTP_MIN_REMAINING_S * 1000 ? remainingMs + 50 : 0
}
