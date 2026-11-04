// Unit tests for pure helpers (built dist/): TOTP (RFC 6238 vectors), quoted-printable / HTML decoding,
// fn.totp interpolation. Run: corepack pnpm --filter @qatlas/runner test

import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { decodeHtmlEntities, decodeQuotedPrintable, looksQuotedPrintable, textForRegex } from '../dist/decode.js'
import { interpolateString } from '../dist/interpolate.js'
import { decodeBase32, parseTotpArgs, totpAt, totpWaitMs } from '../dist/totp.js'

/** RFC 4648 base32 (for building seeds in tests). */
function base32(buf) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let acc = 0
  let out = ''
  for (const b of buf) {
    acc = (acc << 8) | b
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += A[(acc >>> bits) & 31]
    }
    acc &= (1 << bits) - 1
  }
  if (bits > 0) out += A[(acc << (5 - bits)) & 31]
  return out
}

// RFC 6238 Appendix B (8 digits, period 30).
const SEEDS = {
  SHA1: Buffer.from('12345678901234567890'),
  SHA256: Buffer.from('12345678901234567890123456789012'),
  SHA512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234'),
}
const VECTORS = [
  [59, { SHA1: '94287082', SHA256: '46119246', SHA512: '90693936' }],
  [1111111109, { SHA1: '07081804', SHA256: '68084774', SHA512: '25091201' }],
  [1111111111, { SHA1: '14050471', SHA256: '67062674', SHA512: '99943326' }],
  [1234567890, { SHA1: '89005924', SHA256: '91819424', SHA512: '93441116' }],
  [2000000000, { SHA1: '69279037', SHA256: '90698825', SHA512: '38618901' }],
  [20000000000, { SHA1: '65353130', SHA256: '77737706', SHA512: '47863826' }],
]

describe('TOTP', () => {
  for (const alg of ['SHA1', 'SHA256', 'SHA512']) {
    test(`RFC 6238 test vectors (${alg})`, () => {
      for (const [t, codes] of VECTORS) {
        assert.equal(totpAt(SEEDS[alg], t * 1000, { digits: 8, period: 30, algorithm: alg }), codes[alg], `T=${t}`)
      }
    })
  }

  test('6-digit codes are the last 6 digits of the 8-digit value', () => {
    assert.equal(totpAt(SEEDS.SHA1, 59_000, { digits: 6, period: 30, algorithm: 'SHA1' }), '287082')
  })

  test('base32 decoding tolerates spaces, dashes, lowercase and padding', () => {
    const b32 = base32(SEEDS.SHA1)
    assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ')
    for (const variant of [b32, b32.toLowerCase(), 'gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 'GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ', `${b32}====`]) {
      assert.deepEqual(decodeBase32(variant), SEEDS.SHA1, variant)
    }
    assert.deepEqual(decodeBase32(base32(SEEDS.SHA512)), SEEDS.SHA512)
  })

  test('invalid seeds throw without echoing the seed', () => {
    for (const bad of ['', '   ', 'not-base32!', 'ABC1DEF8']) {
      assert.throws(() => decodeBase32(bad), (e) => !e.message.includes(bad.trim() || '\u0000'))
    }
  })

  test('argument parsing: defaults, options, errors', () => {
    assert.deepEqual(parseTotpArgs(['secret.OTP']), { ref: 'secret.OTP', options: { digits: 6, period: 30, algorithm: 'SHA1' } })
    assert.deepEqual(parseTotpArgs(['vars.seed', 'digits=8', 'period=60', 'algorithm=sha256']).options, { digits: 8, period: 60, algorithm: 'SHA256' })
    assert.throws(() => parseTotpArgs([]), /needs a seed/)
    assert.throws(() => parseTotpArgs(['digits=6']), /needs a seed/)
    assert.throws(() => parseTotpArgs(['secret.OTP', 'digits=5']), /invalid digits "5"/)
    assert.throws(() => parseTotpArgs(['secret.OTP', 'period=1']), /invalid period/)
    assert.throws(() => parseTotpArgs(['secret.OTP', 'algorithm=MD5']), /invalid algorithm/)
    assert.throws(() => parseTotpArgs(['secret.OTP', 'foo=1']), /unknown option "foo"/)
    assert.throws(() => parseTotpArgs(['JBSW', 'Y3DP']), (e) => /unexpected argument/.test(e.message) && !e.message.includes('Y3DP'))
  })

  test('waits for the next period when fewer than 3 s remain', () => {
    assert.equal(totpWaitMs(0, 30), 0)
    assert.equal(totpWaitMs(26_999, 30), 0)
    assert.equal(totpWaitMs(27_001, 30), 2_999 + 50)
    assert.equal(totpWaitMs(29_999, 30), 1 + 50)
    assert.equal(totpWaitMs(60_000, 30), 0)
  })

  test('{{fn.totp}} interpolation resolves secret/env/vars/literal seeds and reports them as sensitive', () => {
    const seed = base32(SEEDS.SHA1)
    const sensitive = []
    const scope = { env: { OTP_ENV: seed }, secrets: { OTP: seed.toLowerCase() }, vars: { otp_seed: seed.replace(/(.{4})/g, '$1 ') }, sensitive: (v) => sensitive.push(v) }
    const now = Date.now()
    const expected = new Set([totpAt(SEEDS.SHA1, now, { digits: 6, period: 30, algorithm: 'SHA1' }), totpAt(SEEDS.SHA1, now + 5000, { digits: 6, period: 30, algorithm: 'SHA1' })])
    for (const expr of ['{{fn.totp secret.OTP}}', '{{fn.totp env.OTP_ENV}}', '{{ fn.totp vars.otp_seed }}', `{{fn.totp ${seed}}}`]) {
      const code = interpolateString(expr, scope)
      assert.match(code, /^\d{6}$/)
      assert.ok(expected.has(code), `${expr} → ${code}`)
      assert.ok(sensitive.includes(code), 'the generated code is reported as sensitive')
    }
    assert.match(interpolateString('{{fn.totp secret.OTP digits=8 algorithm=SHA512}}', scope), /^\d{8}$/)
  })

  test('{{fn.totp}} errors are step failures that never contain the seed', () => {
    const scope = { env: { BAD: 'hello world 1' }, secrets: {}, vars: {} }
    assert.throws(() => interpolateString('{{fn.totp secret.NOPE}}', scope), { name: 'StepFailure', message: /Unknown secret \{\{secret\.NOPE\}\} in \{\{fn\.totp secret\.NOPE\}\}/ })
    assert.throws(() => interpolateString('{{fn.totp env.BAD}}', scope), (e) => e.name === 'StepFailure' && /Invalid \{\{fn\.totp env\.BAD\}\}: the seed is not valid base32/.test(e.message) && !e.message.includes('hello'))
    assert.throws(() => interpolateString('{{fn.totp MZXW1}}', scope), (e) => e.message === 'Invalid {{fn.totp …}}: the seed is not valid base32 (allowed: A–Z, 2–7)')
    assert.throws(() => interpolateString('{{fn.totp}}', scope), /Invalid \{\{fn\.totp …\}\}: needs a seed/)
  })
})

describe('regex_decode', () => {
  test('quoted-printable: soft line breaks, =XX bytes as UTF-8, malformed kept', () => {
    const qp = '<a href=3D"https://shop.test/verify?token=\r\n=3DabcDEF123&amp;lang=3Den">Verify</a> caf=C3=A9 =\nend =ZZ'
    assert.equal(decodeQuotedPrintable(qp), '<a href="https://shop.test/verify?token=abcDEF123&amp;lang=en">Verify</a> café end =ZZ')
    assert.equal(decodeQuotedPrintable('Kode Anda: =E2=80=9C123456=E2=80=9D'), 'Kode Anda: “123456”')
    assert.equal(decodeQuotedPrintable('emoji 😀 stays'), 'emoji 😀 stays')
  })

  test('HTML entities: named, decimal, hex; unknown kept', () => {
    assert.equal(decodeHtmlEntities('a &amp; b &lt;i&gt; &quot;x&quot; &#39;y&#39; &#x41;&#66; &nbsp;&hellip; &bogus; &amp'), 'a & b <i> "x" \'y\' AB  … &bogus; &amp')
  })

  test('auto decodes quoted-printable only when the text looks like it, then HTML entities', () => {
    assert.ok(looksQuotedPrintable('a=\r\nb'))
    assert.ok(looksQuotedPrintable('href=3D"x"'))
    assert.ok(!looksQuotedPrintable('https://x.test/?a=12&b=CD'))
    assert.equal(textForRegex('https://x.test/?a=12&amp;b=CD', undefined, false, 'auto'), 'https://x.test/?a=12&b=CD')
    assert.equal(textForRegex('token=3D=\nAB12&amp;x', undefined, false, 'auto'), 'token=AB12&x')
    assert.equal(textForRegex('token=3DAB', undefined, false, 'none'), 'token=3DAB')
  })

  test('JSON bodies are searched as their unescaped string values when decoding', () => {
    const json = { items: [{ Content: { Body: 'Your code=3A 123456=\r\n<a href=3D"https://s.test/v?t=3D9&amp;l=3Den">' } }], total: 1 }
    const raw = JSON.stringify(json).replace(/&/g, '\\u0026')
    assert.equal(textForRegex(raw, json, true, 'auto'), 'Your code: 123456<a href="https://s.test/v?t=9&l=en">')
    assert.equal(textForRegex(raw, json, true, 'none'), raw)
  })
})
