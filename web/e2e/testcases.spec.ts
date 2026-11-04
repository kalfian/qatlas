import { expect, type Page, test } from '@playwright/test'
import { fastSimulation, login } from './helpers'

async function addStep(page: Page, query: string) {
  await page.getByRole('button', { name: 'Tambah step' }).click()
  await page.getByRole('combobox', { name: 'Cari action' }).fill(query)
  await page.keyboard.press('Enter')
}

async function fillParam(page: Page, label: string, value: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const field = page.getByRole('textbox', { name: new RegExp(`^${escaped}( opsional)?$`) })
  await field.fill(value)
  await field.press('Escape') // tutup autocomplete variable bila terbuka
}

async function save(page: Page) {
  await page.keyboard.press('Control+s')
  await expect(page.getByText(/Revisi \d+ tersimpan|Test case dibuat|tersimpan/).first()).toBeVisible()
}

test('J4: editor membuat test case UI dan revisi tercatat', async ({ page }) => {
  await login(page)
  await page.goto('/p/SHOP/tests/new')
  await page.getByLabel('Judul test case').fill('E2E: cari produk dari beranda')
  await addStep(page, 'goto')
  await fillParam(page, 'URL', 'https://staging.tokoku.id')
  await addStep(page, 'fill')
  await fillParam(page, 'Selector', 'placeholder=Cari produk')
  await fillParam(page, 'Nilai', 'kaos polos')
  await addStep(page, 'press')
  await fillParam(page, 'Tombol', 'Enter')
  await addStep(page, 'expect_visible')
  await fillParam(page, 'Selector', 'testid=product-card')
  await save(page)
  await expect(page).toHaveURL(/\/p\/SHOP\/tests\/SHOP-T\d+/)

  await page.getByRole('tab', { name: /Revisi/ }).click()
  await expect(page.getByText('Dibuat').first()).toBeVisible()

  await page.goto('/p/SHOP/tests?q=cari+produk+dari+beranda')
  await expect(page.getByRole('link', { name: /E2E: cari produk dari beranda/ }).first()).toBeVisible()
})

test('J5 + J6: run gagal menampilkan expected vs actual, diperbaiki, re-run lolos dengan screenshot & video', async ({ page }) => {
  await login(page)
  await fastSimulation(page)
  await page.goto('/p/SHOP/tests/SHOP-T12')
  await page.getByRole('button', { name: /^Run$/ }).click()
  let dialog = page.getByRole('dialog')
  await dialog.locator('[aria-label="Screenshot"]').getByText('Tiap step').click()
  await dialog.locator('[aria-label="Video"]').getByText('Selalu').click()
  await dialog.getByRole('button', { name: 'Jalankan' }).click()
  await expect(page).toHaveURL(/\/runs\/SHOP-R\d+/)
  await expect(page.getByText('Rp 81.000').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('Rp 90.000').first()).toBeVisible()

  // perbaiki expected di editor
  await page.getByRole('link', { name: /SHOP-T12/ }).first().click()
  await page.getByText('testid=grand-total').first().click()
  await fillParam(page, 'Teks', 'Rp 90.000')
  await save(page)

  await page.getByRole('button', { name: /^Run$/ }).click()
  dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: 'Jalankan' }).click()
  await expect(page).toHaveURL(/\/runs\/SHOP-R\d+/)
  await expect(page.getByRole('tab', { name: /Video/ })).toContainText('1', { timeout: 30_000 })
  await expect(page.locator('[role="status"], [aria-live]').filter({ hasText: /Passed/ }).first()).toBeVisible({ timeout: 30_000 })
  await page.getByRole('tab', { name: /Screenshots/ }).click()
  await expect(page.locator('img[src*="mock-artifacts"]').first()).toBeVisible()
})

test('J11: test case manual dibuat, dijalankan, satu step gagal dengan catatan', async ({ page }) => {
  await login(page)
  await page.goto('/p/SHOP/tests/new?execution=manual')
  await page.getByLabel('Judul test case').fill('E2E: cek email konfirmasi')
  await page.getByRole('button', { name: 'Tambah langkah' }).click()
  await fillParam(page, 'Instruksi', 'Buka inbox QA dan cari email konfirmasi pesanan')
  await fillParam(page, 'Expected', 'Email diterima dalam 1 menit')
  await page.getByRole('button', { name: 'Tambah langkah' }).click()
  await fillParam(page, 'Instruksi', 'Klik tautan lacak pesanan di email')
  await save(page)
  await expect(page).toHaveURL(/\/p\/SHOP\/tests\/SHOP-T\d+/)

  await page.getByRole('button', { name: /^Run$/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'Mulai run manual' }).click()
  await expect(page).toHaveURL(/\/runs\/SHOP-R\d+/)

  const decisions = page.getByRole('group', { name: 'Hasil step' })
  await decisions.getByRole('button', { name: /Pass/ }).click()
  await decisions.getByRole('button', { name: /Fail/ }).click()
  await page.getByLabel('Actual result').fill('Tautan mengarah ke halaman 404')
  await page.getByRole('button', { name: 'Selesai', exact: true }).first().click()
  await page.getByRole('dialog').getByRole('button', { name: 'Selesai', exact: true }).click()
  await expect(page.getByText('Tautan mengarah ke halaman 404').first()).toBeVisible()
  await expect(page.locator('[data-status="failed"]').first()).toBeVisible()
})
