import type en from '../en/projects'
import type { Translation } from '../../types'

/** Namespace `projects` (Bahasa Indonesia). Must mirror the English keys. */
export default {
  title: 'Project',
  descriptionCount_one: '{{count}} project yang bisa kamu akses.',
  descriptionCount_other: '{{count}} project yang bisa kamu akses.',
  description: 'Project yang bisa kamu akses.',
  create: 'Buat project',
  emptyAdminTitle: 'Belum ada project',
  emptyAdminDescription: 'Buat project pertama untuk mulai menyusun test case dan flow.',
  emptyMemberTitle: 'Kamu belum jadi member project mana pun.',
  emptyMemberDescription: 'Minta maintainer project menambahkanmu.',
  col: {
    key: 'Key',
    project: 'Project',
    testCases: 'Test case',
    lastRun: 'Run terakhir',
    passRate: 'Pass rate 7 hari',
  },
  listLabel: 'Daftar project',
  noDescription: 'Tanpa deskripsi',
  testCase_one: 'test case',
  testCase_other: 'test case',
  noRuns: 'Belum ada run',
  passRateSr: 'Pass rate 7 hari:',
  dialog: {
    title: 'Buat project',
    description: 'Kamu otomatis jadi maintainer. Environment “staging” dibuat sebagai default.',
    name: 'Nama',
    key: 'Key',
    keyHint: 'Jadi awalan semua ID, mis. <code>{{key}}-T1</code> dan <code>{{key}}-R1</code>. Tidak bisa diubah setelah dibuat.',
    keyRule: '2–10 karakter huruf besar atau angka, diawali huruf.',
    descriptionLabel: 'Deskripsi',
    submit: 'Buat project',
    created: 'Project {{key}} dibuat',
    nameRequired: 'Isi nama project',
    keyRequired: 'Isi key project',
    keyStartLetter: 'Key harus diawali huruf',
    keyMin: 'Minimal 2 karakter',
    keyFormat: 'Hanya huruf besar dan angka, 2–10 karakter',
  },
} satisfies Translation<typeof en>
