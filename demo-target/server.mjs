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
//
// INTENTIONAL BUG: the voucher HEMAT10 is shown as applied, but the grand total ignores the
// discount (see renderCheckout). The seeded "voucher" test case is meant to fail on it.

import { createServer } from 'node:http'
import { randomBytes, randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const PORT = Number(process.env.PORT ?? 8099)
const HOST = process.env.HOST ?? '127.0.0.1'
const QA_PASSWORD = process.env.DEMO_QA_PASSWORD ?? 'Qa-Staging-2026!'
const ADMIN_TOKEN = process.env.DEMO_ADMIN_TOKEN ?? 'adm_stg_8f3a'
const LANG = (process.env.DEMO_LANG ?? 'en').toLowerCase() === 'id' ? 'id' : 'en'

const USERS = [{ email: 'qa.bot@tokoku.id', name: 'QA Bot', password: QA_PASSWORD }]

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
      htmlLang: 'en', nav: 'Main', home: 'Home', categories: 'Categories', cart: 'Cart', searchPlaceholder: 'Search products',
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
      htmlLang: 'id', nav: 'Utama', home: 'Beranda', categories: 'Kategori', cart: 'Keranjang', searchPlaceholder: 'Cari produk',
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
/** API bearer tokens issued by POST /api/v1/auth/login */
const apiTokens = new Set()

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
const json = (res, status, data) => send(res, status, JSON.stringify(data), { 'Content-Type': 'application/json; charset=utf-8' })
const redirect = (res, location) => send(res, 303, '', { Location: location })
const apiError = (res, status, code, message) => json(res, status, { error: { code, message } })

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
    <nav aria-label="${T.nav}">
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
    </article>`,
  })
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
    </form>`,
  })
}

function renderAccount(s) {
  const mine = [...orders.values()].filter((o) => o.owner === s.user.email)
  return layout(s, {
    title: T.accountTitle,
    body: `<h1>${esc(T.hello(s.user.name))}</h1>
    <p class="muted">${esc(s.user.email)}</p>
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

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')
  return m ? m[1].trim() : null
}

async function handleApi(req, res, url) {
  const path = url.pathname.replace(/^\/api/, '')
  if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true })

  if (req.method === 'GET' && path === '/v1/products') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const category = url.searchParams.get('category') ?? url.searchParams.get('kategori')
    let list = PRODUCTS.filter((p) => (!q || p.name.toLowerCase().includes(q)) && (!category || p.category === category))
    const total = list.length
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') ?? 20) || 20))
    list = list.slice(0, limit)
    return json(res, 200, {
      data: list.map(({ id, slug, name, price, stock, category: cat }) => ({ id, slug, name, price, stock, category: cat })),
      meta: { total, limit },
    })
  }

  const productMatch = /^\/v1\/products\/([\w-]+)$/.exec(path)
  if (req.method === 'GET' && productMatch) {
    const p = PRODUCTS.find((x) => x.id === productMatch[1] || x.slug === productMatch[1])
    return p ? json(res, 200, { data: p }) : apiError(res, 404, 'not_found', 'Product not found')
  }

  if (req.method === 'POST' && path === '/v1/auth/login') {
    const body = await readJson(req)
    const user = USERS.find((u) => u.email === body.email && u.password === body.password)
    if (!user) return apiError(res, 401, 'invalid_credentials', T.wrongCredentials)
    const token = `tkk_${randomBytes(16).toString('hex')}`
    apiTokens.add(token)
    return json(res, 201, { data: { token, user: { email: user.email, name: user.name } } })
  }

  if (req.method === 'POST' && path === '/v1/orders') {
    const token = bearer(req)
    if (!token || (token !== ADMIN_TOKEN && !apiTokens.has(token))) {
      return apiError(res, 401, 'unauthenticated', 'Missing or invalid bearer token')
    }
    const body = await readJson(req)
    const qty = Number(body.qty ?? 1)
    if (!productBySku(body.sku)) return apiError(res, 422, 'validation_failed', `Unknown sku "${body.sku}"`)
    if (!Number.isInteger(qty) || qty < 1 || qty > 99) return apiError(res, 422, 'validation_failed', 'qty must be 1..99')
    const order = createOrder({ items: [{ sku: body.sku, qty }], address: body.address, payment: body.payment, source: 'api' })
    return json(res, 201, { data: { id: order.id, status: order.status, total: order.total } })
  }

  const orderMatch = /^\/v1\/orders\/([\w-]+)$/.exec(path)
  if (req.method === 'GET' && orderMatch) {
    const o = orders.get(orderMatch[1])
    return o ? json(res, 200, { data: o }) : apiError(res, 404, 'not_found', 'Order not found')
  }

  return apiError(res, 404, 'not_found', 'No such endpoint')
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
    const user = USERS.find((u) => u.email === form.email && u.password === form.password)
    if (!user) return html(res, renderLogin(s, { error: true, email: form.email }), 401)
    s.user = { email: user.email, name: user.name }
    return redirect(res, P.account)
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

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err.status ?? 500
    if (status === 500) console.error('[demo-target]', err)
    if (!res.headersSent) apiError(res, status, status === 500 ? 'internal' : 'bad_request', err.message)
    else res.end()
  })
})

server.listen(PORT, HOST, () => {
  const { port } = server.address()
  // Machine-readable first line (tests parse it), then a human hint.
  console.log(`Tokoku demo listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${port}`)
  console.log(`  language=${LANG}  BASE_URL=http://localhost:${port}  API_URL=http://localhost:${port}/api`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close()
    server.closeAllConnections()
    process.exit(0)
  })
}
