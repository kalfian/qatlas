/** Mode API: `mock` (MSW, Phase 1) atau `real` (backend Go, Phase 2+). Default mock. */
export const API_MODE: 'mock' | 'real' = import.meta.env.VITE_API_MODE === 'real' ? 'real' : 'mock'
export const IS_MOCK = API_MODE === 'mock'

const LAST_PROJECT_KEY = 'qatlas.lastProject'

export function rememberProject(key: string) {
  try {
    localStorage.setItem(LAST_PROJECT_KEY, key)
  } catch {
    // abaikan
  }
}

export function lastProject(): string | null {
  try {
    return localStorage.getItem(LAST_PROJECT_KEY)
  } catch {
    return null
  }
}
