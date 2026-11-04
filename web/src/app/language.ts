import * as React from 'react'
import { toast } from 'sonner'
import { errorMessage } from '@/api/client'
import { useUpdateMe } from '@/api/queries'
import { currentLanguage, i18n, setLanguage, useLanguage, type Language } from '@/i18n'

/**
 * Ganti bahasa UI: diterapkan langsung (optimistic), lalu disimpan ke profil lewat PATCH /me { locale }.
 * Bila gagal disimpan, UI tetap di bahasa baru untuk sesi ini dan user diberi tahu.
 */
export function useChangeLanguage() {
  const [language] = useLanguage()
  const { mutate, isPending, isSuccess } = useUpdateMe()
  const change = React.useCallback(
    async (lng: Language) => {
      if (lng === currentLanguage()) return
      await setLanguage(lng)
      mutate(
        { locale: lng },
        { onError: (err) => toast.error(i18n.t('nav:topbar.languageSaveFailed', { message: errorMessage(err) })) },
      )
    },
    [mutate],
  )
  return { language, change, isPending, isSaved: isSuccess }
}

let syncedUserId: string | null = null

/**
 * Sekali per user, sebelum shell dirender (dipanggil di `beforeLoad` route `_app`, yaitu route milik AppShell):
 * bila locale profil beda dengan bahasa tersimpan di browser, pakai locale profil. Dijalankan sebelum render
 * agar tidak ada kilasan bahasa yang salah dan semua komponen langsung membaca bahasa yang benar.
 * Berjalan lagi hanya bila user berganti (login ulang / ganti user di dev toolbar), jadi pilihan bahasa
 * di sesi berjalan tidak ditimpa oleh data `me` lama.
 */
export async function applyUserLanguageOnce(user: { id: string; locale?: Language | null }) {
  if (syncedUserId === user.id) return
  syncedUserId = user.id
  if (user.locale && user.locale !== currentLanguage()) await setLanguage(user.locale)
}
