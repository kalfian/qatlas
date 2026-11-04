import { expect, test } from '@playwright/test'
import { fastSimulation, login, USERS } from './helpers'

test('J7: flow shared session dijalankan → report per case dengan satu video', async ({ page }) => {
  await login(page)
  await fastSimulation(page)
  await page.goto('/p/SHOP/flows')
  await page.getByRole('button', { name: 'Run SHOP-F1 Checkout happy path' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.locator('[aria-label="Video"]').getByText('Selalu').click()
  await dialog.getByRole('button', { name: 'Jalankan' }).click()
  await expect(page).toHaveURL(/\/p\/SHOP\/runs\/SHOP-R\d+/)

  await expect(page.locator('[data-status="passed"]').first()).toBeVisible()
  await expect(page.getByRole('tab', { name: /Video/ })).toContainText('1', { timeout: 45_000 })
  await expect(page.getByText('SHOP-T11').first()).toBeVisible()
  await page.getByRole('tab', { name: /Video/ }).click()
  await expect(page.locator('video')).toHaveCount(1)
  await expect(page.getByText('Seluruh flow · satu sesi browser')).toBeVisible()
})

test('J10: riwayat run bisa difilter dan dashboard menampilkan pass rate', async ({ page }) => {
  await login(page)
  await page.goto('/p/SHOP/runs?status=failed')
  await expect(page.getByRole('list', { name: 'Filter aktif' })).toContainText('Failed')
  const rows = page.locator('table tbody tr')
  await expect(rows.first()).toBeVisible()
  for (const status of await page.locator('table tbody [data-status]').evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))) {
    expect(status).toBe('failed')
  }
  await page.getByRole('button', { name: 'Hapus filter status' }).click()
  await expect(page).not.toHaveURL(/status=failed/)

  await page.goto('/p/SHOP')
  await expect(page.getByText(/Pass rate/).first()).toBeVisible()
  await expect(page.getByText(/\d+%/).first()).toBeVisible()
})

test('J8: viewer hanya bisa melihat', async ({ page }) => {
  await login(page, USERS.viewer.email)
  await page.goto('/p/SHOP/flows')
  await expect(page.getByRole('heading', { name: 'Flows' })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Run SHOP-F/ })).toHaveCount(0)
  await expect(page.getByRole('link', { name: /Flow/ }).filter({ hasText: '+' })).toHaveCount(0)
  await expect(page.getByRole('navigation', { name: 'Navigasi project' }).getByRole('link', { name: 'Pengaturan' })).toHaveCount(0)
  await page.goto('/p/SHOP/environments')
  await expect(page.getByRole('button', { name: /Environment$/ })).toHaveCount(0)
  await page.goto('/p/SHOP/settings')
  await expect(page.getByText('Kamu tidak punya akses ke pengaturan project ini')).toBeVisible()
})
