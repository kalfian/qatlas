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
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  await expect(page).not.toHaveURL(/\/login/)
}

export async function logout(page: Page, name: string) {
  await page.getByRole('button', { name: `Account menu for ${name}` }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login/)
}

/** Percepat simulator run (dev toolbar mode mock). */
export async function fastSimulation(page: Page) {
  await page.getByRole('button', { name: 'Mock mode dev toolbar' }).click()
  await page.locator('[aria-label="Simulation speed"]').getByText('3×').click()
  await page.keyboard.press('Escape')
}
