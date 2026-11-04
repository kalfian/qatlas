// Tokoku — a tiny fake Indonesian shop used as the target app for QAtlas runner tests and demos.
// Dependency-free: Node's http module, server-rendered HTML, one CSS and one JS file.
// State lives in memory (sessions keyed by cookie, orders, API tokens) and resets on restart.
//
//   PORT=8099 node server.mjs          (PORT=0 picks a free port; the chosen URL is printed)
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

const USERS = [{ email: 'qa.bot@tokoku.id', name: 'QA Bot', password: QA_PASSWORD }]

const CATEGORIES = [
  { slug: 'pakaian-pria', name: 'Pakaian pria' },
  { slug: 'pakaian-wanita', name: 'Pakaian wanita' },
  { slug: 'aksesoris', name: 'Aksesoris' },
]

const PRODUCTS = [
  { id: 'p_1', code: 'KPH', slug: 'kaos-polos-hitam', name: 'Kaos Polos Hitam', price: 90000, stock: 12, category: 'pakaian-pria' },
  { id: 'p_2', code: 'KPP', slug: 'kaos-polos-putih', name: 'Kaos Polos Putih', price: 85000, stock: 7, category: 'pakaian-pria' },
  { id: 'p_3', code: 'KFK', slug: 'kemeja-flanel-kotak', name: 'Kemeja Flanel Kotak', price: 175000, stock: 4, category: 'pakaian-pria' },
  { id: 'p_4', code: 'BLN', slug: 'blus-linen', name: 'Blus Linen', price: 150000, stock: 9, category: 'pakaian-wanita' },
  { id: 'p_5', code: 'TPB', slug: 'topi-baseball', name: 'Topi Baseball', price: 60000, stock: 20, category: 'aksesoris' },
  { id: 'p_6', code: 'TSK', slug: 'tas-kanvas', name: 'Tas Kanvas', price: 120000, stock: 0, category: 'aksesoris' },
]
const SIZES = ['S', 'M', 'L', 'XL']
const VOUCHERS = { HEMAT10: 10 }

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
  // Every new visitor starts with a demo cart (1× Kaos Polos Hitam, size L) so that cart and
  // checkout test cases can run on their own, without a preceding "add to cart" case.
  return { user: null, cart: [{ sku: 'KPH-L', qty: 1 }], voucher: null, flash: null }
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
    address: address || 'Alamat utama akun',
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

const STATUS_LABEL = { awaiting_payment: 'Menunggu pembayaran', paid: 'Lunas' }
const PAYMENT_LABEL = { transfer_bank: 'Transfer bank', ewallet: 'E-wallet' }

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
<html lang="id">
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
    <nav aria-label="Utama">
      <a href="/">Beranda</a>
      <a href="/kategori">Kategori</a>
      <a href="/keranjang">Keranjang <span class="badge" data-testid="cart-count">${count}</span></a>
    </nav>
    <form class="search" action="/cari" method="get" role="search">
      <input type="search" name="q" placeholder="Cari produk" aria-label="Kata kunci" value="${esc(q)}">
    </form>
    <div class="account">
      <button type="button" class="account-toggle" aria-haspopup="menu" aria-expanded="false" aria-controls="account-menu">Akun saya</button>
      <div id="account-menu" class="menu" role="menu" aria-label="Menu akun" hidden>
        ${session.user
          ? `<a role="menuitem" href="/akun">${esc(session.user.name)}</a>`
          : `<a role="menuitem" href="/login">Masuk ke akun</a>`}
        <form action="/logout" method="post"><button type="submit" role="menuitem">Keluar</button></form>
      </div>
    </div>
  </header>
  <main>
${body}
  </main>
  <footer class="footer">Tokoku demo — toko palsu untuk menguji QAtlas.</footer>
</body>
</html>`
}

function productCard(p) {
  return `<li class="card" data-testid="product-card">
        <a href="/produk/${esc(p.slug)}"><strong>${esc(p.name)}</strong></a>
        <span class="price">${rupiah(p.price)}</span>
      </li>`
}

const productGrid = (list) =>
  list.length ? `<ul class="grid">${list.map(productCard).join('')}</ul>` : '<p class="empty">Produk tidak ditemukan.</p>'

/* ------------------------------------------------------------------ pages */

function renderHome(s) {
  return layout(s, {
    title: 'Tokoku — Belanja hemat setiap hari',
    body: `<section class="hero">
      <h1>Selamat datang di Tokoku</h1>
      <p>Kaos, kemeja, dan aksesoris dengan harga bersahabat.</p>
    </section>
    <h2>Produk pilihan</h2>
    ${productGrid(PRODUCTS.slice(0, 4))}`,
  })
}

function renderSearch(s, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const found = PRODUCTS.filter((p) => words.every((w) => p.name.toLowerCase().includes(w)))
  return layout(s, {
    title: `Cari "${q}" — Tokoku`,
    q,
    body: `<h1>Hasil pencarian</h1>
    <p>${found.length} produk untuk "${esc(q)}"</p>
    ${productGrid(found)}`,
  })
}

function renderCategory(s, selected) {
  const chosen = CATEGORIES.filter((c) => selected.includes(c.slug))
  const list = chosen.length ? PRODUCTS.filter((p) => selected.includes(p.category)) : PRODUCTS
  const heading = chosen.length ? chosen.map((c) => c.name).join(', ') : 'Semua kategori'
  return layout(s, {
    title: 'Kategori — Tokoku',
    body: `<h1>Kategori</h1>
    <div class="columns">
      <form class="filters" action="/kategori" method="get" data-category-filter>
        <fieldset>
          <legend>Filter kategori</legend>
          ${CATEGORIES.map((c) => `<label><input type="checkbox" name="kategori" value="${c.slug}"${selected.includes(c.slug) ? ' checked' : ''}> ${esc(c.name)}</label>`).join('\n          ')}
        </fieldset>
        <noscript><button type="submit">Terapkan</button></noscript>
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
      <p data-testid="stock-label">${p.stock > 0 ? `Stok: ${p.stock}` : 'Stok habis'}</p>
      ${added ? '<p class="notice" role="status">Berhasil ditambahkan ke keranjang</p>' : ''}
      <form action="/keranjang/tambah" method="post">
        <input type="hidden" name="code" value="${p.code}">
        <input type="hidden" name="slug" value="${esc(p.slug)}">
        <label for="size">Ukuran</label>
        <select id="size" name="size">
          ${SIZES.map((z) => `<option value="${z}"${z === 'M' ? ' selected' : ''}>${z}</option>`).join('')}
        </select>
        <button type="submit"${p.stock > 0 ? '' : ' disabled'}>Tambah ke keranjang</button>
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
    ? `<h1>Keranjang</h1>
    <ul class="cart">
      ${lines.map((l) => `<li class="cart-line" data-line="${l.index}">
        <div><strong>${esc(l.product.name)}</strong> <span class="muted">Ukuran ${l.size}</span></div>
        <label for="qty-${l.index}">Jumlah</label>
        <input id="qty-${l.index}" type="number" min="1" max="99" value="${l.qty}" data-qty-line="${l.index}">
        <span class="line-total" data-testid="line-total">${rupiah(l.total)}</span>
        <form action="/keranjang/hapus" method="post"><input type="hidden" name="line" value="${l.index}"><button type="submit">Hapus item</button></form>
      </li>`).join('')}
    </ul>
    <p>Subtotal: <strong data-testid="cart-subtotal">${rupiah(subtotal)}</strong></p>
    <a class="button" href="/checkout">Lanjut ke checkout</a>`
    : `<h1>Keranjang</h1><p class="empty">Keranjang kamu kosong</p><a href="/">Mulai belanja</a>`
  return layout(s, { title: 'Keranjang — Tokoku', body })
}

function renderCheckout(s) {
  const lines = cartLines(s)
  if (!lines.length) {
    return layout(s, { title: 'Checkout — Tokoku', body: '<h1>Checkout</h1><p class="empty">Keranjang kamu kosong</p><a href="/">Mulai belanja</a>' })
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
          <label for="voucher">Kode voucher</label>
          <input id="voucher" name="code" autocomplete="off" value="${esc(s.voucher ?? '')}">
          <button type="submit">Pakai</button>
        </form>
        <form id="checkout-form" action="/checkout" method="post">
          <label for="address">Alamat</label>
          <textarea id="address" name="address" rows="3" placeholder="Kosongkan untuk memakai alamat utama akun"></textarea>
          <fieldset>
            <legend>Metode pembayaran</legend>
            <label><input type="radio" name="payment" value="transfer_bank" checked> Transfer bank</label>
            <label><input type="radio" name="payment" value="ewallet"> E-wallet</label>
          </fieldset>
          <button type="submit">Bayar sekarang</button>
        </form>
      </div>
      <aside class="summary" aria-label="Ringkasan pesanan">
        <h2>Ringkasan</h2>
        <ul>${lines.map((l) => `<li>${esc(l.product.name)} (${l.size}) × ${l.qty} — ${rupiah(l.total)}</li>`).join('')}</ul>
        <p>Subtotal: <span data-testid="subtotal">${rupiah(subtotal)}</span></p>
        ${s.voucher ? `<p>Diskon (${esc(s.voucher)}): <span data-testid="discount">−${rupiah(discount)}</span></p>` : ''}
        <p class="total">Total: <strong data-testid="grand-total">${rupiah(grandTotal)}</strong></p>
      </aside>
    </div>`,
  })
}

function renderLogin(s, { error = false, email = '' } = {}) {
  return layout(s, {
    title: 'Masuk — Tokoku',
    body: `<h1>Masuk</h1>
    ${error ? '<p class="notice error" role="alert">Email atau password salah</p>' : ''}
    <form class="stack" action="/login" method="post">
      <label for="email">Email</label>
      <input id="email" name="email" type="email" autocomplete="username" value="${esc(email)}" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button type="submit">Masuk</button>
    </form>`,
  })
}

function renderAccount(s) {
  const mine = [...orders.values()].filter((o) => o.owner === s.user.email)
  return layout(s, {
    title: 'Akun — Tokoku',
    body: `<h1>Halo, ${esc(s.user.name)}</h1>
    <p class="muted">${esc(s.user.email)}</p>
    <h2>Pesanan saya</h2>
    ${mine.length
      ? `<ul>${mine.map((o) => `<li><a href="/akun/pesanan/${o.id}">${o.id}</a> — ${STATUS_LABEL[o.status]}</li>`).join('')}</ul>`
      : '<p class="empty">Belum ada pesanan.</p>'}`,
  })
}

function renderOrder(s, o) {
  return layout(s, {
    title: `Pesanan ${o.id} — Tokoku`,
    body: `<h1>Pesanan ${o.id}</h1>
    <p>Status: <strong data-testid="order-status">${STATUS_LABEL[o.status]}</strong></p>
    <p>Pembayaran: ${PAYMENT_LABEL[o.payment] ?? esc(o.payment)}</p>
    <p>Total: ${rupiah(o.total)}</p>
    <ul>${o.lines.map((l) => `<li>${esc(l.name)} (${l.size}) × ${l.qty}</li>`).join('')}</ul>`,
  })
}

function renderOrderSuccess(s, o) {
  return layout(s, {
    title: 'Pesanan berhasil — Tokoku',
    body: `<h1>Pesanan berhasil</h1>
    <p>Nomor pesanan: <strong data-testid="order-id">${o.id}</strong></p>
    <p>Status: ${STATUS_LABEL[o.status]}</p>
    ${o.status === 'awaiting_payment' && o.payment === 'transfer_bank'
      ? `<p>Silakan transfer ${rupiah(o.total)} ke BCA 123-456-7890 a.n. PT Tokoku Demo.</p>`
      : ''}
    <a href="/akun/pesanan/${o.id}">Lihat detail pesanan</a>`,
  })
}

function renderGateway(s, o) {
  // Pretends to be the external e-wallet sandbox ("sandbox.pay.tokoku.id"), served locally.
  return layout(s, {
    title: 'Tokoku Pay (sandbox)',
    body: `<h1>Tokoku Pay — sandbox</h1>
    <p>Gateway: sandbox.pay.tokoku.id</p>
    <p>Pesanan ${o.id}, total ${rupiah(o.total)}</p>
    <form action="/gateway/sandbox.pay.tokoku.id/${o.id}" method="post" class="row">
      <button type="submit" name="result" value="success">Simulasikan sukses</button>
      <button type="submit" name="result" value="failed">Simulasikan gagal</button>
    </form>`,
  })
}

function renderNotFound(s) {
  return layout(s, { title: 'Tidak ditemukan — Tokoku', body: '<h1>Halaman tidak ditemukan</h1><a href="/">Kembali ke beranda</a>' })
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
    const category = url.searchParams.get('kategori')
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
    if (!user) return apiError(res, 401, 'invalid_credentials', 'Email atau password salah')
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
  if (method === 'GET' && path === '/cari') return html(res, renderSearch(s, (url.searchParams.get('q') ?? '').trim()))
  if (method === 'GET' && path === '/kategori') {
    const selected = url.searchParams.getAll('kategori').flatMap((v) => v.split(',')).filter(Boolean)
    return html(res, renderCategory(s, selected))
  }

  const productMatch = /^\/produk\/([\w-]+)$/.exec(path)
  if (method === 'GET' && productMatch) {
    const p = PRODUCTS.find((x) => x.slug === productMatch[1])
    return p ? html(res, renderProduct(s, p, url.searchParams.has('ditambahkan'))) : html(res, renderNotFound(s), 404)
  }

  if (method === 'GET' && path === '/login') return html(res, renderLogin(s))
  if (method === 'POST' && path === '/login') {
    const form = await readForm(req)
    const user = USERS.find((u) => u.email === form.email && u.password === form.password)
    if (!user) return html(res, renderLogin(s, { error: true, email: form.email }), 401)
    s.user = { email: user.email, name: user.name }
    return redirect(res, '/akun')
  }
  if (method === 'POST' && path === '/logout') {
    s.user = null
    return redirect(res, '/login')
  }
  if (method === 'GET' && path === '/akun') {
    return s.user ? html(res, renderAccount(s)) : redirect(res, '/login?next=%2Fakun')
  }

  const orderMatch = /^\/akun\/pesanan\/([\w-]+)$/.exec(path)
  if (method === 'GET' && orderMatch) {
    // Order pages are reachable by their (unguessable in real life) id without login, so an
    // order created through the API can be verified in a fresh browser.
    const o = orders.get(orderMatch[1])
    return o ? html(res, renderOrder(s, o)) : html(res, renderNotFound(s), 404)
  }

  if (method === 'GET' && path === '/keranjang') return html(res, renderCart(s))
  if (method === 'POST' && path === '/keranjang/tambah') {
    const form = await readForm(req)
    const sku = `${form.code}-${form.size}`
    if (!productBySku(sku)) return html(res, renderNotFound(s), 404)
    const line = s.cart.find((l) => l.sku === sku)
    if (line) line.qty = Math.min(99, line.qty + 1)
    else s.cart.push({ sku, qty: 1 })
    return redirect(res, `/produk/${encodeURIComponent(form.slug)}?ditambahkan=1`)
  }
  if (method === 'POST' && path === '/keranjang/ubah') {
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
  if (method === 'POST' && path === '/keranjang/hapus') {
    const form = await readForm(req)
    s.cart.splice(Number(form.line), 1)
    return redirect(res, '/keranjang')
  }

  if (method === 'GET' && path === '/checkout') return html(res, renderCheckout(s))
  if (method === 'POST' && path === '/checkout/voucher') {
    const code = String((await readForm(req)).code ?? '').trim().toUpperCase()
    if (VOUCHERS[code]) {
      s.voucher = code
      s.flash = { text: `Voucher ${code} dipakai` }
    } else {
      s.voucher = null
      s.flash = { text: 'Kode voucher tidak valid', error: true }
    }
    return redirect(res, '/checkout')
  }
  if (method === 'POST' && path === '/checkout') {
    if (!s.cart.length) return redirect(res, '/keranjang')
    const form = await readForm(req)
    const payment = form.payment === 'ewallet' ? 'ewallet' : 'transfer_bank'
    const order = createOrder({ items: s.cart, address: form.address, payment, voucher: s.voucher, source: 'web' })
    order.owner = s.user?.email ?? null
    s.cart = []
    s.voucher = null
    return redirect(res, payment === 'ewallet' ? `/gateway/sandbox.pay.tokoku.id/${order.id}` : `/pesanan/${order.id}/berhasil`)
  }

  const gatewayMatch = /^\/gateway\/sandbox\.pay\.tokoku\.id\/([\w-]+)$/.exec(path)
  if (gatewayMatch) {
    const o = orders.get(gatewayMatch[1])
    if (!o) return html(res, renderNotFound(s), 404)
    if (method === 'GET') return html(res, renderGateway(s, o))
    if (method === 'POST') {
      const form = await readForm(req)
      if (form.result === 'success') o.status = 'paid'
      return redirect(res, form.result === 'success' ? `/pesanan/${o.id}/berhasil` : `/akun/pesanan/${o.id}`)
    }
  }

  const successMatch = /^\/pesanan\/([\w-]+)\/berhasil$/.exec(path)
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
  console.log(`  BASE_URL=http://localhost:${port}  API_URL=http://localhost:${port}/api`)
})

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close()
    server.closeAllConnections()
    process.exit(0)
  })
}
