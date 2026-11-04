// Text decoding for http_request `save_regex` (`regex_decode`): raw emails from Mailpit/MailHog
// are often quoted-printable and HTML-escaped, which breaks naive patterns (`=3D`, soft line
// breaks, `&amp;`).

import { StepFailure } from './errors.js'

export type RegexDecode = 'none' | 'quoted_printable' | 'html' | 'auto'
export const REGEX_DECODE_VALUES: readonly RegexDecode[] = ['none', 'quoted_printable', 'html', 'auto']

export function regexDecodeMode(v: unknown): RegexDecode {
  if (v === undefined || v === null || v === '') return 'none'
  if (typeof v === 'string' && (REGEX_DECODE_VALUES as readonly string[]).includes(v)) return v as RegexDecode
  throw new StepFailure(`Invalid regex_decode "${String(v)}" (expected ${REGEX_DECODE_VALUES.join(', ')})`)
}

/**
 * Quoted-printable (RFC 2045): drop soft line breaks (`=` at end of line), decode `=XX` bytes and
 * read the result as UTF-8. Malformed `=` sequences are kept literally.
 */
export function decodeQuotedPrintable(text: string): string {
  const unfolded = text.replace(/=[ \t]*\r?\n/g, '')
  const bytes: number[] = []
  for (let i = 0; i < unfolded.length; i++) {
    const ch = unfolded[i]
    if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(unfolded.slice(i + 1, i + 3))) {
      bytes.push(parseInt(unfolded.slice(i + 1, i + 3), 16))
      i += 2
      continue
    }
    const cp = unfolded.codePointAt(i)!
    if (cp > 0xffff) i++ // surrogate pair
    bytes.push(...Buffer.from(String.fromCodePoint(cp), 'utf8'))
  }
  return Buffer.from(bytes).toString('utf8')
}

/** True when the text looks quoted-printable (soft line breaks, `=3D`, or a QP transfer-encoding header). */
export function looksQuotedPrintable(text: string): boolean {
  return /=\r?\n/.test(text) || /=3D/i.test(text) || /content-transfer-encoding:\s*quoted-printable/i.test(text)
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '–',
  mdash: '—',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  laquo: '«',
  raquo: '»',
  middot: '·',
  bull: '•',
  euro: '€',
  zwnj: '‌',
  zwj: '‍',
  shy: '­',
}

/** Decode HTML character references: named (common set), `&#123;` and `&#x7B;`. Unknown ones are kept. */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#\d{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref: string) => {
    if (ref[0] === '#') {
      const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
      return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : whole
    }
    return NAMED_ENTITIES[ref] ?? NAMED_ENTITIES[ref.toLowerCase()] ?? whole
  })
}

/** All string values of a JSON document in document order (keys excluded), one per line. */
function jsonStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) jsonStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) jsonStrings(v, out)
  return out
}

/**
 * The text `save_regex` patterns run against.
 *  - `none`: the response body exactly as received.
 *  - otherwise, a JSON body is first reduced to its string values (JSON-unescaped, one per line) —
 *    mail APIs return the message inside JSON, where `&`, `\n` and `\"` escapes get in the way —
 *    and then decoded: `quoted_printable` always, `html` always, `auto` = quoted-printable when the
 *    text looks quoted-printable, then HTML entities.
 */
export function textForRegex(body: string, json: unknown, isJson: boolean, mode: RegexDecode): string {
  if (mode === 'none') return body
  let text = isJson ? jsonStrings(json).join('\n') : body
  if (mode === 'quoted_printable' || (mode === 'auto' && looksQuotedPrintable(text))) text = decodeQuotedPrintable(text)
  if (mode === 'html' || mode === 'auto') text = decodeHtmlEntities(text)
  return text
}
