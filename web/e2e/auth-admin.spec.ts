import { expect, test } from '@playwright/test'
import { isReal, login, logout, USERS } from './helpers'

test('J1: admin membuat user, menyalin link undangan, user set password lalu login', async ({ page }) => {
  await login(page)
  await page.goto('/admin/users')
  await page.getByRole('button', { name: 'Create user' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Email').fill('nina@tokoku.id')
  await dialog.getByLabel('Name').fill('Nina Lestari')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  const inviteInput = dialog.locator('#invite-url')
  await expect(inviteInput).toHaveValue(/\/invite\//)
  const inviteUrl = new URL(await inviteInput.inputValue())
  await page.keyboard.press('Escape')

  await logout(page, USERS.admin.name)
  await page.goto(inviteUrl.pathname)
  await expect(page.getByText('nina@tokoku.id')).toBeVisible()
  await page.getByLabel('Password', { exact: true }).fill('rahasia-nina-123')
  await page.getByLabel('Repeat password').fill('rahasia-nina-123')
  await page.getByRole('button', { name: 'Create password & sign in' }).click()
  await expect(page).not.toHaveURL(/\/invite\//)

  await logout(page, 'Nina Lestari')
  await login(page, 'nina@tokoku.id', 'rahasia-nina-123')
  await expect(page.getByRole('button', { name: 'Account menu for Nina Lestari' })).toBeVisible()
})

test('J2: login Google dengan email yang tidak terdaftar ditolak', async ({ page }) => {
  test.skip(isReal, 'Google sign-in is simulated by the mock only')
  await page.goto('/login')
  await page.getByRole('button', { name: 'Continue with Google' }).click()
  await page.getByRole('dialog').getByText('tamu.luar@gmail.com').click()
  await expect(page.getByRole('alert')).toContainText("isn't registered")
  await expect(page).toHaveURL(/\/login/)
})

test('J9: buat API token, lihat snippet MCP, lalu cabut', async ({ page }) => {
  await login(page)
  await page.goto('/settings/tokens')
  await page.getByRole('button', { name: 'Create token' }).first().click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Name', { exact: true }).fill('E2E laptop')
  await dialog.getByRole('button', { name: 'Create token' }).click()
  await expect(dialog.getByLabel('Token', { exact: true })).toHaveValue(/^qat_[0-9a-f]{8}_[0-9a-f]+$/)
  await expect(dialog.getByText(/claude mcp add --transport http qatlas/).first()).toBeVisible()
  await dialog.getByRole('button', { name: 'Copy', exact: true }).click()
  await dialog.getByRole('button', { name: "I've copied it" }).click()

  await page.getByRole('button', { name: 'Revoke token E2E laptop' }).first().click()
  await page.getByRole('alertdialog').getByRole('button', { name: /Revoke/ }).click()
  await expect(page.getByText(/Revoked/).first()).toBeVisible()
})
