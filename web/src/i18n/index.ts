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

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLanguage(),
  fallbackLng: 'en',
  ns: namespaces as unknown as string[],
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnNull: false,
})

if (typeof document !== 'undefined') document.documentElement.lang = i18n.language

export function currentLanguage(): Language {
  return (i18n.language as Language) === 'id' ? 'id' : 'en'
}

export async function setLanguage(lang: Language) {
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
