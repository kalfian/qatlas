import type { FieldError, GoogleAuthSettings, GoogleAuthSettingsInput } from '@/api/types'
import { googleAuthState, nowIso, userRef } from './db'

/**
 * Simulasi Admin → Google sign-in (mock saja), meniru validasi backend:
 * - `client_json` harus JSON client OAuth tipe Web application (`{"web": {...}}`); Desktop (`installed`) dan
 *   service account ditolak, `client_id`/`client_secret` wajib, client_id harus `….apps.googleusercontent.com`.
 * - `client_json` wajib pertama kali; dihilangkan = pakai kredensial tersimpan.
 * - Toggle dev toolbar "Google dari env" = GOOGLE_CLIENT_ID/SECRET di server: halaman jadi read-only (409).
 */

const ENV_GOOGLE = {
  client_id: 'qatlas-env-demo-client.apps.googleusercontent.com',
  project_id: 'tokoku-qa',
  /** GOOGLE_ALLOWED_DOMAINS kosong: semua domain (user tetap harus terdaftar). */
  allowed_domains: [] as string[],
}

const DOMAIN_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

export function googleOrigin(): string {
  return location.origin
}

export function googleRedirectUri(): string {
  return `${location.origin}/api/v1/auth/google/callback`
}

/** Google aktif untuk halaman login (`/auth/config.google_enabled`). */
export function googleEnabled(): boolean {
  const g = googleAuthState()
  return g.env_override || (g.enabled && g.client_secret !== null)
}

export function googleAllowedDomains(): string[] {
  const g = googleAuthState()
  return g.env_override ? ENV_GOOGLE.allowed_domains : g.allowed_domains
}

function baseUrlWarning(): string | null {
  const url = new URL(location.origin)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol === 'http:' && !local)
    return `QATLAS_BASE_URL is ${url.origin}: Google only accepts http:// redirect URIs on localhost. Serve QAtlas over https.`
  return null
}

export function toGoogleAuthSettings(): GoogleAuthSettings {
  const g = googleAuthState()
  const common = { redirect_uri: googleRedirectUri(), javascript_origin: googleOrigin(), warning: baseUrlWarning() }
  if (g.env_override)
    return {
      ...common,
      enabled: true,
      source: 'env',
      env_override: true,
      client_id: ENV_GOOGLE.client_id,
      client_secret_set: true,
      project_id: ENV_GOOGLE.project_id,
      redirect_uri_registered: null,
      allowed_domains: ENV_GOOGLE.allowed_domains,
      updated_at: null,
      updated_by: null,
    }
  const stored = g.client_secret !== null
  return {
    ...common,
    enabled: stored && g.enabled,
    source: stored ? 'database' : 'none',
    env_override: false,
    client_id: g.client_id,
    client_secret_set: stored,
    project_id: g.project_id,
    redirect_uri_registered: g.redirect_uris ? g.redirect_uris.some((u) => u.replace(/\/+$/, '') === googleRedirectUri()) : null,
    allowed_domains: g.allowed_domains,
    updated_at: g.updated_at,
    updated_by: g.updated_by ? userRef(g.updated_by) : null,
  }
}

interface ParsedClient {
  client_id: string
  client_secret: string
  project_id: string | null
  redirect_uris: string[]
}

function parseClientJson(raw: string): ParsedClient | FieldError {
  const err = (message: string): FieldError => ({ path: 'client_json', message })
  let v: unknown
  try {
    v = JSON.parse(raw)
  } catch {
    return err('Not a JSON file')
  }
  if (typeof v !== 'object' || v === null) return err('Not an OAuth client file from Google Cloud Console')
  const o = v as Record<string, unknown>
  if (o.type === 'service_account') return err('This is a service account key, not an OAuth client. Create an OAuth client ID of type Web application.')
  if (o.installed) return err('This is a Desktop app client; create a Web application client')
  const web = o.web as Record<string, unknown> | undefined
  if (!web || typeof web !== 'object') return err('Not an OAuth client file: expected a "web" object')
  const s = (x: unknown) => (typeof x === 'string' ? x.trim() : '')
  if (!s(web.client_id)) return err('web.client_id is missing')
  if (!s(web.client_secret)) return err('web.client_secret is missing')
  if (!s(web.client_id).endsWith('.apps.googleusercontent.com')) return err('web.client_id is not a Google OAuth client ID (…apps.googleusercontent.com)')
  return {
    client_id: s(web.client_id),
    client_secret: s(web.client_secret),
    project_id: s(web.project_id) || null,
    redirect_uris: Array.isArray(web.redirect_uris) ? web.redirect_uris.filter((x): x is string => typeof x === 'string') : [],
  }
}

/** Validasi + simpan. Mengembalikan detail 422 bila ada yang salah (tidak ada yang disimpan). */
export function saveGoogleAuth(input: GoogleAuthSettingsInput, userId: string): FieldError[] {
  const g = googleAuthState()
  const errors: FieldError[] = []
  if (typeof input.enabled !== 'boolean') errors.push({ path: 'enabled', message: 'Must be true or false' })
  let parsed: ParsedClient | null = null
  if (input.client_json !== undefined) {
    const r = parseClientJson(input.client_json)
    if ('path' in r) errors.push(r)
    else parsed = r
  } else if (g.client_secret === null) {
    errors.push({ path: 'client_json', message: 'Upload the OAuth client JSON (required the first time)' })
  }
  const domains: string[] = []
  ;(input.allowed_domains ?? []).forEach((raw, i) => {
    const d = String(raw).trim().toLowerCase()
    if (!DOMAIN_RE.test(d)) errors.push({ path: `allowed_domains[${i}]`, message: `"${raw}" is not a valid domain` })
    else if (!domains.includes(d)) domains.push(d)
  })
  if (errors.length) return errors

  if (parsed) {
    g.client_id = parsed.client_id
    g.client_secret = parsed.client_secret
    g.project_id = parsed.project_id
    g.redirect_uris = parsed.redirect_uris
  }
  g.enabled = input.enabled
  g.allowed_domains = domains
  g.updated_at = nowIso()
  g.updated_by = userId
  return []
}

export function removeGoogleAuth(userId: string) {
  const g = googleAuthState()
  Object.assign(g, {
    enabled: false,
    client_id: null,
    client_secret: null,
    project_id: null,
    redirect_uris: null,
    allowed_domains: [],
    updated_at: nowIso(),
    updated_by: userId,
  })
}

/** Dev toolbar: simulasi GOOGLE_CLIENT_ID/SECRET di environment server. */
export function setGoogleEnvOverride(on: boolean) {
  googleAuthState().env_override = on
}
