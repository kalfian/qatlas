import i18n from 'i18next'
import { initReactI18next, useTranslation } from 'react-i18next'
import * as React from 'react'
import { namespaces, resources } from './resources'
import type { Language } from './types'

export { LANGUAGES, type Language } from './types'

const STORAGE_KEY = 'qatlas.lang'

function initialLanguage(): Language {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'en' || v === 'id') return v
  } catch {
    // abaikan
  }
  return 'en' // default English (keputusan Kalfian 2026-11-04)
}

const startLanguage = initialLanguage()

void i18n.use(initReactI18next).init({
  // Hanya English yang dibundel; bahasa lain ditambahkan oleh ensureLanguage() sebelum dipakai.
  resources,
  lng: startLanguage,
  fallbackLng: 'en',
  ns: namespaces as unknown as string[],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
  showSupportNotice: false,
})

if (typeof document !== 'undefined') document.documentElement.lang = i18n.language

/** Bundle non-English, dimuat sekali saat pertama dibutuhkan (chunk terpisah, ~21 kB gzip untuk `id`). */
const loaders: Record<Exclude<Language, 'en'>, () => Promise<{ default: Record<string, object> }>> = {
  id: () => import('./resources-id'),
}

async function ensureLanguage(lang: Language): Promise<void> {
  if (lang === 'en' || i18n.hasResourceBundle(lang, 'common')) return
  const { default: bundles } = await loaders[lang]()
  for (const [ns, res] of Object.entries(bundles)) i18n.addResourceBundle(lang, ns, res, true, true)
}

/**
 * Selesai saat bahasa awal (localStorage) siap dirender — main.tsx menunggu ini sebelum render pertama agar
 * tidak ada kilasan English. Bila chunk gagal dimuat, UI jatuh ke English (fallbackLng) alih-alih gagal total.
 */
export const i18nReady: Promise<void> = ensureLanguage(startLanguage).catch(async (err) => {
  console.error('[i18n] gagal memuat bahasa', startLanguage, err)
  await i18n.changeLanguage('en')
  if (typeof document !== 'undefined') document.documentElement.lang = 'en'
})

export function currentLanguage(): Language {
  return (i18n.language as Language) === 'id' ? 'id' : 'en'
}

export async function setLanguage(lang: Language) {
  try {
    await ensureLanguage(lang)
  } catch (err) {
    // Chunk bahasa gagal dimuat (offline / deploy baru): tetap di bahasa sekarang, jangan setengah berganti.
    console.error('[i18n] gagal memuat bahasa', lang, err)
    return
  }
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    // abaikan
  }
  document.documentElement.lang = lang
  await i18n.changeLanguage(lang)
}

/** Bahasa aktif + setter (re-render saat berubah). */
export function useLanguage(): [Language, (l: Language) => Promise<void>] {
  const { i18n: inst } = useTranslation()
  const lang = (inst.language === 'id' ? 'id' : 'en') as Language
  return [lang, React.useCallback((l: Language) => setLanguage(l), [])]
}

export { i18n }
