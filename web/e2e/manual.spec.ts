import { expect, test } from '@playwright/test'
import { isReal, login, RUN_TIMEOUT, startRunViaApi } from './helpers'

// PNG 1×1 untuk lampiran
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('J12: flow campuran berhenti di case manual, assignee mengerjakan, flow lanjut otomatis', async ({ page }) => {
  await login(page)
  // Real mode has no seeded open manual run: SHOP-F3 runs SHOP-T1/T8/T11 for real, then stops at
  // the manual SHOP-T14 assigned to the user who started it.
  if (isReal) await startRunViaApi(page, 'SHOP', { flow: 'SHOP-F3' }, ['awaiting_manual'])
  await page.goto('/my-tasks')
  await page.getByRole('link', { name: /Work on SHOP-R\d+: Checkout regression/ }).click()
  await expect(page).toHaveURL(/\/p\/SHOP\/runs\/SHOP-R\d+/)

  const decisions = page.getByRole('group', { name: 'Step result' })
  // step 1: pass
  await decisions.getByRole('button', { name: /Pass/ }).click()
  // step 2: fail + actual result + lampiran
  await decisions.getByRole('button', { name: /Fail/ }).click()
  await page.getByLabel('Actual result').fill('Logo invoice pecah di header')
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'invoice.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText('invoice.png').first()).toBeVisible()
  await page.getByLabel('Actual result').press('Control+Enter')
  // step 3: pass
  await decisions.getByRole('button', { name: /Pass/ }).click()

  await page.getByRole('button', { name: 'Finish', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: /^(Finish|Mark the rest Skipped & finish)$/ }).click()

  // case manual gagal + stop on failure → case berikutnya di-skip, run Failed
  await expect(page.locator('header [data-status="failed"], [data-status="failed"]').first()).toBeVisible({ timeout: RUN_TIMEOUT })
  await expect(page.getByText('Logo invoice pecah di header').first()).toBeVisible()
  await page.goto('/my-tasks')
  await expect(page.getByRole('link', { name: /Checkout regression/ })).toHaveCount(0)
})
