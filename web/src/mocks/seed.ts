import type { RunOptions, RunTrigger, Step } from '@/api/types'
import {
  STATE_VERSION,
  type DbEnvironment,
  type DbFlow,
  type DbFolder,
  type DbMember,
  type DbProject,
  type DbTestCase,
  type DbUser,
  type MockState,
} from './db'

import { DEMO_INVITE_TOKEN, DEMO_PASSWORD } from './constants'

export { DEMO_INVITE_TOKEN, DEMO_PASSWORD, GOOGLE_ACCOUNTS } from './constants'

const DAY = 86_400_000

export const DEFAULT_RUN_OPTIONS: RunOptions = {
  browser: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 720 },
  screenshot: 'on_failure',
  video: 'off',
  step_timeout_ms: 10000,
  retries: 0,
}

let stepSeq = 0
const sid = () => `s${(++stepSeq).toString(36)}`
const S = (action: Step['action'], rest: Omit<Step, 'id' | 'action'> = {}): Step => ({ id: sid(), action, ...rest })
const M = (description: string, expected: string): Step => ({ id: sid(), action: 'manual', description, expected })

interface TcSeed {
  folder: string | null
  title: string
  priority: DbTestCase['priority']
  status?: DbTestCase['status']
  execution?: DbTestCase['execution']
  tags: string[]
  description?: string
  preconditions?: string
  variables?: Record<string, string>
  steps: Step[]
}

const loginSteps = (): Step[] => [
  S('goto', { url: '{{env.BASE_URL}}/login', description: 'Buka halaman login' }),
  S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
  S('fill', { selector: 'label=Password', value: '{{secret.QA_PASSWORD}}' }),
  S('click', { selector: "role=button[name='Masuk']" }),
  S('expect_url', { value: '/akun', match: 'contains', description: 'Diarahkan ke halaman akun', expected: 'URL mengandung /akun' }),
  S('expect_visible', { selector: 'text=Halo, QA Bot' }),
]

const SHOP_CASES: TcSeed[] = [
  { folder: 'Auth', title: 'User bisa login dengan email & password', priority: 'high', tags: ['smoke', 'auth'],
    description: 'Login customer dengan kredensial valid dari environment.', preconditions: 'Akun QA Bot sudah terdaftar dan aktif.',
    variables: { email: 'qa.bot@tokoku.id' }, steps: loginSteps() },
  { folder: 'Auth', title: 'Login gagal dengan password salah', priority: 'medium', tags: ['auth', 'negative'],
    variables: { email: 'qa.bot@tokoku.id' },
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/login' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: 'salah-total-123' }),
      S('click', { selector: "role=button[name='Masuk']" }),
      S('expect_visible', { selector: 'text=Email atau password salah', expected: 'Pesan error tampil' }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ] },
  { folder: 'Auth', title: 'Logout menghapus sesi', priority: 'low', tags: ['auth'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/akun' }),
      S('click', { selector: "role=button[name='Akun saya']" }),
      S('click', { selector: "role=menuitem[name='Keluar']" }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ] },
  { folder: 'Auth', title: 'Login dengan OTP SMS', priority: 'high', execution: 'manual', tags: ['auth', 'otp'],
    description: 'OTP dikirim ke nomor HP fisik, tidak bisa diotomasi.', preconditions: 'HP tester terdaftar dengan nomor 0812-0000-1234.',
    steps: [
      M('Buka {{env.BASE_URL}}/login lalu pilih "Masuk dengan nomor HP"', 'Form nomor HP tampil'),
      M('Masukkan nomor 0812-0000-1234 lalu klik "Kirim OTP"', 'SMS OTP diterima dalam < 30 detik'),
      M('Masukkan 6 digit kode OTP dari SMS', 'Masuk ke halaman akun, nama QA Bot tampil'),
      M('Tunggu 5 menit, lalu coba pakai OTP yang sama untuk login lagi', 'Muncul pesan "Kode OTP kedaluwarsa"'),
    ] },
  { folder: 'Katalog', title: 'Cari produk berdasarkan kata kunci', priority: 'high', tags: ['smoke', 'katalog'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('fill', { selector: 'placeholder=Cari produk', value: 'kaos polos' }),
      S('press', { key: 'Enter', selector: 'placeholder=Cari produk' }),
      S('wait_for', { selector: 'testid=product-card', state: 'visible' }),
      S('expect_count', { selector: 'testid=product-card', op: 'gte', value: 1 }),
      S('expect_url', { value: 'q=kaos', match: 'contains' }),
    ] },
  { folder: 'Katalog', title: 'Filter produk berdasarkan kategori', priority: 'medium', tags: ['katalog'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/kategori' }),
      S('click', { selector: "role=checkbox[name='Pakaian pria']" }),
      S('expect_url', { value: 'kategori=pakaian-pria', match: 'contains' }),
      S('expect_visible', { selector: "role=heading[name='Pakaian pria']" }),
    ] },
  { folder: 'Katalog', title: 'Halaman detail produk menampilkan harga & stok', priority: 'medium', tags: ['katalog', 'flaky'],
    description: 'Kadang gagal karena cache CDN di staging belum ter-invalidate.',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/produk/kaos-polos-hitam' }),
      S('expect_visible', { selector: 'testid=product-price' }),
      S('expect_text', { selector: 'testid=product-price', value: 'Rp 90.000', match: 'contains' }),
      S('expect_text', { selector: 'testid=stock-label', value: 'Stok', match: 'contains' }),
    ] },
  { folder: 'Keranjang', title: 'Tambah produk ke keranjang', priority: 'high', tags: ['smoke', 'keranjang'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/produk/kaos-polos-hitam' }),
      S('select_option', { selector: 'label=Ukuran', label: 'L' }),
      S('click', { selector: "role=button[name='Tambah ke keranjang']" }),
      S('expect_visible', { selector: 'text=Berhasil ditambahkan' }),
      S('expect_text', { selector: 'testid=cart-count', value: '1', match: 'equals' }),
    ] },
  { folder: 'Keranjang', title: 'Ubah jumlah item di keranjang', priority: 'medium', tags: ['keranjang'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/keranjang' }),
      S('fill', { selector: 'label=Jumlah', value: '3' }),
      S('press', { key: 'Tab' }),
      S('expect_value', { selector: 'label=Jumlah', value: '3', match: 'equals' }),
    ] },
  { folder: 'Keranjang', title: 'Hapus item dari keranjang', priority: 'low', status: 'draft', tags: ['keranjang'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/keranjang' }),
      S('click', { selector: "role=button[name='Hapus item']" }),
      S('expect_visible', { selector: 'text=Keranjang kamu kosong' }),
    ] },
  { folder: 'Checkout', title: 'Checkout dengan transfer bank', priority: 'critical', tags: ['checkout', 'smoke'],
    preconditions: 'Keranjang berisi minimal 1 item.',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Alamat', value: 'Jl. Merdeka No. 10, Bandung' }),
      S('click', { selector: "role=radio[name='Transfer bank']" }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
      S('expect_visible', { selector: "role=heading[name='Pesanan berhasil']" }),
      S('extract_text', { selector: 'testid=order-id', save_as: 'order_id' }),
    ] },
  { folder: 'Checkout', title: 'Checkout dengan voucher diskon 10%', priority: 'high', tags: ['checkout', 'voucher'],
    description: 'Voucher HEMAT10 seharusnya memotong 10% dari subtotal Rp 90.000.',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Kode voucher', value: 'HEMAT10' }),
      S('click', { selector: "role=button[name='Pakai']" }),
      S('expect_visible', { selector: 'text=Voucher HEMAT10 dipakai' }),
      S('expect_text', { selector: 'testid=grand-total', value: 'Rp 81.000', match: 'equals', description: 'Total setelah diskon', expected: 'Rp 81.000' }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
    ] },
  { folder: 'Pembayaran', title: 'Pembayaran via e-wallet (redirect)', priority: 'high', tags: ['checkout', 'payment'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('click', { selector: "role=radio[name='E-wallet']" }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
      S('expect_url', { value: 'sandbox.pay.tokoku.id', match: 'contains' }),
      S('click', { selector: "role=button[name='Simulasikan sukses']" }),
      S('expect_visible', { selector: "role=heading[name='Pesanan berhasil']" }),
    ] },
  { folder: 'Checkout', title: 'Cek tampilan invoice PDF', priority: 'medium', execution: 'manual', tags: ['checkout', 'visual'],
    steps: [
      M('Buka halaman pesanan terakhir lalu klik "Unduh invoice"', 'File PDF terunduh, nama file berisi nomor order'),
      M('Periksa logo, alamat toko, dan NPWP di header invoice', 'Semua tampil tajam dan sesuai brand guideline'),
      M('Cocokkan subtotal, diskon, ongkir, dan total dengan halaman pesanan', 'Semua angka sama persis'),
    ] },
  { folder: 'API', title: 'GET /products mengembalikan daftar produk', priority: 'high', tags: ['api', 'smoke'],
    steps: [
      S('http_request', { method: 'GET', url: '{{env.API_URL}}/v1/products', query: { limit: '10' } }),
      S('expect_status', { value: 200 }),
      S('expect_json', { path: '$.data[0].id', op: 'exists' }),
      S('expect_response_time', { max_ms: 800 }),
    ] },
  { folder: 'API', title: 'Login API mengembalikan token', priority: 'high', tags: ['api', 'auth'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v1/auth/login', body_type: 'json',
        body: '{"email":"qa.bot@tokoku.id","password":"{{secret.QA_PASSWORD}}"}', save: { token: '$.data.token' } }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.token', op: 'exists' }),
    ] },
  { folder: 'API', title: 'Buat order via API lalu verifikasi di UI', priority: 'medium', tags: ['api', 'checkout'],
    description: 'Contoh test campuran: data dibuat lewat API, diverifikasi lewat browser.',
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v1/orders', body_type: 'json',
        headers: { Authorization: 'Bearer {{secret.ADMIN_TOKEN}}' }, body: '{"sku":"KPH-L","qty":1}', save: { order_id: '$.data.id' } }),
      S('expect_status', { value: 201 }),
      S('goto', { url: '{{env.BASE_URL}}/akun/pesanan/{{vars.order_id}}' }),
      S('expect_visible', { selector: 'text=Menunggu pembayaran' }),
    ] },
  { folder: null, title: 'Halaman beranda tampil tanpa error', priority: 'medium', tags: ['smoke'],
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('expect_title', { value: 'Tokoku', match: 'contains' }),
      S('expect_visible', { selector: "role=navigation[name='Utama']" }),
      S('screenshot', { name: 'beranda', full_page: true }),
    ] },
  { folder: 'Auth', title: 'Reset password lewat email', priority: 'low', status: 'draft', execution: 'manual', tags: ['auth'],
    steps: [
      M('Di halaman login klik "Lupa password", masukkan qa.bot@tokoku.id', 'Muncul pesan "Cek email kamu"'),
      M('Buka email reset di inbox QA lalu klik tautannya', 'Halaman set password baru terbuka'),
    ] },
]

const PAY_CASES: TcSeed[] = [
  { folder: 'Payment intent', title: 'Buat payment intent', priority: 'critical', tags: ['api', 'smoke'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/payment-intents', body_type: 'json',
        headers: { 'X-Api-Key': '{{secret.API_KEY}}' }, body: '{"amount":90000,"currency":"IDR"}', save: { intent_id: '$.data.id' } }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.status', op: 'eq', value: 'requires_payment' }),
    ] },
  { folder: 'Webhook', title: 'Webhook pembayaran sukses', priority: 'high', tags: ['api', 'webhook'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/test/webhooks', body_type: 'json', body: '{"event":"payment.succeeded"}' }),
      S('expect_status', { value: 200 }),
      S('expect_json', { path: '$.delivered', op: 'eq', value: 'true' }),
    ] },
  { folder: 'Refund', title: 'Refund sebagian', priority: 'medium', tags: ['api', 'refund', 'flaky'],
    steps: [
      S('http_request', { method: 'POST', url: '{{env.API_URL}}/v2/refunds', body_type: 'json', body: '{"payment_id":"pay_123","amount":10000}' }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.amount', op: 'eq', value: '10000' }),
    ] },
  { folder: 'Webhook', title: 'Validasi signature callback dari bank', priority: 'medium', execution: 'manual', tags: ['security'],
    steps: [
      M('Kirim callback dari dashboard sandbox bank dengan signature valid', 'Callback diterima, status 200 di log'),
      M('Ubah 1 karakter signature lalu kirim ulang', 'Callback ditolak dengan status 401'),
    ] },
]

/* ------------------------------------------------------------------ builder */

export function buildSeed(): MockState {
  stepSeq = 0
  const now = Date.now()
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()

  const users: DbUser[] = [
    { id: 'u_rina', email: 'rina@tokoku.id', name: 'Rina Kusuma', system_role: 'admin', status: 'active', password: DEMO_PASSWORD, google_linked: true, last_login_at: iso(DAY / 4), created_at: iso(60 * DAY) },
    { id: 'u_dimas', email: 'dimas@tokoku.id', name: 'Dimas Pratama', system_role: 'member', status: 'active', password: DEMO_PASSWORD, google_linked: true, last_login_at: iso(DAY / 2), created_at: iso(55 * DAY) },
    { id: 'u_sari', email: 'sari@tokoku.id', name: 'Sari Wulandari', system_role: 'member', status: 'active', password: DEMO_PASSWORD, google_linked: false, last_login_at: iso(3 * DAY), created_at: iso(40 * DAY) },
    { id: 'u_budi', email: 'budi@tokoku.id', name: 'Budi Santoso', system_role: 'member', status: 'invited', password: null, google_linked: false, last_login_at: null, created_at: iso(DAY) },
    { id: 'u_yoga', email: 'yoga@tokoku.id', name: 'Yoga Firmansyah', system_role: 'member', status: 'disabled', password: DEMO_PASSWORD, google_linked: false, last_login_at: iso(20 * DAY), created_at: iso(50 * DAY) },
  ]

  const projects: DbProject[] = [
    { id: 'p_shop', key: 'SHOP', name: 'Toko Online Web', description: 'Smoke & regression storefront tokoku.id', archived_at: null,
      default_run_options: { ...DEFAULT_RUN_OPTIONS }, artifact_retention_days: 30, created_at: iso(58 * DAY), seq: { case: 0, flow: 0, run: 100 } },
    { id: 'p_pay', key: 'PAY', name: 'Payment API', description: 'Kontrak & integrasi API pembayaran', archived_at: null,
      default_run_options: { ...DEFAULT_RUN_OPTIONS }, artifact_retention_days: 14, created_at: iso(45 * DAY), seq: { case: 0, flow: 0, run: 20 } },
  ]

  const members: DbMember[] = [
    { project_id: 'p_shop', user_id: 'u_rina', role: 'maintainer', added_at: iso(58 * DAY) },
    { project_id: 'p_shop', user_id: 'u_dimas', role: 'editor', added_at: iso(55 * DAY) },
    { project_id: 'p_shop', user_id: 'u_sari', role: 'viewer', added_at: iso(40 * DAY) },
    { project_id: 'p_pay', user_id: 'u_dimas', role: 'maintainer', added_at: iso(45 * DAY) },
    { project_id: 'p_pay', user_id: 'u_sari', role: 'editor', added_at: iso(40 * DAY) },
  ]

  const environments: DbEnvironment[] = [
    { id: 'env_shop_stg', project_id: 'p_shop', name: 'staging', is_default: true,
      variables: { BASE_URL: 'https://staging.tokoku.id', API_URL: 'https://api.staging.tokoku.id' },
      secrets: [
        { name: 'QA_PASSWORD', value: 'Qa-Staging-2026!', updated_at: iso(12 * DAY) },
        { name: 'ADMIN_TOKEN', value: 'adm_stg_8f3a', updated_at: iso(30 * DAY) },
      ], updated_at: iso(12 * DAY) },
    { id: 'env_shop_prod', project_id: 'p_shop', name: 'production', is_default: false,
      variables: { BASE_URL: 'https://tokoku.id', API_URL: 'https://api.tokoku.id' },
      secrets: [{ name: 'QA_PASSWORD', value: 'Qa-Prod-2026!', updated_at: iso(20 * DAY) }], updated_at: iso(20 * DAY) },
    { id: 'env_pay_sbx', project_id: 'p_pay', name: 'sandbox', is_default: true,
      variables: { API_URL: 'https://sandbox.pay.tokoku.id' },
      secrets: [{ name: 'API_KEY', value: 'sk_sbx_123', updated_at: iso(10 * DAY) }], updated_at: iso(10 * DAY) },
  ]

  const folders: DbFolder[] = []
  const folderId = (projectId: string, name: string, parent: string | null = null) => {
    let f = folders.find((x) => x.project_id === projectId && x.name === name)
    if (!f) {
      f = { id: `f_${projectId}_${name.toLowerCase().replace(/\W+/g, '_')}`, project_id: projectId, parent_id: parent, name,
        position: folders.filter((x) => x.project_id === projectId && x.parent_id === parent).length }
      folders.push(f)
    }
    return f.id
  }
  for (const n of ['Auth', 'Katalog', 'Keranjang', 'Checkout', 'API']) folderId('p_shop', n)
  folderId('p_shop', 'Pembayaran', folderId('p_shop', 'Checkout'))
  for (const n of ['Payment intent', 'Webhook', 'Refund']) folderId('p_pay', n)

  const testCases: DbTestCase[] = []
  const makeCases = (project: DbProject, seeds: TcSeed[], authorIds: string[]) => {
    seeds.forEach((c, i) => {
      project.seq.case += 1
      const created = now - (50 - i) * DAY
      testCases.push({
        id: `tc_${project.key.toLowerCase()}_${project.seq.case}`,
        project_id: project.id,
        key: `${project.key}-T${project.seq.case}`,
        folder_id: c.folder ? folderId(project.id, c.folder) : null,
        title: c.title,
        description: c.description ?? '',
        preconditions: c.preconditions ?? '',
        priority: c.priority,
        status: c.status ?? 'ready',
        execution: c.execution ?? 'automated',
        tags: c.tags,
        variables: c.variables ?? {},
        steps: structuredClone(c.steps),
        revision: 1 + (i % 3),
        created_at: new Date(created).toISOString(),
        created_by: authorIds[i % authorIds.length],
        updated_at: new Date(created + (i % 5) * DAY).toISOString(),
        updated_by: authorIds[(i + 1) % authorIds.length],
        deleted_at: null,
      })
    })
  }
  makeCases(projects[0], SHOP_CASES, ['u_rina', 'u_dimas'])
  makeCases(projects[1], PAY_CASES, ['u_dimas', 'u_sari'])

  const revisions = testCases.flatMap((t) =>
    Array.from({ length: t.revision }, (_, r) => ({
      test_case_id: t.id,
      revision: r + 1,
      author_id: r === 0 ? t.created_by : t.updated_by,
      change_note: r === 0 ? 'Dibuat' : r === 1 ? 'Perbaiki selector tombol' : 'Tambah assertion',
      created_at: new Date(Date.parse(t.created_at) + r * DAY).toISOString(),
      snapshot: {
        folder_id: t.folder_id, title: t.title, description: t.description, preconditions: t.preconditions, priority: t.priority,
        status: t.status, execution: t.execution, tags: t.tags, variables: t.variables,
        steps: structuredClone(r + 1 === t.revision ? t.steps : t.steps.slice(0, Math.max(1, t.steps.length - (t.revision - r - 1)))),
      },
    })),
  )

  const tcId = (key: string) => testCases.find((t) => t.key === key)!.id
  const flowItem = (key: string, cof = false) => ({ id: `fi_${key}_${Math.random().toString(36).slice(2, 7)}`, test_case_id: tcId(key), continue_on_failure: cof, enabled: true })
  const flows: DbFlow[] = [
    { id: 'fl_shop_1', project_id: 'p_shop', key: 'SHOP-F1', name: 'Checkout happy path', description: 'Login → keranjang → checkout transfer bank dalam satu sesi browser.',
      tags: ['checkout', 'smoke'], shared_session: true, stop_on_failure: true, variables: { email: 'qa.bot@tokoku.id' },
      items: [flowItem('SHOP-T1'), flowItem('SHOP-T8'), flowItem('SHOP-T11')], revision: 3, created_at: iso(30 * DAY), updated_at: iso(6 * DAY), deleted_at: null },
    { id: 'fl_shop_2', project_id: 'p_shop', key: 'SHOP-F2', name: 'Smoke test harian', description: 'Cek cepat fitur utama setiap pagi.',
      tags: ['smoke'], shared_session: false, stop_on_failure: false, variables: { email: 'qa.bot@tokoku.id' },
      items: ['SHOP-T18', 'SHOP-T1', 'SHOP-T5', 'SHOP-T8', 'SHOP-T15'].map((k) => flowItem(k)), revision: 5, created_at: iso(28 * DAY), updated_at: iso(3 * DAY), deleted_at: null },
    { id: 'fl_shop_3', project_id: 'p_shop', key: 'SHOP-F3', name: 'Regresi checkout + cek invoice manual', description: 'Gabungan automated dan verifikasi manual invoice.',
      tags: ['checkout', 'regression'], shared_session: false, stop_on_failure: true, variables: { email: 'qa.bot@tokoku.id' },
      items: [flowItem('SHOP-T1'), flowItem('SHOP-T8'), flowItem('SHOP-T11'), flowItem('SHOP-T14'), flowItem('SHOP-T3')], revision: 2, created_at: iso(14 * DAY), updated_at: iso(2 * DAY), deleted_at: null },
    { id: 'fl_pay_1', project_id: 'p_pay', key: 'PAY-F1', name: 'Alur pembayaran lengkap', description: 'Intent → webhook → refund.',
      tags: ['api'], shared_session: false, stop_on_failure: true, variables: {},
      items: [flowItem('PAY-T1'), flowItem('PAY-T2'), flowItem('PAY-T3', true)], revision: 1, created_at: iso(20 * DAY), updated_at: iso(20 * DAY), deleted_at: null },
  ]
  projects[0].seq.flow = 3
  projects[1].seq.flow = 1

  return {
    version: STATE_VERSION,
    session: null,
    users,
    invites: [{ token: DEMO_INVITE_TOKEN, user_id: 'u_budi', kind: 'invite', expires_at: iso(-2 * DAY), used_at: null }],
    tokens: [
      { id: 'tok_1', user_id: 'u_rina', name: 'Claude Code laptop', prefix: 'qat_7f2c91ab', scopes: ['read', 'write', 'run'], project_keys: null,
        expires_at: iso(-80 * DAY), last_used_at: iso(DAY / 3), created_at: iso(10 * DAY), revoked_at: null },
      { id: 'tok_2', user_id: 'u_rina', name: 'CI GitHub Actions', prefix: 'qat_b03de4c1', scopes: ['read', 'run'], project_keys: ['SHOP'],
        expires_at: null, last_used_at: iso(DAY), created_at: iso(25 * DAY), revoked_at: null },
    ],
    projects,
    members,
    environments,
    folders,
    testCases,
    revisions,
    flows,
    runs: [],
    artifacts: [],
    sim: { speed: 1 },
  }
}

export interface HistorySpec {
  projectKey: string
  kind: 'test_case' | 'flow'
  target: string
  daysAgo: number
  user: string
  trigger?: RunTrigger
  options?: Partial<RunOptions>
  env?: string
  cancel?: boolean
  infraError?: string
  manual?: { by: string; results: ('passed' | 'failed' | 'blocked' | 'skipped')[]; notes?: string[] } | 'leave-open'
  assignee?: string
}

/** Spesifikasi riwayat run (dieksekusi oleh history.ts memakai simulator). */
export function historySpecs(): HistorySpec[] {
  const specs: HistorySpec[] = []
  const shopCaseTargets = ['SHOP-T1', 'SHOP-T5', 'SHOP-T7', 'SHOP-T8', 'SHOP-T12', 'SHOP-T15', 'SHOP-T16', 'SHOP-T11', 'SHOP-T17', 'SHOP-T2']
  const users = ['u_rina', 'u_dimas']
  const triggers: RunTrigger[] = ['manual', 'manual', 'mcp', 'api', 'manual', 'schedule']
  for (let d = 13; d >= 0; d--) {
    specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F2', daysAgo: d + 0.62, user: 'u_rina', trigger: 'schedule' })
    const n = d % 3 === 0 ? 3 : 2
    for (let k = 0; k < n; k++) {
      const target = shopCaseTargets[(d * 3 + k) % shopCaseTargets.length]
      specs.push({
        projectKey: 'SHOP', kind: 'test_case', target, daysAgo: d + 0.3 - k * 0.07, user: users[(d + k) % 2], trigger: triggers[(d + k) % triggers.length],
        options: (d + k) % 4 === 0 ? { screenshot: 'every_step', video: 'always' } : { screenshot: 'on_failure', video: 'on_failure' },
      })
    }
    if (d % 4 === 1) specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F1', daysAgo: d + 0.2, user: 'u_dimas', options: { video: 'always', screenshot: 'every_step' } })
    if (d % 5 === 2) specs.push({ projectKey: 'PAY', kind: 'flow', target: 'PAY-F1', daysAgo: d + 0.4, user: 'u_dimas', trigger: 'api' })
    if (d % 3 === 1) specs.push({ projectKey: 'PAY', kind: 'test_case', target: 'PAY-T1', daysAgo: d + 0.5, user: 'u_sari', trigger: 'mcp' })
  }
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T5', daysAgo: 5.1, user: 'u_dimas', cancel: true })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T13', daysAgo: 4.2, user: 'u_dimas', infraError: 'Browser webkit gagal diluncurkan: missing dependency libgstcodecparsers-1.0.so.0', options: { browser: 'webkit' } })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T4', daysAgo: 6.3, user: 'u_dimas',
    manual: { by: 'u_dimas', results: ['passed', 'passed', 'passed', 'failed'], notes: ['', '', '', 'OTP lama masih bisa dipakai setelah 5 menit — bug keamanan, dilaporkan ke tim auth.'] } })
  specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F3', daysAgo: 2.4, user: 'u_rina',
    manual: { by: 'u_rina', results: ['passed', 'passed', 'passed'] } })
  // masih terbuka → muncul di "Tugas saya"
  specs.push({ projectKey: 'SHOP', kind: 'flow', target: 'SHOP-F3', daysAgo: 0.08, user: 'u_rina', manual: 'leave-open', assignee: 'u_rina' })
  specs.push({ projectKey: 'SHOP', kind: 'test_case', target: 'SHOP-T4', daysAgo: 0.2, user: 'u_rina', manual: 'leave-open', assignee: 'u_dimas' })
  specs.push({ projectKey: 'PAY', kind: 'test_case', target: 'PAY-T4', daysAgo: 1.1, user: 'u_dimas', manual: 'leave-open', assignee: 'u_rina' })
  return specs.sort((a, b) => b.daysAgo - a.daysAgo)
}
