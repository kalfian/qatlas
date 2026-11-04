import { expect, test } from '@playwright/test'
import { isReal, login, logout, USERS } from './helpers'

/**
 * J13: admin configures S3-compatible artifact storage (Admin → Storage).
 *
 * Mock mode: the MSW mock simulates the probe and the artifact move (see src/mocks/storage.ts).
 * Real mode (E2E_MODE=real): needs a reachable S3-compatible bucket, otherwise the test is skipped:
 *   E2E_S3_ENDPOINT=https://garage.kalfian.work E2E_S3_REGION=garage E2E_S3_BUCKET=qatlas-e2e \
 *   E2E_S3_ACCESS_KEY_ID=GK… E2E_S3_SECRET_ACCESS_KEY=… scripts/e2e-real.sh -g J13
 * The test writes probe objects and copies the demo artifacts into that bucket (use a throwaway bucket),
 * and switches the server back to local disk at the end. The server must not set QATLAS_STORAGE.
 */
const S3 = isReal
  ? {
      endpoint: process.env.E2E_S3_ENDPOINT ?? '',
      region: process.env.E2E_S3_REGION || 'us-east-1',
      bucket: process.env.E2E_S3_BUCKET ?? '',
      accessKeyId: process.env.E2E_S3_ACCESS_KEY_ID ?? '',
      secret: process.env.E2E_S3_SECRET_ACCESS_KEY ?? '',
      rotatedSecret: process.env.E2E_S3_SECRET_ACCESS_KEY ?? '',
    }
  : {
      endpoint: 'https://garage.kalfian.work',
      region: 'garage',
      bucket: 'qatlas-artifacts',
      accessKeyId: 'GK31c2f218a2e44f485b94239e',
      secret: 'garage-e2e-secret-1',
      rotatedSecret: 'garage-e2e-secret-2',
    }
const s3Configured = !!(S3.endpoint && S3.bucket && S3.accessKeyId && S3.secret)

test('J13: admin sets up S3 storage, replaces the secret, moves old artifacts; members cannot reach it', async ({ page }) => {
  test.skip(isReal && !s3Configured, 'Real mode needs E2E_S3_ENDPOINT, E2E_S3_BUCKET, E2E_S3_ACCESS_KEY_ID and E2E_S3_SECRET_ACCESS_KEY')
  test.setTimeout(isReal ? 240_000 : 60_000)

  await login(page)
  await page.getByRole('link', { name: 'Admin · Storage' }).click()
  await expect(page).toHaveURL(/\/admin\/storage$/)
  await expect(page.getByRole('heading', { name: 'Storage', level: 1 })).toBeVisible()
  await expect(page.getByTestId('storage-active-backend')).toHaveText('Local disk')

  // Switch to S3 and fill the connection; Save before filling shows inline validation.
  await page.getByRole('radio', { name: 'S3-compatible' }).click()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByLabel('Endpoint URL')).toBeFocused()
  await expect(page.getByText('Enter the endpoint URL')).toBeVisible()
  await page.getByLabel('Endpoint URL').fill(`${S3.endpoint}/qatlas-artifacts`)
  await page.getByLabel('Endpoint URL').blur()
  await expect(page.getByText(/Remove the path/)).toBeVisible()
  await page.getByLabel('Endpoint URL').fill(S3.endpoint)
  await page.getByLabel('Region').fill(S3.region)
  await page.getByLabel('Bucket').fill(S3.bucket)
  await page.getByLabel('Access key ID').fill(S3.accessKeyId)
  await page.getByLabel('Secret access key', { exact: true }).fill(S3.secret)
  await expect(page.getByRole('switch', { name: 'Path-style addressing' })).toBeChecked()

  await page.getByRole('button', { name: 'Test connection' }).click()
  const checks = page.getByRole('list', { name: 'Connection checks' })
  await expect(page.getByText(/All 5 checks passed/)).toBeVisible({ timeout: isReal ? 30_000 : 10_000 })
  await expect(checks.getByText('Passed', { exact: true })).toHaveCount(5)

  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText('Storage saved — new artifacts go to S3-compatible')).toBeVisible({ timeout: isReal ? 30_000 : 10_000 })
  await expect(page.getByTestId('storage-active-backend')).toHaveText('S3-compatible')
  await expect(page.getByText('Saved in QAtlas')).toBeVisible()
  const secretGroup = page.getByRole('group', { name: 'Secret access key' })
  await expect(secretGroup).toContainText('Set')
  // Write-only: the stored secret is never put back into an input.
  await expect(page.locator('input[type="password"], input#storage-secret')).toHaveCount(0)

  // Replace secret: reveals an empty input; the typed value can be shown, the stored one never.
  await secretGroup.getByRole('button', { name: 'Replace secret' }).click()
  const newSecret = page.getByLabel('New secret access key')
  await expect(newSecret).toBeFocused()
  await expect(newSecret).toHaveValue('')
  await newSecret.fill(S3.rotatedSecret)
  await page.getByRole('button', { name: 'Show password' }).click()
  await expect(newSecret).toHaveAttribute('type', 'text')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('group', { name: 'Secret access key' })).toContainText(/Set · updated/, { timeout: isReal ? 30_000 : 10_000 })
  await expect(page.getByText('No changes yet')).toBeVisible()

  // Move the artifacts that are still on local disk.
  const move = page.getByRole('button', { name: /^Move \d+ existing artifacts? to S3-compatible$/ })
  await expect(move).toBeVisible()
  await move.click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog.getByRole('checkbox', { name: 'Delete the original files after copying' })).not.toBeChecked()
  await dialog.getByRole('button', { name: 'Start moving' }).click()
  await expect(page.getByRole('progressbar', { name: 'Artifact move progress' })).toBeVisible()
  await expect(page.getByText('All artifacts are on S3-compatible. Nothing to move.')).toBeVisible({ timeout: isReal ? 180_000 : 20_000 })
  await expect(page.getByText(/Last move finished .*: \d+ copied, 0 failed\./)).toBeVisible()
  await expect(page.getByTestId('storage-count-local')).toContainText('0 files')

  if (isReal) {
    // Leave the shared real-mode server on local disk for the other journeys.
    const res = await page.request.put('/api/v1/admin/settings/storage', { data: { backend: 'local' }, headers: { 'X-QAtlas-CSRF': '1' } })
    expect(res.status(), await res.text()).toBe(200)
  }

  // Members (here: a project viewer) have no Storage link and are redirected away.
  await logout(page, USERS.admin.name)
  await login(page, USERS.viewer.email)
  await expect(page.getByRole('link', { name: 'Admin · Storage' })).toHaveCount(0)
  await page.goto('/admin/storage')
  await expect(page).not.toHaveURL(/\/admin\/storage/)
  await expect(page.getByRole('heading', { name: 'Storage', level: 1 })).toHaveCount(0)
})
