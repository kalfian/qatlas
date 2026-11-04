// SHOP test cases from web/src/mocks/seed.ts in runner wire format (run.start `cases[]`), in their
// original Indonesian wording. Used by scripts/smoke.mjs and the integration tests; they run
// against demo-target started with DEMO_LANG=id.

let seq = 0
const S = (action, params = {}) => ({ step_id: `st_${++seq}`, action, timeout_ms: null, continue_on_failure: false, enabled: true, screenshot: false, ...params })

export const SHOP_CASES = {
  login: () => ({
    case_id: 'rc_login',
    continue_on_failure: false,
    vars: { email: 'qa.bot@tokoku.id' },
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/login' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: '{{secret.QA_PASSWORD}}' }),
      S('click', { selector: "role=button[name='Masuk']" }),
      S('expect_url', { value: '/akun', match: 'contains' }),
      S('expect_visible', { selector: 'text=Halo, QA Bot' }),
    ],
  }),
  login_wrong_password: () => ({
    case_id: 'rc_login_wrong',
    vars: { email: 'qa.bot@tokoku.id' },
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/login' }),
      S('fill', { selector: 'label=Email', value: '{{vars.email}}' }),
      S('fill', { selector: 'label=Password', value: 'salah-total-123' }),
      S('click', { selector: "role=button[name='Masuk']" }),
      S('expect_visible', { selector: 'text=Email atau password salah' }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ],
  }),
  logout: () => ({
    case_id: 'rc_logout',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/akun' }),
      S('click', { selector: "role=button[name='Akun saya']" }),
      S('click', { selector: "role=menuitem[name='Keluar']" }),
      S('expect_url', { value: '/login', match: 'contains' }),
    ],
  }),
  search: () => ({
    case_id: 'rc_search',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('fill', { selector: 'placeholder=Cari produk', value: 'kaos polos' }),
      S('press', { key: 'Enter', selector: 'placeholder=Cari produk' }),
      S('wait_for', { selector: 'testid=product-card', state: 'visible' }),
      S('expect_count', { selector: 'testid=product-card', op: 'gte', value: 1 }),
      S('expect_url', { value: 'q=kaos', match: 'contains' }),
    ],
  }),
  category: () => ({
    case_id: 'rc_category',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/kategori' }),
      S('click', { selector: "role=checkbox[name='Pakaian pria']" }),
      S('expect_url', { value: 'kategori=pakaian-pria', match: 'contains' }),
      S('expect_visible', { selector: "role=heading[name='Pakaian pria']" }),
    ],
  }),
  product: () => ({
    case_id: 'rc_product',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/produk/kaos-polos-hitam' }),
      S('expect_visible', { selector: 'testid=product-price' }),
      S('expect_text', { selector: 'testid=product-price', value: 'Rp 90.000', match: 'contains' }),
      S('expect_text', { selector: 'testid=stock-label', value: 'Stok', match: 'contains' }),
    ],
  }),
  add_to_cart: () => ({
    case_id: 'rc_add_to_cart',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/produk/kaos-polos-hitam' }),
      S('select_option', { selector: 'label=Ukuran', label: 'L' }),
      S('click', { selector: "role=button[name='Tambah ke keranjang']" }),
      S('expect_visible', { selector: 'text=Berhasil ditambahkan' }),
      S('expect_text', { selector: 'testid=cart-count', value: '1', match: 'equals' }),
    ],
  }),
  cart_quantity: () => ({
    case_id: 'rc_cart_qty',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/keranjang' }),
      S('fill', { selector: 'label=Jumlah', value: '3' }),
      S('press', { key: 'Tab' }),
      S('expect_value', { selector: 'label=Jumlah', value: '3', match: 'equals' }),
    ],
  }),
  cart_remove: () => ({
    case_id: 'rc_cart_remove',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/keranjang' }),
      S('click', { selector: "role=button[name='Hapus item']" }),
      S('expect_visible', { selector: 'text=Keranjang kamu kosong' }),
    ],
  }),
  checkout_transfer: () => ({
    case_id: 'rc_checkout',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Alamat', value: 'Jl. Merdeka No. 10, Bandung' }),
      S('click', { selector: "role=radio[name='Transfer bank']" }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
      S('expect_visible', { selector: "role=heading[name='Pesanan berhasil']" }),
      S('extract_text', { selector: 'testid=order-id', save_as: 'order_id' }),
    ],
  }),
  voucher: () => ({
    case_id: 'rc_voucher',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('fill', { selector: 'label=Kode voucher', value: 'HEMAT10' }),
      S('click', { selector: "role=button[name='Pakai']" }),
      S('expect_visible', { selector: 'text=Voucher HEMAT10 dipakai' }),
      S('expect_text', { selector: 'testid=grand-total', value: 'Rp 81.000', match: 'equals', timeout_ms: 1500 }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
    ],
  }),
  ewallet: () => ({
    case_id: 'rc_ewallet',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}/checkout' }),
      S('click', { selector: "role=radio[name='E-wallet']" }),
      S('click', { selector: "role=button[name='Bayar sekarang']" }),
      S('expect_url', { value: 'sandbox.pay.tokoku.id', match: 'contains' }),
      S('click', { selector: "role=button[name='Simulasikan sukses']" }),
      S('expect_visible', { selector: "role=heading[name='Pesanan berhasil']" }),
    ],
  }),
  api_products: () => ({
    case_id: 'rc_api_products',
    steps: [
      S('http_request', { method: 'GET', url: '{{env.API_URL}}/v1/products', query: { limit: '10' } }),
      S('expect_status', { value: 200 }),
      S('expect_json', { path: '$.data[0].id', op: 'exists' }),
      S('expect_response_time', { max_ms: 800 }),
    ],
  }),
  api_login: () => ({
    case_id: 'rc_api_login',
    steps: [
      S('http_request', {
        method: 'POST', url: '{{env.API_URL}}/v1/auth/login', body_type: 'json',
        body: '{"email":"qa.bot@tokoku.id","password":"{{secret.QA_PASSWORD}}"}', save: { token: '$.data.token' },
      }),
      S('expect_status', { value: 201 }),
      S('expect_json', { path: '$.data.token', op: 'exists' }),
    ],
  }),
  api_order_then_ui: () => ({
    case_id: 'rc_api_order_ui',
    steps: [
      S('http_request', {
        method: 'POST', url: '{{env.API_URL}}/v1/orders', body_type: 'json',
        headers: { Authorization: 'Bearer {{secret.ADMIN_TOKEN}}' }, body: '{"sku":"KPH-L","qty":1}', save: { order_id: '$.data.id' },
      }),
      S('expect_status', { value: 201 }),
      S('goto', { url: '{{env.BASE_URL}}/akun/pesanan/{{vars.order_id}}' }),
      S('expect_visible', { selector: 'text=Menunggu pembayaran' }),
    ],
  }),
  home: () => ({
    case_id: 'rc_home',
    steps: [
      S('goto', { url: '{{env.BASE_URL}}' }),
      S('expect_title', { value: 'Tokoku', match: 'contains' }),
      S('expect_visible', { selector: "role=navigation[name='Utama']" }),
      S('screenshot', { name: 'beranda', full_page: true }),
    ],
  }),
}

export const DEMO_SECRETS = { QA_PASSWORD: 'Qa-Staging-2026!', ADMIN_TOKEN: 'adm_stg_8f3a' }

export function demoEnv(baseUrl) {
  return { BASE_URL: baseUrl, API_URL: `${baseUrl}/api` }
}

/** Build a run.start message. */
export function runStart({ runId, artifactDir, baseUrl, cases, options = {}, shared = false, stopOnFailure = true, vars = {}, secrets = DEMO_SECRETS }) {
  return {
    type: 'run.start',
    run_id: runId,
    artifact_dir: artifactDir,
    options: {
      browser: 'chromium', headless: true, viewport: { width: 1280, height: 720 },
      screenshot: 'on_failure', video: 'off', step_timeout_ms: 10000, retries: 0, ...options,
    },
    shared_session: shared,
    stop_on_failure: stopOnFailure,
    env: demoEnv(baseUrl),
    secrets,
    vars,
    cases,
  }
}
