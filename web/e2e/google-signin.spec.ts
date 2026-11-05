import { readFileSync } from 'node:fs'
import { expect, test, type Page } from '@playwright/test'
import { isReal, login, logout, USERS } from './helpers'

/**
 * J14: admin sets up Google sign-in from an uploaded OAuth client JSON (Admin → Google sign-in).
 *
 * Mock mode: the MSW mock validates the JSON like the backend and flips `/auth/config.google_enabled`.
 * Real mode: the server must not set GOOGLE_CLIENT_ID; the test removes the stored client at the end.
 * The fixtures hold fake credentials; nothing talks to Google.
 */
const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')

/** The web-client fixture lists http://localhost:4173; point it at the origin under test so the redirect URI matches. */
function webClientFor(origin: string): { text: string; clientId: string; secret: string } {
  const json = JSON.parse(fixture('google-web-client.json')) as { web: { client_id: string; client_secret: string; redirect_uris: string[]; javascript_origins: string[] } }
  json.web.redirect_uris = [`${origin}/api/v1/auth/google/callback`]
  json.web.javascript_origins = [origin]
  return { text: JSON.stringify(json), clientId: json.web.client_id, secret: json.web.client_secret }
}

async function upload(page: Page, name: string, text: string) {
  await page.locator('#google-json-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) })
}

test('J14: admin uploads a Google OAuth client JSON and enables Google sign-in; viewers cannot reach it', async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? 'http://localhost:4173').origin
  const client = webClientFor(origin)

  await login(page)
  await page.getByRole('link', { name: 'Admin · Google sign-in' }).click()
  await expect(page).toHaveURL(/\/admin\/google-sign-in$/)
  await expect(page.getByRole('heading', { name: 'Google sign-in', level: 1 })).toBeVisible()
  await expect(page.getByTestId('google-state')).toHaveText('Disabled')
  await expect(page.getByTestId('google-source')).toHaveText('Not configured')

  // Setup steps show the values to register in Google Cloud Console.
  await expect(page.locator('#google-origin')).toHaveText(origin)
  await expect(page.locator('#google-redirect')).toHaveText(`${origin}/api/v1/auth/google/callback`)

  // Turning it on without a file → Save points at the missing credentials.
  await page.getByRole('switch', { name: 'Allow Google sign-in' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Upload the OAuth client JSON to finish setup.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose JSON file' })).toBeFocused()

  // A Desktop app client is rejected in the browser before anything is sent.
  await upload(page, 'client_secret_desktop.json', fixture('google-desktop-client.json'))
  await expect(page.getByRole('alert').filter({ hasText: 'is a Desktop app client' })).toContainText('Create a Web application client')
  await expect(page.getByTestId('google-staged')).toHaveCount(0)

  // The web client is read locally: client ID and the redirect URI check, never the secret.
  await upload(page, 'client_secret_e2e.json', client.text)
  const staged = page.getByTestId('google-staged')
  await expect(staged).toBeFocused()
  await expect(page.getByTestId('google-staged-client-id')).toHaveText(client.clientId)
  await expect(staged.getByText('matches QAtlas')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(client.secret)

  await expect(page.getByRole('switch', { name: 'Allow Google sign-in' })).toBeChecked()
  const domains = page.getByRole('textbox', { name: /Allowed email domains/ })
  await domains.fill('rina@tokoku.id')
  await domains.press('Enter')
  await expect(page.getByText('Enter only the domain, e.g. tokoku.id')).toBeVisible()
  await domains.fill('tokoku.id')
  await domains.press('Enter')
  await expect(page.getByRole('list', { name: 'Allowed domains' }).getByRole('listitem')).toHaveText(['tokoku.id'])

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Saved — Continue with Google is on the login page')).toBeVisible()
  await expect(page.getByTestId('google-state')).toHaveText('Enabled')
  await expect(page.getByTestId('google-source')).toHaveText('Saved in QAtlas')
  await expect(page.getByTestId('google-client-id')).toHaveText(client.clientId)
  await expect(page.getByTestId('google-redirect-status')).toHaveText('Redirect URI found in the uploaded file')
  await expect(page.getByTestId('google-credentials-status')).toContainText('Credentials set')
  await expect(page.getByText('No changes yet')).toBeVisible()
  await expect(page.locator('body')).not.toContainText(client.secret)

  // The login page follows /auth/config.google_enabled.
  await logout(page, USERS.admin.name)
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()

  // Members (here: a project viewer) have no link and are redirected away.
  await login(page, USERS.viewer.email)
  await expect(page.getByRole('link', { name: 'Admin · Google sign-in' })).toHaveCount(0)
  await page.goto('/admin/google-sign-in')
  await expect(page).not.toHaveURL(/\/admin\/google-sign-in/)
  await expect(page.getByRole('heading', { name: 'Google sign-in', level: 1 })).toHaveCount(0)

  if (isReal) {
    // Leave the shared real-mode server without a Google client for the other journeys.
    await logout(page, USERS.viewer.name)
    await login(page)
    const res = await page.request.delete('/api/v1/admin/settings/google-auth', { headers: { 'X-QAtlas-CSRF': '1' } })
    expect(res.status(), await res.text()).toBe(200)
  }
})
