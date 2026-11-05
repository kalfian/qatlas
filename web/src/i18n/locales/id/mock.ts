import type en from '../en/mock'
import type { Translation } from '../../types'

/** Namespace `mock` (Bahasa Indonesia). Must mirror the English keys. */
export default {
  toolbar: {
    trigger: 'Dev toolbar mode mock',
    button: 'Mock',
    title: 'Mode mock (Phase 1)',
    intro: 'Semua data disimulasikan di browser (MSW + localStorage). Password semua user demo:',
    signInAs: 'Login sebagai',
    speed: 'Kecepatan simulasi run',
    speedLabel: 'Kecepatan simulasi',
    rulesTitle: 'Aturan simulasi',
    ruleFail: 'Parameter step yang mengandung kata <code>fail</code> → step gagal.',
    ruleVoucher: '<code>testid=grand-total</code> bernilai <code>Rp 90.000</code> di aplikasi palsu (test voucher sengaja gagal).',
    ruleFlaky: 'Test bertag <code>flaky</code> gagal acak ±40%.',
    ruleStorage:
      'Storage: endpoint yang mengandung <code>fail</code> atau secret <code>wrong</code> menggagalkan cek koneksi; bucket yang mengandung <code>quota</code> menghentikan pemindahan artifact di 60%.',
    googleEnv: 'Google sign-in diatur environment variable',
    googleEnvHint: 'Mensimulasikan GOOGLE_CLIENT_ID di server: Google sign-in aktif dan Admin → Google sign-in jadi hanya baca.',
    ruleGoogle:
      'Google sign-in: Admin → Google sign-in menerima JSON client Web application apa pun; client Desktop atau <code>client_id</code> di luar <code>apps.googleusercontent.com</code> ditolak.',
    storageEnv: 'Storage diatur environment variable',
    storageEnvHint: 'Mensimulasikan QATLAS_STORAGE di server: Admin → Storage jadi hanya baca.',
    reset: 'Reset data demo',
    resetDone: 'Data demo di-reset',
    switchFailed: 'Gagal ganti user',
    switched: 'Sekarang login sebagai {{name}}',
  },
} satisfies Translation<typeof en>
