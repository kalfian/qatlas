import { describe, expect, it } from 'vitest'
import type { GoogleAuthSettings } from '@/api/types'
import {
  checkClientJson,
  draftFromSettings,
  isDirty,
  mapServerDetails,
  MAX_CLIENT_JSON_BYTES,
  normalizeDomain,
  sameUri,
  shortClientId,
  splitClientId,
  splitDomains,
  toInput,
  validateDomain,
  validateDraft,
} from './google-auth-form'

const CLIENT_ID = 'qatlas-unit-test-oauth-client.apps.googleusercontent.com'
const REDIRECT = 'https://qa.tokoku.id/api/v1/auth/google/callback'

const webClient = (web: Record<string, unknown> = {}) =>
  JSON.stringify({
    web: {
      client_id: CLIENT_ID,
      project_id: 'tokoku-qa',
      auth_uri: 'https://accounts.google.com/o/oauth2/auth',
      token_uri: 'https://oauth2.googleapis.com/token',
      client_secret: 'qatlas-unit-fake-secret',
      redirect_uris: [REDIRECT],
      javascript_origins: ['https://qa.tokoku.id'],
      ...web,
    },
  })

const NONE: GoogleAuthSettings = {
  enabled: false,
  source: 'none',
  env_override: false,
  client_id: null,
  client_secret_set: false,
  project_id: null,
  redirect_uri: REDIRECT,
  javascript_origin: 'https://qa.tokoku.id',
  redirect_uri_registered: null,
  allowed_domains: [],
  updated_at: null,
  updated_by: null,
  warning: null,
}

const SAVED: GoogleAuthSettings = {
  ...NONE,
  enabled: true,
  source: 'database',
  client_id: CLIENT_ID,
  client_secret_set: true,
  project_id: 'tokoku-qa',
  redirect_uri_registered: true,
  allowed_domains: ['tokoku.id'],
  updated_at: '2026-11-05T03:00:00Z',
  updated_by: { id: 'u_rina', name: 'Rina Kusuma', email: 'rina@tokoku.id' } as GoogleAuthSettings['updated_by'],
}

describe('checkClientJson', () => {
  it('accepts a Web application client and reads only safe fields', () => {
    const r = checkClientJson(webClient())
    expect(r).toEqual({
      ok: true,
      info: { clientId: CLIENT_ID, projectId: 'tokoku-qa', redirectUris: [REDIRECT], javascriptOrigins: ['https://qa.tokoku.id'] },
    })
    // the secret is never part of what the UI renders
    expect(JSON.stringify(r)).not.toContain('qatlas-unit-fake-secret')
  })

  it('tolerates missing optional fields', () => {
    const r = checkClientJson(webClient({ project_id: undefined, redirect_uris: undefined, javascript_origins: 'nope' }))
    expect(r).toEqual({ ok: true, info: { clientId: CLIENT_ID, projectId: null, redirectUris: [], javascriptOrigins: [] } })
  })

  it('rejects a Desktop app (installed) client', () => {
    const desktop = JSON.stringify({ installed: { client_id: CLIENT_ID, client_secret: 'x', redirect_uris: ['http://localhost'] } })
    expect(checkClientJson(desktop)).toEqual({ ok: false, error: 'desktop' })
  })

  it('rejects a service account key', () => {
    const sa = JSON.stringify({ type: 'service_account', project_id: 'tokoku-qa', private_key: '-----BEGIN PRIVATE KEY-----', client_email: 'x@tokoku-qa.iam.gserviceaccount.com' })
    expect(checkClientJson(sa)).toEqual({ ok: false, error: 'serviceAccount' })
  })

  it('reports a missing secret or client ID', () => {
    expect(checkClientJson(webClient({ client_secret: undefined }))).toEqual({ ok: false, error: 'missingSecret' })
    expect(checkClientJson(webClient({ client_secret: '  ' }))).toEqual({ ok: false, error: 'missingSecret' })
    expect(checkClientJson(webClient({ client_id: '' }))).toEqual({ ok: false, error: 'missingClientId' })
  })

  it('rejects text that is not an OAuth client file', () => {
    expect(checkClientJson('')).toEqual({ ok: false, error: 'empty' })
    expect(checkClientJson('   \n')).toEqual({ ok: false, error: 'empty' })
    expect(checkClientJson('{"web": ')).toEqual({ ok: false, error: 'notJson' })
    expect(checkClientJson('[1, 2]')).toEqual({ ok: false, error: 'notOAuthClient' })
    expect(checkClientJson('"web"')).toEqual({ ok: false, error: 'notOAuthClient' })
    expect(checkClientJson('{"web": "x"}')).toEqual({ ok: false, error: 'notOAuthClient' })
    expect(checkClientJson('{"client_id": "x"}')).toEqual({ ok: false, error: 'notOAuthClient' })
  })

  it('rejects files over the size limit before parsing', () => {
    expect(checkClientJson(webClient({ padding: 'x'.repeat(MAX_CLIENT_JSON_BYTES) }))).toEqual({ ok: false, error: 'tooLarge' })
  })
})

describe('domains', () => {
  it('normalizes and validates', () => {
    expect(normalizeDomain(' @Tokoku.ID. ')).toBe('tokoku.id')
    expect(validateDomain('tokoku.id')).toBeUndefined()
    expect(validateDomain('mail.tokoku.co.id')).toBeUndefined()
    expect(validateDomain('@tokoku.id')).toBeUndefined()
    expect(validateDomain('rina@tokoku.id')).toBe('email')
    expect(validateDomain('tokoku')).toBe('invalid')
    expect(validateDomain('-tokoku.id')).toBe('invalid')
    expect(validateDomain('tokoku..id')).toBe('invalid')
    expect(validateDomain('https://tokoku.id')).toBe('invalid')
  })

  it('splits pasted lists', () => {
    expect(splitDomains('tokoku.id, partner.co.id;\nqa.tokoku.id  ')).toEqual(['tokoku.id', 'partner.co.id', 'qa.tokoku.id'])
    expect(splitDomains(' , ')).toEqual([])
  })
})

describe('draft', () => {
  it('starts from saved settings and is clean', () => {
    const d = draftFromSettings(SAVED)
    expect(d).toEqual({ enabled: true, domains: ['tokoku.id'], file: null, replacing: false })
    expect(isDirty(d, SAVED)).toBe(false)
    // opening "replace" without choosing a file is not a change
    expect(isDirty({ ...d, replacing: true }, SAVED)).toBe(false)
  })

  it('detects changes', () => {
    const d = draftFromSettings(SAVED)
    expect(isDirty({ ...d, enabled: false }, SAVED)).toBe(true)
    expect(isDirty({ ...d, domains: [] }, SAVED)).toBe(true)
    expect(isDirty({ ...d, domains: ['tokoku.id', 'partner.co.id'] }, SAVED)).toBe(true)
    const r = checkClientJson(webClient())
    if (!r.ok) throw new Error('fixture must parse')
    expect(isDirty({ ...d, file: { name: 'client.json', text: webClient(), info: r.info } }, SAVED)).toBe(true)
  })

  it('requires credentials the first time only', () => {
    expect(validateDraft(draftFromSettings(NONE), NONE)).toEqual({ credentials: 'credentialsRequired' })
    expect(validateDraft({ ...draftFromSettings(NONE), enabled: false }, NONE)).toEqual({ credentials: 'credentialsRequired' })
    expect(validateDraft(draftFromSettings(SAVED), SAVED)).toEqual({})
  })

  it('omits client_json unless a new file is staged', () => {
    const d = draftFromSettings(SAVED)
    expect(toInput(d)).toEqual({ enabled: true, allowed_domains: ['tokoku.id'] })
    const r = checkClientJson(webClient())
    if (!r.ok) throw new Error('fixture must parse')
    const text = webClient()
    expect(toInput({ ...d, file: { name: 'client.json', text, info: r.info } })).toEqual({ enabled: true, allowed_domains: ['tokoku.id'], client_json: text })
  })
})

describe('mapServerDetails', () => {
  it('maps client_json and indexed domain paths', () => {
    const m = mapServerDetails([
      { path: 'client_json', message: 'This is a Desktop app client' },
      { path: 'client_json', message: 'second message is ignored' },
      { path: 'allowed_domains[1]', message: 'Not a valid domain' },
      { path: 'allowed_domains', message: 'Too many domains' },
      { path: 'enabled', message: 'Must be a boolean' },
    ])
    expect(m.credentials).toBe('This is a Desktop app client')
    expect(m.domains).toEqual({ 1: 'Not a valid domain' })
    expect(m.domainsField).toBe('Too many domains')
    expect(m.other).toEqual([{ path: 'enabled', message: 'Must be a boolean' }])
  })
})

describe('helpers', () => {
  it('compares redirect URIs ignoring a trailing slash only', () => {
    expect(sameUri(REDIRECT, `${REDIRECT}/`)).toBe(true)
    expect(sameUri(REDIRECT, REDIRECT.replace('https', 'http'))).toBe(false)
  })

  it('shortens long client IDs', () => {
    expect(shortClientId(CLIENT_ID)).toBe('qatlas-unit-test-…')
    expect(shortClientId('short-id.apps.googleusercontent.com')).toBe('short-id')
    expect(splitClientId(CLIENT_ID)).toEqual(['qatlas-unit-test-oauth-client', '.apps.googleusercontent.com'])
    expect(splitClientId('no-suffix')).toEqual(['no-suffix', ''])
  })
})
