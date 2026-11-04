import { expect, type Page } from '@playwright/test'

export const PASSWORD = 'password123'
export const USERS = {
  admin: { email: 'rina@tokoku.id', name: 'Rina Kusuma' },
  editor: { email: 'dimas@tokoku.id', name: 'Dimas Pratama' },
  viewer: { email: 'sari@tokoku.id', name: 'Sari Wulandari' },
} as const

export async function login(page: Page, email: string = USERS.admin.email, password = PASSWORD) {
  await page.goto('/login')
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Masuk', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

export async function logout(page: Page, name: string) {
  await page.getByRole('button', { name: `Menu akun ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Keluar' }).click()
  await expect(page).toHaveURL(/\/login/)
}

/** Percepat simulator run (dev toolbar mode mock). */
export async function fastSimulation(page: Page) {
  await page.getByRole('button', { name: 'Dev toolbar mode mock' }).click()
  await page.locator('[aria-label="Kecepatan simulasi"]').getByText('3×').click()
  await page.keyboard.press('Escape')
}
