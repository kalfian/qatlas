// Integration tests for http_request save_regex / regex_decode / polling and {{fn.totp}} masking.
// A local HTTP server plays a mail catcher (Mailpit-like JSON API, MailHog-like quoted-printable body).
// Run: corepack pnpm --filter @qatlas/runner test   (builds first)

import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { decodeBase32, totpAt } from '../dist/totp.js'
import { Runner, byType, stepEvents, tempDir } from './helpers.mjs'

const OTP_SEED = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' // base32, used as {{secret.OTP_SEED}}
const MAIL_ID = 'kQhAOTy9opNyam8rIg3WQ'

let server
let base
let runner
let tmp
let seq = 0
/** Per-test mailbox state: counts requests so the server can answer "empty" first, then data. */
const hits = new Map()
const otpSeen = []

function json(res, status, body) {
  // Escape & < > like Go's encoding/json (Mailpit does), so raw-body regexes see \u0026.
  const text = JSON.stringify(body).replace(/&/g, '\\u0026').replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(text)
}

before(async () => {
  tmp = tempDir()
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const key = u.pathname + '?' + (u.searchParams.get('query') ?? u.searchParams.get('k') ?? '')
    const n = (hits.get(key) ?? 0) + 1
    hits.set(key, n)
    // Mailpit-like search: 404 on the first hit, an empty list on the second, the message from the third.
    if (u.pathname === '/api/v1/search') {
      if (n === 1) return json(res, 404, { error: 'not ready' })
      if (n === 2) return json(res, 200, { total: 0, messages: [] })
      return json(res, 200, { total: 1, messages: [{ ID: MAIL_ID, Subject: 'Your verification code', To: [{ Address: u.searchParams.get('query').slice(3) }] }] })
    }
    if (u.pathname === `/api/v1/message/${MAIL_ID}`) {
      return json(res, 200, {
        ID: MAIL_ID,
        Subject: 'Your verification code',
        Text: 'Hi,\nyour code: 482913\nVerify: https://shop.test/verify?token=abcDEF123&lang=en\n',
        HTML: '<p>Your code: <b>482913</b></p><a href="https://shop.test/verify?token=abcDEF123&amp;lang=en">Verify</a>',
      })
    }
    // MailHog-like v2 search: quoted-printable body inside JSON.
    if (u.pathname === '/api/v2/search') {
      return json(res, 200, {
        total: 1,
        items: [{ Content: { Body: '<p>Kode: <b>771204</b></p><a href=3D"https://shop.test/reset?token=\r\n=3DZ9y8X7&amp;lang=3Did">Reset</a>' } }],
      })
    }
    if (u.pathname === '/never') return json(res, 200, { messages: [] })
    if (u.pathname === '/totp') {
      let body = ''
      req.on('data', (d) => (body += d))
      req.on('end', () => {
        const { code } = JSON.parse(body)
        otpSeen.push(code)
        const key = decodeBase32(OTP_SEED)
        const now = Date.now()
        const valid = [now - 30_000, now].some((t) => totpAt(key, t, { digits: 6, period: 30, algorithm: 'SHA1' }) === code)
        json(res, valid ? 200 : 401, { ok: valid, echo: code })
      })
      return
    }
    json(res, 404, { error: 'not found' })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  runner = new Runner()
  await runner.ready()
})

after(async () => {
  await runner.close()
  await new Promise((r) => server.close(r))
  tmp.cleanup()
})

function run(name, steps, { secrets = { OTP_SEED } } = {}) {
  seq++
  const caseId = `rc_${name}`
  return runner
    .run({
      type: 'run.start',
      run_id: `run_${name}_${seq}`,
      artifact_dir: join(tmp.dir, `${name}-${seq}`),
      options: { step_timeout_ms: 5000 },
      env: { MAILPIT_URL: base, MAILHOG_URL: base },
      secrets,
      vars: { email: `qa+${name}@example.com` },
      cases: [{ case_id: caseId, steps }],
    })
    .then((events) => ({ events, steps: stepEvents(events, caseId) }))
}

describe('http_request polling', () => {
  test('re-sends until 2xx and every save path resolves, then saves; details carry attempts', async () => {
    const { steps } = await run('poll_ok', [
      {
        step_id: 'p1',
        action: 'http_request',
        method: 'GET',
        url: '{{env.MAILPIT_URL}}/api/v1/search',
        query: { query: 'to:{{vars.email}}' },
        save: { mail_id: '$.messages[0].ID' },
        poll_timeout_ms: 10000,
        poll_interval_ms: 200,
      },
      { step_id: 'p2', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}', save_regex: { otp: 'code: (\\d{6})', link: 'https://\\S+' } },
      { step_id: 'p3', action: 'set_variable', name: 'combined', value: '{{vars.otp}}|{{vars.link}}' },
      { step_id: 'p4', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}', save_regex: { link2: 'href="([^"]+)"' }, regex_decode: 'auto' },
      { step_id: 'p5', action: 'expect_json', path: '$.Subject', op: 'eq', value: 'Your verification code' },
    ])
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed', 'passed', 'passed', 'passed'], JSON.stringify(steps, null, 1))
    assert.equal(steps[0].details.attempts, 3)
    assert.equal(steps[0].details.response.status, 200)
    assert.equal(steps[0].details.response.body.messages[0].ID, MAIL_ID)
    assert.equal(steps[1].details.attempts, undefined, 'attempts only when polling')
    // the raw JSON body escapes & as \u0026 → the link stops there with regex_decode none
    const { steps: s2 } = await run('regex_values', [
      { step_id: 'v1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/' + MAIL_ID, save_regex: { otp: 'code: (\\d{6})', link: 'https://[^\\s"\\\\]+' } },
      { step_id: 'v2', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/' + MAIL_ID, save_regex: { link: 'href="([^"]+)"' }, regex_decode: 'html' },
      { step_id: 'v3', action: 'expect_json', path: '$.ID', op: 'eq', value: MAIL_ID },
      { step_id: 'v4', action: 'http_request', method: 'POST', url: '{{env.MAILPIT_URL}}/totp', body: { code: '{{vars.otp}}|{{vars.link}}' } },
    ])
    assert.deepEqual(s2.map((s) => s.status), ['passed', 'passed', 'passed', 'passed'])
    // /totp echoes what it got: otp from group 1, the second save (html-decoded JSON strings) overwrote link
    assert.equal(s2[3].details.response.body.echo, '482913|https://shop.test/verify?token=abcDEF123&lang=en')
  })

  test('poll_until waits for a non-empty value', async () => {
    const { steps } = await run('poll_until', [
      { step_id: 'u1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/search', query: { query: 'to:{{vars.email}}' }, poll_until: '$.messages[0]', poll_timeout_ms: 10000, poll_interval_ms: 200 },
      { step_id: 'u2', action: 'expect_json', path: '$.total', op: 'eq', value: '1' },
    ])
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed'])
    assert.equal(steps[0].details.attempts, 3)
  })

  test('timeout fails with the last response, attempts and what was still missing', async () => {
    const t0 = Date.now()
    const { steps } = await run('poll_timeout', [
      { step_id: 't1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/never', save: { id: '$.messages[0].ID' }, save_regex: { otp: '\\d{6}' }, poll_until: '$.messages', poll_timeout_ms: 1200, poll_interval_ms: 300 },
    ])
    const elapsed = Date.now() - t0
    const [s] = steps
    assert.equal(s.status, 'failed')
    assert.match(s.error, /^Polling GET http:\/\/127\.0\.0\.1:\d+\/never timed out after 1200 ms \(\d+ attempts\); still missing: /)
    assert.match(s.error, /poll_until \$\.messages is an empty array/)
    assert.match(s.error, /Cannot save "id": \$\.messages\[0\]\.ID not found in the response/)
    assert.match(s.error, /Cannot save "otp": pattern \/\\d\{6\}\/ not found in the response/)
    assert.ok(s.details.attempts >= 3 && s.details.attempts <= 6, `attempts ${s.details.attempts}`)
    assert.deepEqual(s.details.response.body, { messages: [] })
    assert.equal(s.details.response.status, 200)
    assert.ok(elapsed < 5000, `took ${elapsed}ms`)
  })

  test('non-2xx keeps polling and is reported on timeout', async () => {
    const { steps } = await run('poll_404', [
      { step_id: 'n1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/missing', poll_timeout_ms: 500, poll_interval_ms: 200 },
    ])
    assert.equal(steps[0].status, 'failed')
    assert.match(steps[0].error, /still missing: status 404 \(waiting for 2xx\)$/)
    assert.equal(steps[0].details.response.status, 404)
  })
})

describe('http_request save_regex', () => {
  test('MailHog-style quoted-printable body with regex_decode auto', async () => {
    const { steps } = await run('mailhog', [
      {
        step_id: 'h1',
        action: 'http_request',
        method: 'GET',
        url: '{{env.MAILHOG_URL}}/api/v2/search?kind=to&k=x',
        save_regex: { code: 'Kode: <b>(\\d+)</b>', reset: 'href="([^"]+)"' },
        regex_decode: 'auto',
      },
      { step_id: 'h2', action: 'http_request', method: 'POST', url: '{{env.MAILPIT_URL}}/totp', body: { code: '{{vars.code}} {{vars.reset}}' } },
    ])
    assert.equal(steps[0].status, 'passed', steps[0].error)
    assert.equal(steps[1].details.response.body.echo, '771204 https://shop.test/reset?token=Z9y8X7&lang=id')
  })

  test('a pattern that does not match fails the step without polling', async () => {
    const { steps } = await run('regex_miss', [
      { step_id: 'r1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/api/v1/message/' + MAIL_ID, save_regex: { otp: 'OTP (\\d{8})' } },
    ])
    assert.equal(steps[0].status, 'failed')
    assert.equal(steps[0].error, 'Cannot save "otp": pattern /OTP (\\d{8})/ not found in the response')
    assert.equal(steps[0].details.response.status, 200)
  })

  test('invalid regex and invalid regex_decode fail with clear messages', async () => {
    const { steps } = await run('regex_bad', [
      { step_id: 'b1', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/never', save_regex: { x: '([' }, continue_on_failure: true },
      { step_id: 'b2', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/never', regex_decode: 'base64', continue_on_failure: true },
      { step_id: 'b3', action: 'http_request', method: 'GET', url: '{{env.MAILPIT_URL}}/never', poll_timeout_ms: 999999 },
    ])
    assert.deepEqual(steps.map((s) => s.status), ['failed', 'failed', 'failed'])
    assert.match(steps[0].error, /^Invalid regex "\(\[": /)
    assert.equal(steps[1].error, 'Invalid regex_decode "base64" (expected none, quoted_printable, html, auto)')
    assert.equal(steps[2].error, 'poll_timeout_ms must be between 0 and 120000')
  })
})

describe('{{fn.totp}}', () => {
  test('the code is accepted by the target and masked in every runner event', async () => {
    otpSeen.length = 0
    const { events, steps } = await run('totp', [
      { step_id: 'o1', action: 'http_request', method: 'POST', url: '{{env.MAILPIT_URL}}/totp?c={{fn.totp secret.OTP_SEED}}', body: { code: '{{fn.totp secret.OTP_SEED}}' } },
      { step_id: 'o2', action: 'expect_json', path: '$.ok', op: 'eq', value: 'true' },
      { step_id: 'o3', action: 'expect_json', path: '$.echo', op: 'eq', value: 'nope' },
    ])
    assert.deepEqual(steps.map((s) => s.status), ['passed', 'passed', 'failed'], JSON.stringify(steps, null, 1))
    assert.equal(otpSeen.length, 1)
    const code = otpSeen[0]
    assert.match(code, /^\d{6}$/)
    assert.equal(steps[0].details.response.body.echo, '••••')
    assert.match(steps[0].details.request.url, /\?c=••••$/)
    assert.equal(steps[2].details.actual, '••••')
    assert.ok(!runner.rawLines.join('\n').includes(code), 'TOTP code leaked into the event stream')
    assert.ok(!runner.rawLines.join('\n').includes(OTP_SEED), 'TOTP seed leaked into the event stream')
    assert.equal(byType(events, 'run.finished')[0].status, 'failed')
  })

  test('an invalid seed fails the step with a clear message that does not contain the seed', async () => {
    const { steps } = await run('totp_bad', [
      { step_id: 'x1', action: 'set_variable', name: 'seed', value: 'not a base32 seed!' },
      { step_id: 'x2', action: 'http_request', method: 'POST', url: '{{env.MAILPIT_URL}}/totp', body: { code: '{{fn.totp vars.seed}}' } },
    ])
    assert.equal(steps[1].status, 'failed')
    assert.equal(steps[1].error, 'Invalid {{fn.totp vars.seed}}: the seed is not valid base32 (allowed: A–Z, 2–7)')
  })
})
