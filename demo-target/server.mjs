// Tokoku — a tiny fake shop used as the target app for QAtlas runner tests and demos.
// Dependency-free: Node's http module, server-rendered HTML, one CSS and one JS file.
// State lives in memory (sessions keyed by cookie, orders, API tokens) and resets on restart.
//
//   PORT=8099 node server.mjs          (PORT=0 picks a free port; the chosen URL is printed)
//   DEMO_LANG=en|id                    language of pages, paths and catalog (default en). `en`
//                                      matches the QAtlas demo seed (web mock, `qatlas seed demo`);
//                                      `id` is the original Indonesian shop (runner tests).
//   DEMO_QA_PASSWORD=…                 password of qa.bot@tokoku.id (default Qa-Staging-2026!)
//   DEMO_ADMIN_TOKEN=…                 static bearer token accepted by the API (default adm_stg_8f3a)
//   DEMO_TOTP_SEED=…                   base32 TOTP seed of qa.2fa@tokoku.id (default TOKOKU2FADEMOSEEDQATLASTOTPDEMOA,
//                                      a public demo-only value — never reuse it for anything real)
//   DEMO_SMTP_HOST / DEMO_SMTP_PORT    SMTP server for sign-up emails (default 127.0.0.1:1025, e.g. Mailpit)
//   DEMO_PUBLIC_URL=…                  base URL used in email links (default http://localhost:<port>)
//   DEMO_MAIL_DELAY_MS=…               delivery delay of sign-up emails like a mail queue (default 1500;
//                                      0 = deliver before the "Check your email" page)
//   DEMO_API_KEY=…                     X-Api-Key of the Tokoku Pay API /api/v2 (default demo_pay_key_123)
//   DEMO_REFUND_DELAY_MS=…             a refund stays "pending" this long, then "succeeded" (default 2000)
//   DEMO_WEBHOOK_SECRET=…              HMAC key of POST /api/v2/test/webhooks signatures (default whsec_demo_123)
//   DEMO_RATE_LIMIT=…                  API reads (GET) per client per minute (default 600)
//
// REST API (JSON, X-Request-Id on every response): /api/v1 = Tokoku shop (bearer tokens from
// POST /api/v1/auth/login), /api/v2 = Tokoku Pay (X-Api-Key). See README.md "JSON API".
//
// INTENTIONAL BUG: the voucher HEMAT10 is shown as applied, but the grand total ignores the
// discount (see renderCheckout). The seeded "voucher" test case is meant to fail on it.

import { createServer } from 'node:http'
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { connect as netConnect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8099)
const HOST = process.env.HOST ?? '127.0.0.1'
const QA_PASSWORD = process.env.DEMO_QA_PASSWORD ?? 'Qa-Staging-2026!'
const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN ?? 'adm_stg_8f3a'
const LANG = (process.env.DEMO_LANG ?? 'en').toLowerCase() === 'id' ? 'id' : 'en'
// Demo-only TOTP seed (base32, 160 bit). It is published in the README and the QAtlas demo seed;
// it protects nothing. Override with DEMO_TOTP_SEED.
const DEMO_TOTP_SEED_DEFAULT = 'TOKOKU2FADEMOSEEDQATLASTOTPDEMOA'
const TOTP_SEED = process.env.DEMO_TOTP_SEED || DEMO_TOTP_SEED_DEFAULT
const SMTP_HOST = process.env.DEMO_SMTP_HOST || '127.0.0.1'
const SMTP_PORT = Number(process.env.DEMO_SMTP_PORT || 1025)
let PUBLIC_URL = (process.env.DEMO_PUBLIC_URL ?? '').replace(/\/+$/, '') // set after listen when empty
const MAIL_DELAY_MS = Math.max(0, Number(process.env.DEMO_MAIL_DELAY_MS ?? 1500) || 0)
// Demo-only API key of the Pay API (documented, protects nothing). Override with DEMO_API_KEY.
const API_KEY = process.env.DEMO_API_KEY || 'demo_pay_key_123'
const REFUND_DELAY_MS = Math.max(0, Number(process.env.DEMO_REFUND_DELAY_MS ?? 2000) || 0)
const WEBHOOK_SECRET = process.env.DEMO_WEBHOOK_SECRET || 'whsec_demo_123'
const RATE_LIMIT = Math.max(1, Number(process.env.DEMO_RATE_LIMIT ?? 600) || 600)

/** Registered accounts. `totp` = base32 seed → password login asks for an authentication code. */
const USERS = [
  { email: 'qa.bot@tokoku.id', name: 'QA Bot', password: QA_PASSWORD },
  { email: 'qa.2fa@tokoku.id', name: 'QA 2FA', password: QA_PASSWORD, totp: TOTP_SEED },
]

/* ------------------------------------------------------------------ locale */

// Paths, catalog and texts per language. Test cases select by these labels, so keep them stable:
// `en` mirrors web/src/mocks/seed.ts (= backend/internal/seed/demo.json), `id` mirrors
// runner/scripts/shop-cases.mjs.
const LOCALES = {
  en: {
    paths: {
      search: '/search', category: '/categories', categoryParam: 'category', product: '/products', addedParam: 'added',
      account: '/account', accountOrders: '/account/orders', cart: '/cart', cartAdd: '/cart/add', cartUpdate: '/cart/update',
      cartRemove: '/cart/remove', orderSuccess: (id) => `/orders/${id}/success`, orderSuccessRe: /^\/orders\/([\w-]+)\/success$/,
    },
    categories: [
      { slug: 'menswear', name: 'Menswear' },
      { slug: 'ladieswear', name: 'Ladieswear' },
      { slug: 'accessories', name: 'Accessories' },
    ],
    products: [
      { id: 'p_1', code: 'PBT', slug: 'plain-black-tee', name: 'Plain Black Tee', price: 90000, stock: 12, category: 'menswear' },
      { id: 'p_2', code: 'PWT', slug: 'plain-white-tee', name: 'Plain White Tee', price: 85000, stock: 7, category: 'menswear' },
      { id: 'p_3', code: 'PFS', slug: 'plaid-flannel-shirt', name: 'Plaid Flannel Shirt', price: 175000, stock: 4, category: 'menswear' },
      { id: 'p_4', code: 'LBL', slug: 'linen-blouse', name: 'Linen Blouse', price: 150000, stock: 9, category: 'ladieswear' },
      { id: 'p_5', code: 'BBC', slug: 'baseball-cap', name: 'Baseball Cap', price: 60000, stock: 20, category: 'accessories' },
      { id: 'p_6', code: 'CVT', slug: 'canvas-tote', name: 'Canvas Tote', price: 120000, stock: 0, category: 'accessories' },
    ],
    t: {
      htmlLang: 'en', nav: 'Main', menu: 'Menu', sizeChart: 'Size chart', chest: 'Chest (cm)', length: 'Length (cm)',
      shoulder: 'Shoulder (cm)', sleeve: 'Sleeve (cm)', fit: 'Fit', fits: { S: 'Slim', M: 'Regular', L: 'Regular', XL: 'Relaxed' },
      home: 'Home', categories: 'Categories', cart: 'Cart', searchPlaceholder: 'Search products',
      searchLabel: 'Keyword', myAccount: 'My account', accountMenu: 'Account menu', loginToAccount: 'Log in to your account',
      logout: 'Log out', footer: 'Tokoku demo — a fake shop for testing QAtlas.', notFoundProducts: 'No products found.',
      homeTitle: 'Tokoku — Everyday savings', welcome: 'Welcome to Tokoku', tagline: 'T-shirts, shirts and accessories at friendly prices.',
      featured: 'Featured products', searchTitle: (q) => `Search "${q}" — Tokoku`, searchResults: 'Search results',
      resultsFor: (n, q) => `${n} products for "${q}"`, allCategories: 'All categories', categoryTitle: 'Categories — Tokoku',
      filterCategories: 'Filter categories', apply: 'Apply', stock: (n) => `Stock: ${n}`, outOfStock: 'Out of stock',
      addedToCart: 'Added to cart', size: 'Size', addToCart: 'Add to cart', sizeOf: (z) => `Size ${z}`, quantity: 'Quantity',
      removeItem: 'Remove item', subtotal: 'Subtotal', toCheckout: 'Continue to checkout', cartEmpty: 'Your cart is empty',
      startShopping: 'Start shopping', cartTitle: 'Cart — Tokoku', voucherCode: 'Voucher code', applyVoucher: 'Apply',
      address: 'Address', addressPlaceholder: 'Leave empty to use the account address', paymentMethod: 'Payment method',
      payNow: 'Pay now', orderSummary: 'Order summary', summary: 'Summary', discount: 'Discount', total: 'Total',
      loginTitle: 'Log in — Tokoku', login: 'Log in', wrongCredentials: 'Incorrect email or password', accountTitle: 'Account — Tokoku',
      hello: (name) => `Hi, ${name}`, myOrders: 'My orders', noOrders: 'No orders yet.', orderTitle: (id) => `Order ${id} — Tokoku`,
      order: (id) => `Order ${id}`, status: 'Status', payment: 'Payment', orderPlaced: 'Order placed', orderPlacedTitle: 'Order placed — Tokoku',
      orderNumber: 'Order number', transferHint: (total) => `Please transfer ${total} to BCA 123-456-7890 (PT Tokoku Demo).`,
      orderDetails: 'View order details', gatewayOrder: (id, total) => `Order ${id}, total ${total}`, simulateSuccess: 'Simulate success',
      simulateFailure: 'Simulate failure', notFoundTitle: 'Not found — Tokoku', pageNotFound: 'Page not found', backHome: 'Back to home',
      voucherApplied: (code) => `Voucher ${code} applied`, voucherInvalid: 'Invalid voucher code', defaultAddress: 'Account main address',
      status_awaiting_payment: 'Awaiting payment', status_paid: 'Paid', payment_transfer_bank: 'Bank transfer', payment_ewallet: 'E-wallet',
      // sign-up + email verification, 2FA
      createAccountLink: 'Create an account', signupTitle: 'Create account — Tokoku', signup: 'Create account', name: 'Name',
      passwordHint: 'At least 8 characters.', createAccount: 'Create account', alreadyHaveAccount: 'Already have an account?',
      signupInvalid: 'Enter your name, a valid email address and a password of at least 8 characters.',
      emailTaken: 'An account with this email already exists.', checkEmailTitle: 'Check your email — Tokoku', checkEmail: 'Check your email',
      checkEmailText: (email) => `We sent a verification link and a 6-digit code to ${email}. The link and the code expire in 30 minutes.`,
      codeAlternative: 'No link? Enter the code from the email instead.', verificationCode: 'Verification code', verify: 'Verify',
      invalidVerificationCode: 'Invalid verification code', verifiedTitle: 'Email verified — Tokoku', emailVerified: 'Email verified',
      verifiedText: (email) => `${email} is confirmed and your account is active. You can log in now.`,
      linkInvalidTitle: 'Link expired — Tokoku', linkInvalid: 'This verification link is invalid or has expired',
      linkInvalidText: 'Sign up again to get a new email.', signupAgain: 'Sign up again',
      mailFailedTitle: 'Email not sent — Tokoku', mailFailed: "We couldn't send the verification email",
      mailFailedText: (server, reason) => `The mail server ${server} did not accept the message (${reason}). Start Mailpit (scripts/demo-server.sh does) or set DEMO_SMTP_HOST / DEMO_SMTP_PORT, then sign up again.`,
      mailSubject: 'Verify your Tokoku account', mailHi: (name) => `Hi ${name},`, mailIntro: 'Welcome to Tokoku! Confirm your email address to activate your account.',
      mailCode: (code) => `Your verification code is ${code}`, mailLinkIntro: 'Or open this link:', mailButton: 'Verify my email',
      mailExpiry: 'The code and the link expire in 30 minutes. If you did not sign up, ignore this email.',
      twoFaTitle: 'Two-factor authentication — Tokoku', twoFa: 'Two-factor authentication',
      twoFaText: 'Enter the 6-digit code from your authenticator app.', authCode: 'Authentication code',
      invalidAuthCode: 'Invalid authentication code', twoFaOn: 'Two-factor authentication: on',
    },
  },
  id: {
    paths: {
      search: '/cari', category: '/kategori', categoryParam: 'kategori', product: '/produk', addedParam: 'ditambahkan',
      account: '/akun', accountOrders: '/akun/pesanan', cart: '/keranjang', cartAdd: '/keranjang/tambah', cartUpdate: '/keranjang/ubah',
      cartRemove: '/keranjang/hapus', orderSuccess: (id) => `/pesanan/${id}/berhasil`, orderSuccessRe: /^\/pesanan\/([\w-]+)\/berhasil$/,
    },
    categories: [
      { slug: 'pakaian-pria', name: 'Pakaian pria' },
      { slug: 'pakaian-wanita', name: 'Pakaian wanita' },
      { slug: 'aksesoris', name: 'Aksesoris' },
    ],
    products: [
      { id: 'p_1', code: 'KPH', slug: 'kaos-polos-hitam', name: 'Kaos Polos Hitam', price: 90000, stock: 12, category: 'pakaian-pria' },
      { id: 'p_2', code: 'KPP', slug: 'kaos-polos-putih', name: 'Kaos Polos Putih', price: 85000, stock: 7, category: 'pakaian-pria' },
      { id: 'p_3', code: 'KFK', slug: 'kemeja-flanel-kotak', name: 'Kemeja Flanel Kotak', price: 175000, stock: 4, category: 'pakaian-pria' },
      { id: 'p_4', code: 'BLN', slug: 'blus-linen', name: 'Blus Linen', price: 150000, stock: 9, category: 'pakaian-wanita' },
      { id: 'p_5', code: 'TPB', slug: 'topi-baseball', name: 'Topi Baseball', price: 60000, stock: 20, category: 'aksesoris' },
      { id: 'p_6', code: 'TSK', slug: 'tas-kanvas', name: 'Tas Kanvas', price: 120000, stock: 0, category: 'aksesoris' },
    ],
    t: {
      htmlLang: 'id', nav: 'Utama', menu: 'Menu', sizeChart: 'Tabel ukuran', chest: 'Lebar dada (cm)', length: 'Panjang (cm)',
      shoulder: 'Bahu (cm)', sleeve: 'Lengan (cm)', fit: 'Potongan', fits: { S: 'Ramping', M: 'Reguler', L: 'Reguler', XL: 'Longgar' },
      home: 'Beranda', categories: 'Kategori', cart: 'Keranjang', searchPlaceholder: 'Cari produk',
      searchLabel: 'Kata kunci', myAccount: 'Akun saya', accountMenu: 'Menu akun', loginToAccount: 'Masuk ke akun',
      logout: 'Keluar', footer: 'Tokoku demo — toko palsu untuk menguji QAtlas.', notFoundProducts: 'Produk tidak ditemukan.',
      homeTitle: 'Tokoku — Belanja hemat setiap hari', welcome: 'Selamat datang di Tokoku', tagline: 'Kaos, kemeja, dan aksesoris dengan harga bersahabat.',
      featured: 'Produk pilihan', searchTitle: (q) => `Cari "${q}" — Tokoku`, searchResults: 'Hasil pencarian',
      resultsFor: (n, q) => `${n} produk untuk "${q}"`, allCategories: 'Semua kategori', categoryTitle: 'Kategori — Tokoku',
      filterCategories: 'Filter kategori', apply: 'Terapkan', stock: (n) => `Stok: ${n}`, outOfStock: 'Stok habis',
      addedToCart: 'Berhasil ditambahkan ke keranjang', size: 'Ukuran', addToCart: 'Tambah ke keranjang', sizeOf: (z) => `Ukuran ${z}`, quantity: 'Jumlah',
      removeItem: 'Hapus item', subtotal: 'Subtotal', toCheckout: 'Lanjut ke checkout', cartEmpty: 'Keranjang kamu kosong',
      startShopping: 'Mulai belanja', cartTitle: 'Keranjang — Tokoku', voucherCode: 'Kode voucher', applyVoucher: 'Pakai',
      address: 'Alamat', addressPlaceholder: 'Kosongkan untuk memakai alamat utama akun', paymentMethod: 'Metode pembayaran',
      payNow: 'Bayar sekarang', orderSummary: 'Ringkasan pesanan', summary: 'Ringkasan', discount: 'Diskon', total: 'Total',
      loginTitle: 'Masuk — Tokoku', login: 'Masuk', wrongCredentials: 'Email atau password salah', accountTitle: 'Akun — Tokoku',
      hello: (name) => `Halo, ${name}`, myOrders: 'Pesanan saya', noOrders: 'Belum ada pesanan.', orderTitle: (id) => `Pesanan ${id} — Tokoku`,
      order: (id) => `Pesanan ${id}`, status: 'Status', payment: 'Pembayaran', orderPlaced: 'Pesanan berhasil', orderPlacedTitle: 'Pesanan berhasil — Tokoku',
      orderNumber: 'Nomor pesanan', transferHint: (total) => `Silakan transfer ${total} ke BCA 123-456-7890 a.n. PT Tokoku Demo.`,
      orderDetails: 'Lihat detail pesanan', gatewayOrder: (id, total) => `Pesanan ${id}, total ${total}`, simulateSuccess: 'Simulasikan sukses',
      simulateFailure: 'Simulasikan gagal', notFoundTitle: 'Tidak ditemukan — Tokoku', pageNotFound: 'Halaman tidak ditemukan', backHome: 'Kembali ke beranda',
      voucherApplied: (code) => `Voucher ${code} dipakai`, voucherInvalid: 'Kode voucher tidak valid', defaultAddress: 'Alamat utama akun',
      status_awaiting_payment: 'Menunggu pembayaran', status_paid: 'Lunas', payment_transfer_bank: 'Transfer bank', payment_ewallet: 'E-wallet',
      // daftar + verifikasi email, 2FA
      createAccountLink: 'Buat akun', signupTitle: 'Buat akun — Tokoku', signup: 'Buat akun', name: 'Nama',
      passwordHint: 'Minimal 8 karakter.', createAccount: 'Buat akun', alreadyHaveAccount: 'Sudah punya akun?',
      signupInvalid: 'Isi nama, alamat email yang valid, dan password minimal 8 karakter.',
      emailTaken: 'Akun dengan email ini sudah ada.', checkEmailTitle: 'Cek email kamu — Tokoku', checkEmail: 'Cek email kamu',
      checkEmailText: (email) => `Kami mengirim link verifikasi dan kode 6 digit ke ${email}. Link dan kode berlaku 30 menit.`,
      codeAlternative: 'Tidak ada link? Masukkan kode dari email.', verificationCode: 'Kode verifikasi', verify: 'Verifikasi',
      invalidVerificationCode: 'Kode verifikasi salah', verifiedTitle: 'Email terverifikasi — Tokoku', emailVerified: 'Email terverifikasi',
      verifiedText: (email) => `${email} sudah dikonfirmasi dan akunmu aktif. Silakan masuk.`,
      linkInvalidTitle: 'Link kedaluwarsa — Tokoku', linkInvalid: 'Link verifikasi tidak valid atau sudah kedaluwarsa',
      linkInvalidText: 'Daftar lagi untuk mendapatkan email baru.', signupAgain: 'Daftar lagi',
      mailFailedTitle: 'Email tidak terkirim — Tokoku', mailFailed: 'Email verifikasi gagal dikirim',
      mailFailedText: (server, reason) => `Server email ${server} tidak menerima pesan (${reason}). Jalankan Mailpit (scripts/demo-server.sh menjalankannya) atau atur DEMO_SMTP_HOST / DEMO_SMTP_PORT, lalu daftar lagi.`,
      mailSubject: 'Verifikasi akun Tokoku kamu', mailHi: (name) => `Halo ${name},`, mailIntro: 'Selamat datang di Tokoku! Konfirmasi alamat email kamu untuk mengaktifkan akun.',
      mailCode: (code) => `Kode verifikasi kamu adalah ${code}`, mailLinkIntro: 'Atau buka link ini:', mailButton: 'Verifikasi email saya',
      mailExpiry: 'Kode dan link berlaku 30 menit. Abaikan email ini jika kamu tidak mendaftar.',
      twoFaTitle: 'Verifikasi dua langkah — Tokoku', twoFa: 'Verifikasi dua langkah',
      twoFaText: 'Masukkan kode 6 digit dari aplikasi authenticator.', authCode: 'Kode autentikasi',
      invalidAuthCode: 'Kode autentikasi salah', twoFaOn: 'Verifikasi dua langkah: aktif',
    },
  },
}

const { paths: P, categories: CATEGORIES, products: PRODUCTS, t: T } = LOCALES[LANG]
const SIZES = ['S', 'M', 'L', 'XL']
const VOUCHERS = { HEMAT10: 10 }
const DEMO_CART_SKU = `${PRODUCTS[0].code}-L`

const STATIC = {
  '/static/style.css': { type: 'text/css; charset=utf-8', body: readFileSync(join(ROOT, 'public/style.css')) },
  '/static/app.js': { type: 'text/javascript; charset=utf-8', body: readFileSync(join(ROOT, 'public/app.js')) },
}

/* ------------------------------------------------------------------ state */

/** sid → { user: User|null, cart: {sku, qty}[], voucher: string|null, flash: string|null } */
const sessions = new Map()
/** id → order */
const orders = new Map()
/** API bearer tokens issued by POST /api/v1/auth/login: token → { user, expiresAt } */
const apiTokens = new Map()
/** Products created through the API, per bearer token (tests don't see each other's): token → Map(id → product) */
const tokenProducts = new Map()
/** Tokoku Pay: id → payment intent / refund */
const paymentIntents = new Map()
const refunds = new Map()
/** Rate-limit windows of API reads: client → { start, count } */
const rateWindows = new Map()

function newSession() {
  // Every new visitor starts with a demo cart (1× the first product — Plain Black Tee / Kaos Polos
  // Hitam — size L) so that cart and checkout test cases can run on their own, without a
  // preceding "add to cart" case.
  return { user: null, cart: [{ sku: DEMO_CART_SKU, qty: 1 }], voucher: null, flash: null }
}

function productBySku(sku) {
  const [code, size] = String(sku).split('-')
  const product = PRODUCTS.find((p) => p.code === code)
  return product && SIZES.includes(size) ? { product, size } : null
}

function newOrderId() {
  let id
  do id = `ORD-${randomInt(100000, 999999)}`
  while (orders.has(id))
  return id
}

function createOrder({ items, address, payment, voucher, source }) {
  const lines = items.map(({ sku, qty }) => {
    const { product, size } = productBySku(sku)
    return { sku, name: product.name, size, qty, price: product.price }
  })
  const subtotal = lines.reduce((sum, l) => sum + l.price * l.qty, 0)
  const order = {
    id: newOrderId(),
    status: 'awaiting_payment',
    lines,
    subtotal,
    voucher: voucher ?? null,
    total: subtotal, // same intentional bug as the checkout page: discount never applied
    address: address || T.defaultAddress,
    payment: payment ?? 'transfer_bank',
    source,
    created_at: new Date().toISOString(),
  }
  orders.set(order.id, order)
  return order
}

/* ------------------------------------------------------------------ TOTP (RFC 6238) */

const TOTP_PERIOD_S = 30
const TOTP_DIGITS = 6

function base32Decode(text) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = String(text).toUpperCase().replace(/[\s=-]/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of clean) {
    const i = alphabet.indexOf(ch)
    if (i < 0) throw new Error(`invalid base32 character "${ch}" in the TOTP seed`)
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

/** HOTP (RFC 4226) with HMAC-SHA1 and dynamic truncation. */
function hotp(key, counter) {
  const msg = Buffer.alloc(8)
  msg.writeBigUInt64BE(BigInt(counter))
  const mac = createHmac('sha1', key).update(msg).digest()
  const offset = mac[mac.length - 1] & 0x0f
  const bin = mac.readUInt32BE(offset) & 0x7fffffff
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0')
}

/** Accept the code of the current 30 s period and of the one before/after (clock skew). */
function verifyTotp(seed, code, now = Date.now()) {
  const given = Buffer.from(String(code ?? '').replace(/\s/g, ''))
  if (given.length !== TOTP_DIGITS) return false
  const key = base32Decode(seed)
  const counter = Math.floor(now / 1000 / TOTP_PERIOD_S)
  let ok = false
  for (const c of [counter - 1, counter, counter + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, c)), given)) ok = true
  }
  return ok
}

base32Decode(TOTP_SEED) // fail fast on a malformed DEMO_TOTP_SEED

/* ------------------------------------------------------------------ email (SMTP) */

/** Quoted-printable (RFC 2045) body encoding, CRLF line ends, lines ≤ 76 characters. */
function quotedPrintable(text) {
  const out = []
  for (const line of String(text).replace(/\r\n?/g, '\n').split('\n')) {
    const tokens = []
    const bytes = Buffer.from(line, 'utf8')
    bytes.forEach((b, i) => {
      const last = i === bytes.length - 1
      const literal = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last)
      tokens.push(literal ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`)
    })
    let current = ''
    for (const token of tokens) {
      if (current.length + token.length > 75) {
        out.push(`${current}=`) // soft line break
        current = ''
      }
      current += token
    }
    out.push(current)
  }
  return out.join('\r\n')
}

/** RFC 2047 encoded word for non-ASCII header text (display names, subject). */
const headerText = (text) => (/^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, 'utf8').toString('base64')}?=`)

/** multipart/alternative message (text + HTML), both parts quoted-printable. */
function buildMessage({ fromName, from, toName, to, subject, text, html }) {
  const boundary = `tokoku-${randomBytes(12).toString('hex')}`
  const quoteName = (n) => `"${headerText(n).replace(/["\\]/g, '')}"`
  return [
    `From: ${quoteName(fromName)} <${from}>`,
    `To: ${quoteName(toName)} <${to}>`,
    `Subject: ${headerText(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@tokoku.id>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    quotedPrintable(html),
    `--${boundary}--`,
    '',
  ].join('\r\n')
}

/**
 * Minimal SMTP client (no TLS, no AUTH — meant for Mailpit/MailHog-style catchers):
 * EHLO → MAIL FROM → RCPT TO → DATA → QUIT. Rejects with a readable message on any error.
 * Without `message` it only checks that the server accepts the sender and recipient (then RSET).
 */
function sendMail({ host, port, from, to, message, timeoutMs = 10_000 }) {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port })
    let buffer = ''
    let lines = []
    let waiting = null // { resolve, reject } of the pending reply
    let finished = false
    const fail = (err) => {
      if (finished) return
      finished = true
      socket.destroy()
      reject(err)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error(`timed out after ${timeoutMs} ms`)))
    socket.on('error', (err) => fail(new Error(err.code ?? err.message)))
    socket.on('close', () => fail(new Error('connection closed by the server')))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      let nl
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '')
        buffer = buffer.slice(nl + 1)
        lines.push(line)
        if (/^\d{3}(?: |$)/.test(line)) {
          // last line of a (possibly multi-line "250-…") reply
          const reply = { code: Number(line.slice(0, 3)), text: lines.join(' | ') }
          lines = []
          const w = waiting
          waiting = null
          w?.resolve(reply)
        }
      }
    })
    const reply = () => new Promise((res, rej) => (waiting = { resolve: res, reject: rej }))
    const expect = async (codes, command) => {
      const r = await reply()
      if (!codes.includes(r.code)) throw new Error(`${command ?? 'greeting'} → ${r.text}`)
      return r
    }
    const cmd = (line, codes) => {
      const p = expect(codes, line.split(':')[0])
      socket.write(`${line}\r\n`)
      return p
    }
    ;(async () => {
      await expect([220])
      await cmd('EHLO tokoku.local', [250])
      await cmd(`MAIL FROM:<${from}>`, [250])
      await cmd(`RCPT TO:<${to}>`, [250, 251])
      if (message === undefined) {
        await cmd('RSET', [250])
        finished = true
        socket.end('QUIT\r\n')
        return resolve()
      }
      await cmd('DATA', [354])
      // Dot-stuffing: a line starting with "." gets a second one; the message ends with CRLF.CRLF.
      const body = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')
      const done = expect([250], 'DATA')
      socket.write(`${body.endsWith('\r\n') ? body : `${body}\r\n`}.\r\n`)
      await done
      finished = true
      socket.end('QUIT\r\n')
      resolve()
    })().catch(fail)
  })
}

/* ------------------------------------------------------------------ sign-up state */

const SIGNUP_TTL_MS = 30 * 60_000
/** token → { name, email, password, code, token, expiresAt, attempts } (pending, unverified) */
const signups = new Map()

const findUser = (email) => USERS.find((u) => u.email.toLowerCase() === String(email ?? '').toLowerCase())
const findSignup = (email) =>
  [...signups.values()].find((p) => p.email.toLowerCase() === String(email ?? '').toLowerCase() && p.expiresAt > Date.now())
const EMAIL_RE = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[a-z]{2,}$/i

function activateSignup(pending) {
  signups.delete(pending.token)
  if (!findUser(pending.email)) USERS.push({ email: pending.email, name: pending.name, password: pending.password })
}

function verificationMail(pending) {
  const link = `${PUBLIC_URL}/verify?token=${pending.token}`
  const text = [
    T.mailHi(pending.name),
    '',
    T.mailIntro,
    '',
    `${T.mailCode(pending.code)}`,
    '',
    T.mailLinkIntro,
    link,
    '',
    T.mailExpiry,
    '',
    '— Tokoku (demo)',
  ].join('\n')
  const html = `<!doctype html>
<html lang="${T.htmlLang}"><body style="font-family: system-ui, sans-serif; color: #111827; line-height: 1.5;">
<p>${esc(T.mailHi(pending.name))}</p>
<p>${esc(T.mailIntro)}</p>
<p style="font-size: 18px;">${esc(T.mailCode('')).trim()} <strong style="letter-spacing: 2px;">${pending.code}</strong></p>
<p><a href="${esc(link)}" style="display: inline-block; padding: 10px 16px; border-radius: 8px; background: #0f766e; color: #ffffff; text-decoration: none;">${esc(T.mailButton)}</a></p>
<p style="color: #6b7280; font-size: 13px;">${esc(T.mailExpiry)}</p>
<p style="color: #6b7280; font-size: 13px;">— Tokoku (demo)</p>
</body></html>`
  return buildMessage({
    fromName: 'Tokoku',
    from: 'no-reply@tokoku.id',
    toName: pending.name,
    to: pending.email,
    subject: T.mailSubject,
    text,
    html,
  })
}

/* ------------------------------------------------------------------ helpers */

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const rupiah = (n) => `Rp ${String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`

const STATUS_LABEL = { awaiting_payment: T.status_awaiting_payment, paid: T.status_paid }
const PAYMENT_LABEL = { transfer_bank: T.payment_transfer_bank, ewallet: T.payment_ewallet }

function parseCookies(header = '') {
  const out = {}
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw Object.assign(new Error('Body too large'), { status: 413 })
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readForm(req) {
  return Object.fromEntries(new URLSearchParams(await readBody(req)))
}

async function readJson(req) {
  const text = await readBody(req)
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw Object.assign(new Error('Body is not valid JSON'), { status: 400 })
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers })
  res.end(body)
}

const html = (res, body, status = 200) => send(res, status, body, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
const json = (res, status, data, headers = {}) =>
  send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8', ...headers })
const redirect = (res, location) => send(res, 303, '', { Location: location })
/** `{error:{code,message,details?}}`; details = [{path, message}] per invalid field. */
const apiError = (res, status, code, message, details, headers = {}) =>
  json(res, status, { error: { code, message, ...(details?.length ? { details } : {}) } }, headers)

/* ------------------------------------------------------------------ layout */

function layout(session, { title, body, q = '' }) {
  const count = session.cart.length // number of distinct lines in the cart
  return `<!doctype html>
<html lang="${T.htmlLang}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)}</title>
  <link rel="stylesheet" href="/static/style.css">
  <script src="/static/app.js" defer></script>
</head>
<body>
  <header class="topbar">
    <a class="brand" href="/">Tokoku</a>
    <button type="button" class="nav-toggle" aria-expanded="false" aria-controls="main-nav">☰ ${T.menu}</button>
    <nav id="main-nav" aria-label="${T.nav}">
      <a href="/">${T.home}</a>
      <a href="${P.category}">${T.categories}</a>
      <a href="${P.cart}">${T.cart} <span class="badge" data-testid="cart-count">${count}</span></a>
    </nav>
    <form class="search" action="${P.search}" method="get" role="search">
      <input type="search" name="q" placeholder="${T.searchPlaceholder}" aria-label="${T.searchLabel}" value="${esc(q)}">
    </form>
    <div class="account">
      <button type="button" class="account-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu">${T.myAccount}</button>
      <div id="account-menu" class="menu" role="menu" aria-label="${T.accountMenu}" hidden>
        ${session.user
          ? `<a role="menuitem" href="${P.account}">${esc(session.user.name)}</a>`
          : `<a role="menuitem" href="/login">${T.loginToAccount}</a>`}
        <form action="/logout" method="post"><button type="submit" role="menuitem">${T.logout}</button></form>
      </div>
    </div>
  </header>
  <main>
${body}
  </main>
  <footer class="footer">${T.footer}</footer>
</body>
</html>`
}

function productCard(p) {
  return `<li class="card" data-testid="product-card">
        <a href="${P.product}/${esc(p.slug)}"><strong>${esc(p.name)}</strong></a>
        <span class="price">${rupiah(p.price)}</span>
      </li>`
}

const productGrid = (list) =>
  list.length ? `<ul class="grid">${list.map(productCard).join('')}</ul>` : `<p class="empty">${T.notFoundProducts}</p>`

/* ------------------------------------------------------------------ pages */

function renderHome(s) {
  return layout(s, {
    title: T.homeTitle,
    body: `<section class="hero">
      <h1>${T.welcome}</h1>
      <p>${T.tagline}</p>
    </section>
    <h2>${T.featured}</h2>
    ${productGrid(PRODUCTS.slice(0, 4))}`,
  })
}

function renderSearch(s, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = PRODUCTS.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
  return layout(s, {
    title: T.searchTitle(q),
    q,
    body: `<h1>${T.searchResults}</h1>
    <p>${T.resultsFor(found.length, esc(q))}</p>
    ${productGrid(found)}`,
  })
}

function renderCategory(s, selected) {
  const chosen = CATEGORIES.filter((c) => selected.includes(c.slug))
  const list = chosen.length ? PRODUCTS.filter((p) => selected.includes(p.category)) : PRODUCTS
  const heading = chosen.length ? chosen.map((c) => c.name).join(', ') : T.allCategories
  return layout(s, {
    title: T.categoryTitle,
    body: `<h1>${T.categories}</h1>
    <div class="columns">
      <form class="filters" action="${P.category}" method="get" data-category-filter>
        <fieldset>
          <legend>${T.filterCategories}</legend>
          ${CATEGORIES.map((c) => `<label><input type="checkbox" name="${P.categoryParam}" value="${c.slug}"${selected.includes(c.slug) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('\n          ')}
        </fieldset>
        <noscript><button type="submit">${T.apply}</button></noscript>
      </form>
      <section>
        <h2>${esc(heading)}</h2>
        ${productGrid(list)}
      </section>
    </div>`,
  })
}

function renderProduct(s, p, added) {
  return layout(s, {
    title: `${p.name} — Tokoku`,
    body: `<article class="product">
      <h1>${esc(p.name)}</h1>
      <p class="price" data-testid="product-price">${rupiah(p.price)}</p>
      <p data-testid="stock-label">${p.stock > 0 ? T.stock(p.stock) : T.outOfStock}</p>
      ${added ? `<p class="notice" role="status">${T.addedToCart}</p>` : ''}
      <form action="${P.cartAdd}" method="post">
        <input type="hidden" name="code" value="${p.code}">
        <input type="hidden" name="slug" value="${esc(p.slug)}">
        <label for="size">${T.size}</label>
        <select id="size" name="size">
          ${SIZES.map((z) => `<option value="${z}"${z === 'M' ? ' selected' : ''}>${z}</option>`).join('')}
        </select>
        <button type="submit"${p.stock > 0 ? '' : ' disabled'}>${T.addToCart}</button>
      </form>
      ${sizeChart()}
    </article>`,
  })
}

// Size chart. Known bug on purpose (responsive testing demo, docs/14): the table has a fixed
// min-width and no scroll wrapper, so it overflows the page horizontally below ~600 px.
const SIZE_CHART = { S: [96, 68, 42, 20], M: [102, 71, 44, 21], L: [108, 74, 46, 22], XL: [114, 77, 48, 23] }
function sizeChart() {
  const rows = Object.entries(SIZE_CHART)
    .map(([z, v]) => `<tr><th scope="row">${z}</th>${v.map((n) => `<td>${n}</td>`).join('')}<td>${T.fits[z]}</td></tr>`)
    .join('')
  return `<section class="size-chart" data-testid="size-chart">
        <h2>${T.sizeChart}</h2>
        <table>
          <thead><tr><th scope="col">${T.size}</th><th scope="col">${T.chest}</th><th scope="col">${T.length}</th><th scope="col">${T.shoulder}</th><th scope="col">${T.sleeve}</th><th scope="col">${T.fit}</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`
}

function cartLines(s) {
  return s.cart.map((line, index) => {
    const { product, size } = productBySku(line.sku)
    return { ...line, index, product, size, total: product.price * line.qty }
  })
}

function renderCart(s) {
  const lines = cartLines(s)
  const subtotal = lines.reduce((sum, l) => sum + l.total, 0)
  const body = lines.length
    ? `<h1>${T.cart}</h1>
    <ul class="cart">
      ${lines.map((l) => `<li class="cart-line" data-line="${l.index}">
        <div><strong>${esc(l.product.name)}</strong> <span class="muted">${T.sizeOf(l.size)}</span></div>
        <label for="qty-${l.index}">${T.quantity}</label>
        <input id="qty-${l.index}" type="number" min="1" max="99" value="${l.qty}" data-qty-line="${l.index}" data-qty-url="${P.cartUpdate}">
        <span class="line-total" data-testid="line-total">${rupiah(l.total)}</span>
        <form action="${P.cartRemove}" method="post"><input type="hidden" name="line" value="${l.index}"><button type="submit">${T.removeItem}</button></form>
      </li>`).join('')}
    </ul>
    <p>${T.subtotal}: <strong data-testid="cart-subtotal">${rupiah(subtotal)}</strong></p>
    <a class="button" href="/checkout">${T.toCheckout}</a>`
    : `<h1>${T.cart}</h1><p class="empty">${T.cartEmpty}</p><a href="/">${T.startShopping}</a>`
  return layout(s, { title: T.cartTitle, body })
}

function renderCheckout(s) {
  const lines = cartLines(s)
  if (!lines.length) {
    return layout(s, { title: 'Checkout — Tokoku', body: `<h1>Checkout</h1><p class="empty">${T.cartEmpty}</p><a href="/">${T.startShopping}</a>` })
  }
  const subtotal = lines.reduce((sum, l) => sum + l.total, 0)
  const pct = s.voucher ? VOUCHERS[s.voucher] : 0
  const discount = Math.round((subtotal * pct) / 100)
  // INTENTIONAL BUG: the discount is displayed but never subtracted from the grand total.
  const grandTotal = subtotal
  const flash = s.flash
  s.flash = null
  return layout(s, {
    title: 'Checkout — Tokoku',
    body: `<h1>Checkout</h1>
    ${flash ? `<p class="notice${flash.error ? ' error' : ''}" role="${flash.error ? 'alert' : 'status'}">${esc(flash.text)}</p>` : ''}
    <div class="columns">
      <div>
        <form class="voucher" action="/checkout/voucher" method="post">
          <label for="voucher">${T.voucherCode}</label>
          <input id="voucher" name="code" autocomplete="off" value="${esc(s.voucher ?? '')}">
          <button type="submit">${T.applyVoucher}</button>
        </form>
        <form id="checkout-form" action="/checkout" method="post">
          <label for="address">${T.address}</label>
          <textarea id="address" name="address" rows="3" placeholder="${T.addressPlaceholder}"></textarea>
          <fieldset>
            <legend>${T.paymentMethod}</legend>
            <label><input type="radio" name="payment" value="transfer_bank" checked> ${T.payment_transfer_bank}</label>
            <label><input type="radio" name="payment" value="ewallet"> ${T.payment_ewallet}</label>
          </fieldset>
          <button type="submit">${T.payNow}</button>
        </form>
      </div>
      <aside class="summary" aria-label="${T.orderSummary}">
        <h2>${T.summary}</h2>
        <ul>${lines.map((l) => `<li>${esc(l.product.name)} (${l.size}) × ${l.qty} — ${rupiah(l.total)}</li>`).join('')}</ul>
        <p>${T.subtotal}: <span data-testid="subtotal">${rupiah(subtotal)}</span></p>
        ${s.voucher ? `<p>${T.discount} (${esc(s.voucher)}): <span data-testid="discount">−${rupiah(discount)}</span></p>` : ''}
        <p class="total">${T.total}: <strong data-testid="grand-total">${rupiah(grandTotal)}</strong></p>
      </aside>
    </div>`,
  })
}

function renderLogin(s, { error = false, email = '' } = {}) {
  return layout(s, {
    title: T.loginTitle,
    body: `<h1>${T.login}</h1>
    ${error ? `<p class="notice error" role="alert">${T.wrongCredentials}</p>` : ''}
    <form class="stack" action="/login" method="post">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" value="${esc(email)}" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">${T.login}</button>
    </form>
    <p><a href="/signup">${T.createAccountLink}</a></p>`,
  })
}

function renderTwoFactor(s, { error = false } = {}) {
  return layout(s, {
    title: T.twoFaTitle,
    body: `<h1>${T.twoFa}</h1>
    <p class="muted">${T.twoFaText}</p>
    ${error ? `<p class="notice error" role="alert">${T.invalidAuthCode}</p>` : ''}
    <form class="stack" action="/login/2fa" method="post">
      <label for="totp">${T.authCode}</label>
      <input id="totp" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
      <button type="submit">${T.verify}</button>
    </form>`,
  })
}

function renderSignup(s, { error = null, name = '', email = '' } = {}) {
  return layout(s, {
    title: T.signupTitle,
    body: `<h1>${T.signup}</h1>
    ${error ? `<p class="notice error" role="alert">${esc(error)}</p>` : ''}
    <form class="stack" action="/signup" method="post">
      <label for="name">${T.name}</label>
      <input id="name" name="name" autocomplete="name" maxlength="80" value="${esc(name)}" required>
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="email" maxlength="254" value="${esc(email)}" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" aria-describedby="password-hint" required>
      <small id="password-hint" class="muted">${T.passwordHint}</small>
      <button type="submit">${T.createAccount}</button>
    </form>
    <p>${T.alreadyHaveAccount} <a href="/login">${T.login}</a></p>`,
  })
}

/** "Check your email" + the code form (alternative to the link). */
function renderCheckEmail(s, { email, error = false }) {
  return layout(s, {
    title: T.checkEmailTitle,
    body: `<h1>${T.checkEmail}</h1>
    <p>${esc(T.checkEmailText(email))}</p>
    ${error ? `<p class="notice error" role="alert">${T.invalidVerificationCode}</p>` : ''}
    <p class="muted">${T.codeAlternative}</p>
    <form class="stack" action="/verify" method="post">
      <input type="hidden" name="email" value="${esc(email)}">
      <label for="code">${T.verificationCode}</label>
      <input id="code" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required>
      <button type="submit">${T.verify}</button>
    </form>`,
  })
}

function renderVerified(s, email) {
  return layout(s, {
    title: T.verifiedTitle,
    body: `<h1>${T.emailVerified}</h1>
    <p class="notice" role="status">${esc(T.verifiedText(email))}</p>
    <a class="button" href="/login">${T.login}</a>`,
  })
}

function renderLinkInvalid(s) {
  return layout(s, {
    title: T.linkInvalidTitle,
    body: `<h1>${T.linkInvalid}</h1><p>${T.linkInvalidText}</p><a href="/signup">${T.signupAgain}</a>`,
  })
}

function renderMailFailed(s, reason) {
  return layout(s, {
    title: T.mailFailedTitle,
    body: `<h1>${T.mailFailed}</h1>
    <p class="notice error" role="alert">${esc(T.mailFailedText(`${SMTP_HOST}:${SMTP_PORT}`, reason))}</p>
    <a href="/signup">${T.signupAgain}</a>`,
  })
}

function renderAccount(s) {
  const mine = [...orders.values()].filter((o) => o.owner === s.user.email)
  return layout(s, {
    title: T.accountTitle,
    body: `<h1>${esc(T.hello(s.user.name))}</h1>
    <p class="muted">${esc(s.user.email)}</p>
    ${s.user.twoFactor ? `<p data-testid="two-factor-status">${T.twoFaOn}</p>` : ''}
    <h2>${T.myOrders}</h2>
    ${mine.length
      ? `<ul>${mine.map((o) => `<li><a href="${P.accountOrders}/${o.id}">${o.id}</a> — ${STATUS_LABEL[o.status]}</li>`).join('')}</ul>`
      : `<p class="empty">${T.noOrders}</p>`}`,
  })
}

function renderOrder(s, o) {
  return layout(s, {
    title: T.orderTitle(o.id),
    body: `<h1>${T.order(o.id)}</h1>
    <p>${T.status}: <strong data-testid="order-status">${STATUS_LABEL[o.status]}</strong></p>
    <p>${T.payment}: ${PAYMENT_LABEL[o.payment] ?? esc(o.payment)}</p>
    <p>${T.total}: ${rupiah(o.total)}</p>
    <ul>${o.lines.map((l) => `<li>${esc(l.name)} (${l.size}) × ${l.qty}</li>`).join('')}</ul>`,
  })
}

function renderOrderSuccess(s, o) {
  return layout(s, {
    title: T.orderPlacedTitle,
    body: `<h1>${T.orderPlaced}</h1>
    <p>${T.orderNumber}: <strong data-testid="order-id">${o.id}</strong></p>
    <p>${T.status}: ${STATUS_LABEL[o.status]}</p>
    ${o.status === 'awaiting_payment' && o.payment === 'transfer_bank'
      ? `<p>${T.transferHint(rupiah(o.total))}</p>`
      : ''}
    <a href="${P.accountOrders}/${o.id}">${T.orderDetails}</a>`,
  })
}

function renderGateway(s, o) {
  // Pretends to be the external e-wallet sandbox ("sandbox.pay.tokoku.id"), served locally.
  return layout(s, {
    title: 'Tokoku Pay (sandbox)',
    body: `<h1>Tokoku Pay — sandbox</h1>
    <p>Gateway: sandbox.pay.tokoku.id</p>
    <p>${T.gatewayOrder(o.id, rupiah(o.total))}</p>
    <form action="/gateway/sandbox.pay.tokoku.id/${o.id}" method="post" class="row">
      <button type="submit" name="result" value="success">${T.simulateSuccess}</button>
      <button type="submit" name="result" value="failed">${T.simulateFailure}</button>
    </form>`,
  })
}

function renderNotFound(s) {
  return layout(s, { title: T.notFoundTitle, body: `<h1>${T.pageNotFound}</h1><a href="/">${T.backHome}</a>` })
}

/* ------------------------------------------------------------------ API */

// Two small REST APIs for API-testing demos (English responses, JSON everywhere):
//   /api/v1  Tokoku shop: auth, profile, products (CRUD per bearer token), orders, a slow endpoint
//   /api/v2  Tokoku Pay: payment intents, refunds (pending → succeeded after DEMO_REFUND_DELAY_MS),
//            test webhooks; every endpoint except /api/v2/health needs `X-Api-Key: <DEMO_API_KEY>`
// Errors are `{error:{code,message,details?}}` with details = [{path, message}] per invalid field.

const TOKEN_TTL_S = 3600
const MAX_TOKENS = 5000
const MAX_PRODUCTS_PER_TOKEN = 100
const MAX_PAY_OBJECTS = 5000
const SLOW_MAX_MS = 10_000
const RATE_WINDOW_MS = 60_000
const CURRENCIES = ['IDR', 'USD', 'SGD']
const WEBHOOK_EVENTS = ['payment.succeeded', 'payment.failed', 'refund.succeeded', 'refund.failed']
const ADMIN_USER = { email: 'admin@tokoku.id', name: 'Tokoku Admin', role: 'admin' }

/** Map with a size cap: the oldest entries are dropped first (insertion order). */
function remember(map, key, value, max) {
  map.set(key, value)
  while (map.size > max) map.delete(map.keys().next().value)
  return value
}

const newApiId = (prefix) => `${prefix}_${randomBytes(8).toString('hex')}`
const isInt = (v) => typeof v === 'number' && Number.isInteger(v)

function safeEqual(a, b) {
  const x = Buffer.from(String(a))
  const y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1].trim() : null
}

/** { token, user } for a valid bearer token, otherwise { token, user: null } (token null = header missing). */
function apiUser(req) {
  const token = bearer(req)
  if (!token) return { token: null, user: null }
  if (safeEqual(token, ADMIN_TOKEN)) return { token, user: ADMIN_USER }
  const entry = apiTokens.get(token)
  if (!entry) return { token, user: null }
  if (entry.expiresAt <= Date.now()) {
    apiTokens.delete(token)
    return { token, user: null }
  }
  return { token, user: entry.user }
}

/** 401 + WWW-Authenticate (RFC 6750), or the authenticated { token, user }. */
function requireBearer(req, res) {
  const auth = apiUser(req)
  if (auth.user) return auth
  if (!auth.token) {
    apiError(res, 401, 'unauthenticated', 'Missing bearer token: send "Authorization: Bearer <token>" (POST /api/v1/auth/login)',
      undefined, { 'WWW-Authenticate': 'Bearer realm="tokoku"' })
  } else {
    apiError(res, 401, 'unauthenticated', 'Invalid or expired bearer token', undefined,
      { 'WWW-Authenticate': 'Bearer realm="tokoku", error="invalid_token", error_description="The access token is invalid or expired"' })
  }
  return null
}

async function readJsonObject(req) {
  const body = await readJson(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('Body must be a JSON object'), { status: 400 })
  }
  return body
}

const validationError = (res, details, message = 'The request has invalid fields') =>
  apiError(res, 422, 'validation_failed', message, details)

/** Fixed one-minute window per client (bearer token, API key or address) for API reads. */
function rateLimit(req, res) {
  const client = bearer(req) ?? req.headers['x-api-key'] ?? req.socket.remoteAddress ?? 'anonymous'
  const now = Date.now()
  let w = rateWindows.get(client)
  if (!w || now - w.start >= RATE_WINDOW_MS) w = remember(rateWindows, client, { start: now, count: 0 }, MAX_TOKENS)
  w.count += 1
  const reset = Math.ceil((w.start + RATE_WINDOW_MS - now) / 1000)
  res.setHeader('X-RateLimit-Limit', String(RATE_LIMIT))
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT - w.count)))
  res.setHeader('X-RateLimit-Reset', String(reset))
  if (w.count <= RATE_LIMIT) return true
  apiError(res, 429, 'rate_limited', `Too many requests: ${RATE_LIMIT} reads per minute`, undefined, { 'Retry-After': String(reset) })
  return false
}

/* ---------------------------------------------------------- v1: products */

const productView = ({ id, slug, name, price, stock, category, created_at, updated_at }) =>
  created_at ? { id, slug, name, price, stock, category, created_at, updated_at } : { id, slug, name, price, stock, category }

const ownProducts = (token) => (token ? tokenProducts.get(token) : undefined) ?? new Map()

/** Field errors of a product body; `partial` (PATCH) only checks the given fields. */
function productErrors(body, partial) {
  const details = []
  const has = (k) => body[k] !== undefined
  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) details.push({ path: 'name', message: 'is required' })
    else if (body.name.trim().length > 120) details.push({ path: 'name', message: 'must be at most 120 characters' })
  }
  if (!partial || has('price')) {
    if (!isInt(body.price) || body.price < 1 || body.price > 100_000_000) {
      details.push({ path: 'price', message: 'must be an integer between 1 and 100000000 (IDR)' })
    }
  }
  if (has('stock') && (!isInt(body.stock) || body.stock < 0 || body.stock > 100_000)) {
    details.push({ path: 'stock', message: 'must be an integer between 0 and 100000' })
  }
  if (has('category') && body.category !== null && !CATEGORIES.some((c) => c.slug === body.category)) {
    details.push({ path: 'category', message: `must be one of: ${CATEGORIES.map((c) => c.slug).join(', ')}` })
  }
  return details
}

const slugify = (s) =>
  String(s).toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_-]+/g, '-').slice(0, 60) || 'product'

function listProducts(req, res, url) {
  const { token, user } = apiUser(req)
  const q = (url.searchParams.get('q') ?? '').toLowerCase()
  const category = url.searchParams.get('category') ?? url.searchParams.get('kategori')
  const all = [...PRODUCTS, ...(user ? ownProducts(token).values() : [])]
  const list = all.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!category || p.category === category))
  const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20) || 20))
  const offset = Math.max(0, Math.floor(Number(url.searchParams.get('offset') ?? 0) || 0))
  const page = list.slice(offset, offset + limit)
  return json(res, 200, {
    data: page.map(productView),
    meta: { total: list.length, limit, offset, count: page.length, next_offset: offset + limit < list.length ? offset + limit : null },
  })
}

function getProduct(req, res, _url, [id]) {
  const { token, user } = apiUser(req)
  const own = user ? ownProducts(token).get(id) : undefined
  const p = own ?? PRODUCTS.find((x) => x.id === id || x.slug === id)
  return p ? json(res, 200, { data: productView(p) }) : apiError(res, 404, 'not_found', `Product ${id} not found`)
}

async function createProduct(req, res) {
  const auth = requireBearer(req, res)
  if (!auth) return
  const body = await readJsonObject(req)
  const details = productErrors(body, false)
  if (details.length) return validationError(res, details)
  let own = tokenProducts.get(auth.token)
  if (!own) own = remember(tokenProducts, auth.token, new Map(), MAX_TOKENS)
  if (own.size >= MAX_PRODUCTS_PER_TOKEN) {
    return apiError(res, 409, 'limit_reached', `At most ${MAX_PRODUCTS_PER_TOKEN} products per token; delete some or log in again`)
  }
  const id = newApiId('prd')
  const now = new Date().toISOString()
  const name = body.name.trim()
  const product = {
    id, slug: `${slugify(name)}-${id.slice(4, 10)}`, name, price: body.price, stock: body.stock ?? 0,
    category: body.category ?? null, created_at: now, updated_at: now,
  }
  own.set(id, product)
  return json(res, 201, { data: productView(product) }, { Location: `/api/v1/products/${id}` })
}

/** The caller's own product, or an error response (403 for catalog products, 404 otherwise). */
function ownProductOr(res, auth, id) {
  const p = ownProducts(auth.token).get(id)
  if (p) return p
  if (PRODUCTS.some((x) => x.id === id || x.slug === id)) {
    apiError(res, 403, 'forbidden', 'Catalog products are read-only; create your own with POST /api/v1/products')
  } else {
    apiError(res, 404, 'not_found', `Product ${id} not found`)
  }
  return null
}

async function updateProduct(req, res, _url, [id]) {
  const auth = requireBearer(req, res)
  if (!auth) return
  const p = ownProductOr(res, auth, id)
  if (!p) return
  const body = await readJsonObject(req)
  const details = productErrors(body, true)
  if (details.length) return validationError(res, details)
  if (body.name !== undefined) p.name = body.name.trim()
  for (const k of ['price', 'stock', 'category']) if (body[k] !== undefined) p[k] = body[k]
  p.updated_at = new Date().toISOString()
  return json(res, 200, { data: productView(p) })
}

function deleteProduct(req, res, _url, [id]) {
  const auth = requireBearer(req, res)
  if (!auth) return
  if (!ownProductOr(res, auth, id)) return
  ownProducts(auth.token).delete(id)
  return send(res, 204, '')
}

/* ---------------------------------------------------------- v1: auth, profile, orders, slow */

async function login(req, res) {
  const body = await readJsonObject(req)
  const details = []
  if (typeof body.email !== 'string' || !body.email) details.push({ path: 'email', message: 'is required' })
  if (typeof body.password !== 'string' || !body.password) details.push({ path: 'password', message: 'is required' })
  if (details.length) return validationError(res, details)
  const user = findUser(body.email)
  if (!user || user.password !== body.password) return apiError(res, 401, 'invalid_credentials', T.wrongCredentials)
  if (user.totp && !verifyTotp(user.totp, body.totp)) {
    return apiError(res, 401, body.totp ? 'invalid_totp' : 'totp_required', T.invalidAuthCode)
  }
  const token = `tkk_${randomBytes(16).toString('hex')}`
  const profile = { email: user.email, name: user.name, role: 'customer' }
  remember(apiTokens, token, { user: profile, expiresAt: Date.now() + TOKEN_TTL_S * 1000 }, MAX_TOKENS)
  return json(res, 201, { data: { token, token_type: 'Bearer', expires_in: TOKEN_TTL_S, user: { email: user.email, name: user.name } } })
}

function me(req, res) {
  const auth = requireBearer(req, res)
  if (!auth) return
  return json(res, 200, { data: { ...auth.user, two_factor: Boolean(findUser(auth.user.email)?.totp) } })
}

async function createApiOrder(req, res) {
  if (!requireBearer(req, res)) return
  const body = await readJsonObject(req)
  const qty = Number(body.qty ?? 1)
  if (!productBySku(body.sku)) {
    return apiError(res, 422, 'validation_failed', `Unknown sku "${body.sku}"`, [{ path: 'sku', message: 'is not a known SKU' }])
  }
  if (!Number.isInteger(qty) || qty < 1 || qty > 99) {
    return apiError(res, 422, 'validation_failed', 'qty must be 1..99', [{ path: 'qty', message: 'must be an integer between 1 and 99' }])
  }
  const order = createOrder({ items: [{ sku: body.sku, qty }], address: body.address, payment: body.payment, source: 'api' })
  return json(res, 201, { data: { id: order.id, status: order.status, total: order.total } }, { Location: `/api/v1/orders/${order.id}` })
}

function getOrder(_req, res, _url, [id]) {
  const o = orders.get(id)
  return o ? json(res, 200, { data: o }) : apiError(res, 404, 'not_found', `Order ${id} not found`)
}

async function slow(_req, res, url) {
  const raw = url.searchParams.get('ms') ?? '1000'
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return validationError(res, [{ path: 'ms', message: 'must be a number ≥ 0' }], 'Invalid query parameter')
  const delayed = Math.min(Math.round(ms), SLOW_MAX_MS)
  await new Promise((resolve) => setTimeout(resolve, delayed))
  return json(res, 200, { data: { requested_ms: Math.round(ms), delayed_ms: delayed, max_ms: SLOW_MAX_MS } })
}

/* ---------------------------------------------------------- v2: Tokoku Pay */

function requireApiKey(req, res) {
  const key = req.headers['x-api-key']
  if (!key) {
    apiError(res, 401, 'missing_api_key', 'Send your API key in the X-Api-Key header')
    return false
  }
  if (!safeEqual(key, API_KEY)) {
    apiError(res, 401, 'invalid_api_key', 'The API key is not valid')
    return false
  }
  return true
}

function refundView(r) {
  const doneAt = Date.parse(r.created_at) + REFUND_DELAY_MS
  const done = Date.now() >= doneAt
  return { ...r, status: done ? 'succeeded' : 'pending', succeeded_at: done ? new Date(doneAt).toISOString() : null }
}

function intentView(pi) {
  const amountRefunded = [...refunds.values()].filter((r) => r.payment_intent === pi.id).reduce((sum, r) => sum + r.amount, 0)
  return { ...pi, amount_refunded: amountRefunded, amount_refundable: pi.status === 'succeeded' ? pi.amount - amountRefunded : 0 }
}

async function createIntent(req, res) {
  const body = await readJsonObject(req)
  const details = []
  if (!isInt(body.amount) || body.amount < 1 || body.amount > 100_000_000) {
    details.push({ path: 'amount', message: 'must be an integer between 1 and 100000000 (smallest currency unit)' })
  }
  if (!CURRENCIES.includes(body.currency)) details.push({ path: 'currency', message: `must be one of: ${CURRENCIES.join(', ')}` })
  if (details.length) return validationError(res, details)
  const now = new Date().toISOString()
  const pi = {
    id: newApiId('pi'), object: 'payment_intent', amount: body.amount, currency: body.currency, status: 'requires_payment',
    description: typeof body.description === 'string' ? body.description.slice(0, 200) : null, created_at: now, confirmed_at: null,
  }
  remember(paymentIntents, pi.id, pi, MAX_PAY_OBJECTS)
  return json(res, 201, { data: intentView(pi) }, { Location: `/api/v2/payment-intents/${pi.id}` })
}

function getIntent(_req, res, _url, [id]) {
  const pi = paymentIntents.get(id)
  return pi ? json(res, 200, { data: intentView(pi) }) : apiError(res, 404, 'not_found', `Payment intent ${id} not found`)
}

function confirmIntent(_req, res, _url, [id]) {
  const pi = paymentIntents.get(id)
  if (!pi) return apiError(res, 404, 'not_found', `Payment intent ${id} not found`)
  if (pi.status === 'requires_payment') {
    pi.status = 'succeeded'
    pi.confirmed_at = new Date().toISOString()
  }
  return json(res, 200, { data: intentView(pi) })
}

async function createRefund(req, res) {
  const body = await readJsonObject(req)
  const details = []
  if (typeof body.payment_intent !== 'string' || !body.payment_intent) details.push({ path: 'payment_intent', message: 'is required' })
  if (body.amount !== undefined && (!isInt(body.amount) || body.amount < 1)) details.push({ path: 'amount', message: 'must be a positive integer' })
  if (details.length) return validationError(res, details)
  const pi = paymentIntents.get(body.payment_intent)
  if (!pi) return apiError(res, 404, 'not_found', `Payment intent ${body.payment_intent} not found`)
  if (pi.status !== 'succeeded') {
    return apiError(res, 409, 'invalid_state', `Payment intent ${pi.id} has not been paid yet (status ${pi.status}); confirm it first`)
  }
  const refundable = intentView(pi).amount_refundable
  const amount = body.amount ?? refundable
  if (amount > refundable || refundable === 0) {
    return apiError(res, 422, 'amount_exceeds_refundable', `Refund amount ${amount} exceeds the refundable amount ${refundable}`,
      [{ path: 'amount', message: `must be at most ${refundable}` }])
  }
  const r = {
    id: newApiId('re'), object: 'refund', payment_intent: pi.id, amount, currency: pi.currency,
    reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : null, created_at: new Date().toISOString(),
  }
  remember(refunds, r.id, r, MAX_PAY_OBJECTS)
  return json(res, 201, { data: refundView(r) }, { Location: `/api/v2/refunds/${r.id}` })
}

function getRefund(_req, res, _url, [id]) {
  const r = refunds.get(id)
  return r ? json(res, 200, { data: refundView(r) }) : apiError(res, 404, 'not_found', `Refund ${id} not found`)
}

/** Sends nothing anywhere: returns the signed event a webhook receiver would get (Stripe-style signature). */
async function testWebhook(req, res) {
  const body = await readJsonObject(req)
  if (!WEBHOOK_EVENTS.includes(body.event)) {
    return validationError(res, [{ path: 'event', message: `must be one of: ${WEBHOOK_EVENTS.join(', ')}` }])
  }
  const t = Math.floor(Date.now() / 1000)
  const event = { id: newApiId('evt'), type: body.event, created: t }
  const payload = JSON.stringify(event)
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest('hex')
  return json(res, 200, { delivered: true, event: body.event, id: event.id, signature: `t=${t},v1=${v1}`, payload })
}

/* ---------------------------------------------------------- dispatch */

const ok = (_req, res) => send(res, 200, 'ok', { 'Content-Type': 'text/plain; charset=utf-8' })

/** [method, path pattern (after /api), handler(req, res, url, params)] */
const API_ROUTES = [
  ['GET', /^\/health$/, (_req, res) => json(res, 200, { ok: true })],
  ['POST', /^\/v1\/auth\/login$/, login],
  ['GET', /^\/v1\/me$/, me],
  ['GET', /^\/v1\/products$/, listProducts],
  ['POST', /^\/v1\/products$/, createProduct],
  ['GET', /^\/v1\/products\/([\w-]+)$/, getProduct],
  ['PATCH', /^\/v1\/products\/([\w-]+)$/, updateProduct],
  ['DELETE', /^\/v1\/products\/([\w-]+)$/, deleteProduct],
  ['POST', /^\/v1\/orders$/, createApiOrder],
  ['GET', /^\/v1\/orders\/([\w-]+)$/, getOrder],
  ['GET', /^\/v1\/slow$/, slow],
  ['GET', /^\/v2\/health$/, ok],
  ['POST', /^\/v2\/payment-intents$/, createIntent],
  ['GET', /^\/v2\/payment-intents\/([\w-]+)$/, getIntent],
  ['POST', /^\/v2\/payment-intents\/([\w-]+)\/confirm$/, confirmIntent],
  ['POST', /^\/v2\/refunds$/, createRefund],
  ['GET', /^\/v2\/refunds\/([\w-]+)$/, getRefund],
  ['POST', /^\/v2\/test\/webhooks$/, testWebhook],
]

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '')
  const method = req.method === 'HEAD' ? 'GET' : req.method
  if (path.startsWith('/v2/') && path !== '/v2/health' && !requireApiKey(req, res)) return
  const matching = API_ROUTES.map(([m, re, fn]) => [m, re.exec(path), fn]).filter(([, match]) => match)
  if (!matching.length) return apiError(res, 404, 'not_found', `No such endpoint: ${req.method} ${url.pathname}`)
  const route = matching.find(([m]) => m === method)
  if (!route) {
    const allow = [...new Set(matching.map(([m]) => m))].join(', ')
    return apiError(res, 405, 'method_not_allowed', `${req.method} is not allowed here (allowed: ${allow})`, undefined, { Allow: allow })
  }
  if (method === 'GET' && path !== '/health' && path !== '/v2/health' && !rateLimit(req, res)) return
  return route[2](req, res, url, route[1].slice(1))
}

/* ------------------------------------------------------------------ router */

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname

  if (STATIC[path]) {
    const f = STATIC[path]
    return send(res, 200, f.body, { 'Content-Type': f.type, 'Cache-Control': 'no-cache' })
  }
  if (path === '/api' || path.startsWith('/api/')) return handleApi(req, res, url)
  if (path === '/favicon.ico') return send(res, 204, '')

  // Browser pages: cookie session.
  const cookies = parseCookies(req.headers.cookie)
  let sid = cookies.tokoku_sid
  if (!sid || !sessions.has(sid)) {
    sid = randomBytes(16).toString('hex')
    sessions.set(sid, newSession())
    res.setHeader('Set-Cookie', `tokoku_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`)
  }
  const s = sessions.get(sid)
  const { method } = req

  if (method === 'GET' && path === '/') return html(res, renderHome(s))
  if (method === 'GET' && path === P.search) return html(res, renderSearch(s, (url.searchParams.get('q') ?? '').trim()))
  if (method === 'GET' && path === P.category) {
    const selected = url.searchParams.getAll(P.categoryParam).flatMap((v) => v.split(',')).filter(Boolean)
    return html(res, renderCategory(s, selected))
  }

  const productMatch = path.startsWith(`${P.product}/`) && /^[\w-]+$/.test(path.slice(P.product.length + 1)) ? path.slice(P.product.length + 1) : null
  if (method === 'GET' && productMatch) {
    const p = PRODUCTS.find((x) => x.slug === productMatch)
    return p ? html(res, renderProduct(s, p, url.searchParams.has(P.addedParam))) : html(res, renderNotFound(s), 404)
  }

  if (method === 'GET' && path === '/login') return html(res, renderLogin(s))
  if (method === 'POST' && path === '/login') {
    const form = await readForm(req)
    const user = findUser(form.email)
    if (!user || user.password !== form.password) return html(res, renderLogin(s, { error: true, email: form.email }), 401)
    if (user.totp) {
      // Password OK, second factor pending: not logged in until /login/2fa succeeds.
      s.user = null
      s.pending2fa = { email: user.email, expiresAt: Date.now() + 5 * 60_000, attempts: 0 }
      return redirect(res, '/login/2fa')
    }
    s.user = { email: user.email, name: user.name }
    return redirect(res, P.account)
  }
  if (path === '/login/2fa') {
    const pending = s.pending2fa && s.pending2fa.expiresAt > Date.now() ? s.pending2fa : null
    const user = pending && findUser(pending.email)
    if (!user) {
      s.pending2fa = null
      return redirect(res, '/login')
    }
    if (method === 'GET') return html(res, renderTwoFactor(s))
    if (method === 'POST') {
      const form = await readForm(req)
      if (!verifyTotp(user.totp, form.code)) {
        pending.attempts += 1
        if (pending.attempts >= 5) s.pending2fa = null // start over with the password after 5 wrong codes
        return html(res, renderTwoFactor(s, { error: true }), 401)
      }
      s.pending2fa = null
      s.user = { email: user.email, name: user.name, twoFactor: true }
      return redirect(res, P.account)
    }
  }

  if (method === 'GET' && path === '/signup') return html(res, renderSignup(s))
  if (method === 'POST' && path === '/signup') {
    const form = await readForm(req)
    const name = String(form.name ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, 80)
    const email = String(form.email ?? '').trim().toLowerCase()
    const password = String(form.password ?? '')
    if (!name || !EMAIL_RE.test(email) || email.length > 254 || password.length < 8) {
      return html(res, renderSignup(s, { error: T.signupInvalid, name, email }), 422)
    }
    if (findUser(email)) return html(res, renderSignup(s, { error: T.emailTaken, name, email }), 409)
    const previous = findSignup(email)
    if (previous) signups.delete(previous.token) // signing up again replaces the pending account
    const pending = {
      name, email, password,
      code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
      token: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + SIGNUP_TTL_MS,
      attempts: 0,
    }
    const mail = { host: SMTP_HOST, port: SMTP_PORT, from: 'no-reply@tokoku.id', to: email }
    try {
      // With a delay, like a real mail queue, the email arrives a moment after the "Check your
      // email" page (test cases have to poll for it); the SMTP server is still checked up front so
      // an unreachable server is reported on the page.
      await sendMail(MAIL_DELAY_MS ? mail : { ...mail, message: verificationMail(pending) })
    } catch (err) {
      console.error(`[demo-target] sign-up email to ${email} via ${SMTP_HOST}:${SMTP_PORT} failed: ${err.message}`)
      return html(res, renderMailFailed(s, err.message), 502)
    }
    if (MAIL_DELAY_MS) {
      setTimeout(() => {
        sendMail({ ...mail, message: verificationMail(pending) }).catch((err) =>
          console.error(`[demo-target] queued sign-up email to ${email} via ${SMTP_HOST}:${SMTP_PORT} failed: ${err.message}`),
        )
      }, MAIL_DELAY_MS).unref()
    }
    signups.set(pending.token, pending)
    return redirect(res, `/verify?email=${encodeURIComponent(email)}`)
  }
  if (method === 'GET' && path === '/verify') {
    const token = url.searchParams.get('token')
    if (token) {
      const pending = signups.get(token)
      if (!pending || pending.expiresAt <= Date.now()) return html(res, renderLinkInvalid(s), 400)
      activateSignup(pending)
      return html(res, renderVerified(s, pending.email))
    }
    const email = (url.searchParams.get('email') ?? '').trim().toLowerCase()
    return email ? html(res, renderCheckEmail(s, { email })) : redirect(res, '/signup')
  }
  if (method === 'POST' && path === '/verify') {
    const form = await readForm(req)
    const email = String(form.email ?? '').trim().toLowerCase()
    const pending = findSignup(email)
    const code = String(form.code ?? '').trim()
    if (!pending || pending.attempts >= 5 || code.length !== 6 || !timingSafeEqual(Buffer.from(code), Buffer.from(pending.code))) {
      if (pending) pending.attempts += 1
      return html(res, renderCheckEmail(s, { email, error: true }), 400)
    }
    activateSignup(pending)
    return html(res, renderVerified(s, pending.email))
  }
  if (method === 'POST' && path === '/logout') {
    s.user = null
    return redirect(res, '/login')
  }
  if (method === 'GET' && path === P.account) {
    return s.user ? html(res, renderAccount(s)) : redirect(res, `/login?next=${encodeURIComponent(P.account)}`)
  }

  const orderMatch = path.startsWith(`${P.accountOrders}/`) ? /^([\w-]+)$/.exec(path.slice(P.accountOrders.length + 1)) : null
  if (method === 'GET' && orderMatch) {
    // Order pages are reachable by their (unguessable in real life) id without login, so an
    // order created through the API can be verified in a fresh browser.
    const o = orders.get(orderMatch[1])
    return o ? html(res, renderOrder(s, o)) : html(res, renderNotFound(s), 404)
  }

  if (method === 'GET' && path === P.cart) return html(res, renderCart(s))
  if (method === 'POST' && path === P.cartAdd) {
    const form = await readForm(req)
    const sku = `${form.code}-${form.size}`
    if (!productBySku(sku)) return html(res, renderNotFound(s), 404)
    const line = s.cart.find((l) => l.sku === sku)
    if (line) line.qty = Math.min(99, line.qty + 1)
    else s.cart.push({ sku, qty: 1 })
    return redirect(res, `${P.product}/${encodeURIComponent(form.slug)}?${P.addedParam}=1`)
  }
  if (method === 'POST' && path === P.cartUpdate) {
    // JSON endpoint used by app.js when a quantity input changes.
    const body = await readJson(req)
    const line = s.cart[Number(body.line)]
    const qty = Number(body.qty)
    if (!line || !Number.isInteger(qty) || qty < 1 || qty > 99) return apiError(res, 422, 'validation_failed', 'Invalid line or qty')
    line.qty = qty
    const lines = cartLines(s)
    return json(res, 200, {
      line_total: rupiah(lines[Number(body.line)].total),
      subtotal: rupiah(lines.reduce((sum, l) => sum + l.total, 0)),
      count: s.cart.length,
    })
  }
  if (method === 'POST' && path === P.cartRemove) {
    const form = await readForm(req)
    s.cart.splice(Number(form.line), 1)
    return redirect(res, P.cart)
  }

  if (method === 'GET' && path === '/checkout') return html(res, renderCheckout(s))
  if (method === 'POST' && path === '/checkout/voucher') {
    const code = String((await readForm(req)).code ?? '').trim().toUpperCase()
    if (VOUCHERS[code]) {
      s.voucher = code
      s.flash = { text: T.voucherApplied(code) }
    } else {
      s.voucher = null
      s.flash = { text: T.voucherInvalid, error: true }
    }
    return redirect(res, '/checkout')
  }
  if (method === 'POST' && path === '/checkout') {
    if (!s.cart.length) return redirect(res, P.cart)
    const form = await readForm(req)
    const payment = form.payment === 'ewallet' ? 'ewallet' : 'transfer_bank'
    const order = createOrder({ items: s.cart, address: form.address, payment, voucher: s.voucher, source: 'web' })
    order.owner = s.user?.email ?? null
    s.cart = []
    s.voucher = null
    return redirect(res, payment === 'ewallet' ? `/gateway/sandbox.pay.tokoku.id/${order.id}` : P.orderSuccess(order.id))
  }

  const gatewayMatch = /^\/gateway\/sandbox\.pay\.tokoku\.id\/([\w-]+)$/.exec(path)
  if (gatewayMatch) {
    const o = orders.get(gatewayMatch[1])
    if (!o) return html(res, renderNotFound(s), 404)
    if (method === 'GET') return html(res, renderGateway(s, o))
    if (method === 'POST') {
      const form = await readForm(req)
      if (form.result === 'success') o.status = 'paid'
      return redirect(res, form.result === 'success' ? P.orderSuccess(o.id) : `${P.accountOrders}/${o.id}`)
    }
  }

  const successMatch = P.orderSuccessRe.exec(path)
  if (method === 'GET' && successMatch) {
    const o = orders.get(successMatch[1])
    return o ? html(res, renderOrderSuccess(s, o)) : html(res, renderNotFound(s), 404)
  }

  return html(res, renderNotFound(s), 404)
}

const ERROR_CODES = { 400: 'bad_request', 413: 'payload_too_large', 500: 'internal' }

const server = createServer((req, res) => {
  // Every response carries a request id (the client's X-Request-Id is echoed when it looks sane).
  const incoming = req.headers['x-request-id']
  res.setHeader('X-Request-Id', typeof incoming === 'string' && /^[\w.:-]{1,64}$/.test(incoming) ? incoming : `req_${randomBytes(8).toString('hex')}`)
  handle(req, res).catch((err) => {
    const status = err.status ?? 500
    if (status === 500) console.error('[demo-target]', err)
    if (!res.headersSent) apiError(res, status, ERROR_CODES[status] ?? 'bad_request', err.message)
    else res.end()
  })
})

server.listen(PORT, HOST, () => {
  const { port } = server.address()
  if (!PUBLIC_URL) PUBLIC_URL = `http://localhost:${port}`
  // Machine-readable first line (tests parse it), then a human hint.
  console.log(`Tokoku demo listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`)
  console.log(`  language=${LANG}  BASE_URL=http://localhost:${port}  API_URL=http://localhost:${port}/api`)
  console.log(`  smtp=${SMTP_HOST}:${SMTP_PORT}  mail_delay_ms=${MAIL_DELAY_MS}  public_url=${PUBLIC_URL}`)
  console.log(`  pay api=http://localhost:${port}/api/v2  refund_delay_ms=${REFUND_DELAY_MS}  rate_limit=${RATE_LIMIT}/min`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close()
    server.closeAllConnections()
    process.exit(0)
  })
}
