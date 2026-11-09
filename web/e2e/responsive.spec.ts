import { expect, test } from '@playwright/test'
import { fastSimulation, isReal, login, RUN_TIMEOUT } from './helpers'

/**
 * J15 responsive testing (docs/14): a step limited with "Only on", a test case run on three devices from the
 * Run dialog, the Matrix view, and the overflow offenders of the failed phone cell. It builds its own example
 * from SHOP-T8 (product page → cart); the demo seed has no responsive test cases.
 */
test('J15: "Only on" in the editor; SHOP-T8 on 3 devices → matrix → failed phone cell shows the overflow', async ({ page }) => {
  // Runs in both modes: mock (simulated layout, mocks/simulator.ts WIDE_PAGES) and real (runner + demo-target,
  // whose product page size chart is 650px wide on purpose — demo-target/README.md "Intentional responsive bug").
  test.setTimeout(isReal ? 240_000 : 120_000)
  await login(page)
  if (!isReal) await fastSimulation(page)

  // 1. Editor: add "No horizontal scroll" to SHOP-T8 (product page), only on tablet + mobile
  await page.goto('/p/SHOP/tests/SHOP-T8')
  await page.getByRole('button', { name: 'Add step' }).click()
  await page.getByRole('combobox', { name: 'Search actions' }).fill('horizontal')
  await page.keyboard.press('Enter')
  const panel = page.getByRole('region', { name: /· expect_no_horizontal_scroll$/ })
  await panel.getByRole('button', { name: /^Advanced/ }).click()
  const onlyOn = panel.getByRole('group', { name: /Only on/ })
  await onlyOn.getByRole('checkbox', { name: 'Tablet' }).check()
  await onlyOn.getByRole('checkbox', { name: 'Mobile' }).check()
  await expect(onlyOn).toContainText('Tablet + mobile')
  await expect(page.getByRole('option', { name: /expect_no_horizontal_scroll, Expect no horizontal scroll, only on tablet \+ mobile/ })).toBeVisible()
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/Revision \d+ saved/).first()).toBeVisible()

  // 2. Run dialog: SHOP-T8 on Desktop + iPad Mini + iPhone 15
  await page.getByRole('button', { name: /^Run$/ }).click()
  const dialog = page.getByRole('dialog')
  const devices = dialog.getByRole('button', { name: /^Devices / })
  await expect(devices).toHaveAccessibleName('Devices Desktop · 1280×720')
  await devices.click()
  await page.getByRole('checkbox', { name: 'iPad Mini 768×1024' }).click()
  await page.getByRole('checkbox', { name: 'iPhone 15 393×659' }).click()
  await page.getByRole('button', { name: 'Done' }).click()
  await expect(devices).toHaveAccessibleName('Devices 3 devices · 1 tablet · 1 mobile')
  await expect(dialog.getByRole('list', { name: 'Selected devices' }).getByRole('listitem')).toHaveCount(3)
  await dialog.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page).toHaveURL(/\/p\/SHOP\/runs\/SHOP-R\d+/)

  // 3. Matrix: one row, one column per device; only the phone fails (the size chart is wider than 393px)
  await expect(page.getByRole('tab', { name: 'Matrix' })).toHaveAttribute('aria-selected', 'true')
  const matrix = page.getByRole('table', { name: 'Results per test case and device' })
  await expect(matrix.getByRole('columnheader')).toHaveText([/Test case/, /Desktop\s*1280×720/, /iPad Mini\s*768×1024/, /iPhone 15\s*393×659/])
  const cell = (device: string, status: string) => matrix.getByRole('button', { name: new RegExp(`^SHOP-T8 .* on ${device}: ${status}\\. Show steps$`) })
  const failedCell = cell('iPhone 15 · 393×659', 'Failed')
  await expect(failedCell).toBeVisible({ timeout: RUN_TIMEOUT })
  await expect(cell('iPad Mini · 768×1024', 'Passed')).toBeVisible({ timeout: RUN_TIMEOUT })
  await expect(cell('Desktop · 1280×720', 'Passed')).toBeVisible({ timeout: RUN_TIMEOUT })

  // 4. Failed phone cell → the case on the iPhone, with the overflowing table
  await failedCell.click()
  await expect(page.getByRole('tab', { name: 'Steps' })).toHaveAttribute('aria-selected', 'true')
  const iphone = page.getByRole('region', { name: /^Cases on iPhone 15 · 393×659/ })
  await expect(iphone.getByText('Elements past the right edge')).toBeVisible()
  await expect(iphone.getByText('content width 650px', { exact: true })).toBeVisible()
  await expect(iphone.getByText('table', { exact: true }).first()).toBeVisible()

  // 5. Desktop: the tablet/mobile-only step is skipped as "Not run on desktop" (not disabled)
  await page.getByRole('tab', { name: 'Matrix' }).click()
  await cell('Desktop · 1280×720', 'Passed').click()
  await expect(page.getByRole('region', { name: /^Cases on Desktop · 1280×720/ }).getByText('Not run on desktop').first()).toBeVisible()
})
