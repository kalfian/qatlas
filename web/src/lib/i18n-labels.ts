import { i18n, type Language } from '@/i18n'

/**
 * Helpers for translated copy that lives in plain (non-React) modules — label maps, catalogs, validators.
 * Values are read through i18next on every access, so they follow the active language without changing
 * the exported shapes (`Record<K, string>`, `label: string`).
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string

/**
 * Untyped `i18n.t` for keys built at runtime (e.g. `steps:actions.${action}.label`).
 * Keys are covered by tests that assert every catalog entry resolves in both languages.
 */
export const tr: Translate = (key, options) => (i18n.t as unknown as Translate)(key, options)

/** Translator pinned to one language (e.g. the mock API answers in English like the Go backend). */
export function translatorFor(lng?: Language): Translate {
  return lng ? (key, options) => tr(key, { ...options, lng }) : tr
}

/** Record whose values are translated lazily on read: `labels.passed` → `i18n.t('status:passed')`. */
export function lazyLabels<K extends string>(keys: readonly K[], keyOf: (k: K) => string): Record<K, string> {
  const out = {} as Record<K, string>
  for (const k of keys) Object.defineProperty(out, k, { enumerable: true, get: () => tr(keyOf(k)) })
  return out
}
