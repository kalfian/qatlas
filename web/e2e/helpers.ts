import { expect, type Page } from '@playwright/test'

/**
 * E2E_MODE=mock (default): the SPA on its in-browser mock API (seeded history, run simulator).
 * E2E_MODE=real: a real-mode SPA (E2E_BASE_URL) on the Go backend seeded with `qatlas seed demo`;
 * runs execute with the real runner against demo-target. See scripts/e2e-real.sh.
 */
export const E2E_MODE: 'mock' | 'real' = process.env.E2E_MODE === 'real' ? 'real' : 'mock'
export const isReal = E2E_MODE === 'real'

/** Waiting for a run to reach a state: real runs drive a real browser against demo-target. */
export const RUN_TIMEOUT = isReal ? 120_000 : 30_000

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

/** Percepat simulator run (dev toolbar mode mock). No-op in real mode: there is no toolbar. */
export async function fastSimulation(page: Page) {
  if (isReal) return
  await page.getByRole('button', { name: 'Mock mode dev toolbar' }).click()
  await page.locator('[aria-label="Simulation speed"]').getByText('3×').click()
  await page.keyboard.press('Escape')
}

/* ------------------------------------------------------------------ real mode: API setup */

type RunTarget = { test_case: string } | { flow: string }
interface RunState {
  key: string
  status: string
}

const FINAL = ['passed', 'failed', 'error', 'cancelled']

/**
 * Starts a run through the real API with the page's session (the page must be logged in) and
 * waits until it reaches one of `until` (default: any final status). Returns the run key.
 */
export async function startRunViaApi(page: Page, projectKey: string, target: RunTarget, until: string[] = FINAL): Promise<string> {
  const res = await page.request.post(`/api/v1/projects/${projectKey}/runs`, {
    data: target,
    headers: { 'X-QAtlas-CSRF': '1' },
  })
  expect(res.status(), await res.text()).toBe(202)
  const run = (await res.json()) as RunState
  let status = run.status
  await expect
    .poll(
      async () => {
        const r = await page.request.get(`/api/v1/runs/${run.key}`)
        status = ((await r.json()) as RunState).status
        return until.includes(status) || FINAL.includes(status)
      },
      { timeout: RUN_TIMEOUT, intervals: [1_000] },
    )
    .toBe(true)
  expect(until, `run ${run.key} ended as ${status}`).toContain(status)
  return run.key
}
