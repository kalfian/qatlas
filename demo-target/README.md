# @qatlas/demo-target — "Tokoku"

A tiny, dependency-free fake shop used as the target app for QAtlas runner tests and demos. Node
`http` server, server-rendered HTML, one CSS and one JS file, all state in memory.

It speaks two languages (pages, paths, catalog), chosen at start with `DEMO_LANG`:

- `en` (default) — matches the demo seed: the web mock (`web/src/mocks/seed.ts`) and
  `qatlas seed demo` (`backend/internal/seed/demo.json`). Every automated SHOP case passes except
  the intentional voucher bug below.
- `id` — the original Indonesian shop, used by the runner integration tests and
  `runner/scripts/smoke.mjs` (`runner/scripts/shop-cases.mjs`).

```bash
node demo-target/server.mjs                 # http://localhost:8099, English
DEMO_LANG=id node demo-target/server.mjs    # Indonesian
PORT=0 node demo-target/server.mjs          # random free port, printed on the first stdout line
```

Use with the SHOP environment: `BASE_URL=http://localhost:8099`, `API_URL=http://localhost:8099/api`,
secrets `QA_PASSWORD=Qa-Staging-2026!`, `ADMIN_TOKEN=adm_stg_8f3a` (`qatlas seed demo` sets
`BASE_URL`/`API_URL`/`QA_PASSWORD` for you; pass `--admin-token` = `DEMO_ADMIN_TOKEN` for
SHOP-T17).

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8099` | listen port (`0` = random) |
| `HOST` | `127.0.0.1` | listen address |
| `DEMO_LANG` | `en` | `en` or `id` |
| `DEMO_QA_PASSWORD` | `Qa-Staging-2026!` | password of `qa.bot@tokoku.id` ("QA Bot") |
| `DEMO_ADMIN_TOKEN` | `adm_stg_8f3a` | static bearer token accepted by `POST /api/v1/orders` |

## Pages

| `en` path | `id` path | What (`en` / `id` labels) |
|---|---|---|
| `/` | `/` | title "Tokoku — Everyday savings" / "Tokoku — Belanja hemat setiap hari", header `navigation` "Main" / "Utama", search "Search products" / "Cari produk" |
| `/search?q=` | `/cari?q=` | search results, `testid=product-card` |
| `/categories` | `/kategori` | checkboxes "Menswear" / "Ladieswear" / "Accessories" → `?category=menswear` (id: "Pakaian pria"… → `?kategori=pakaian-pria`), heading with the category name |
| `/products/plain-black-tee` | `/produk/kaos-polos-hitam` | `testid=product-price` "Rp 90.000", `testid=stock-label` "Stock: 12" / "Stok: 12", select "Size" / "Ukuran", "Add to cart" / "Tambah ke keranjang" → "Added to cart" / "Berhasil ditambahkan ke keranjang" |
| `/cart` | `/keranjang` | "Quantity" / "Jumlah" inputs (saved on change), "Remove item" / "Hapus item", empty state "Your cart is empty" / "Keranjang kamu kosong" |
| `/checkout` | `/checkout` | "Voucher code" + "Apply" / "Kode voucher" + "Pakai", "Address" / "Alamat", radios "Bank transfer" / "Transfer bank" and "E-wallet", "Pay now" / "Bayar sekarang", `testid=grand-total` |
| `/login` | `/login` | `Email`, `Password`, "Log in" / "Masuk"; wrong password → "Incorrect email or password" / "Email atau password salah"; success → `/account` "Hi, QA Bot" / `/akun` "Halo, QA Bot" |
| `/account` | `/akun` | account page (guests are redirected to `/login`) |
| `/account/orders/<id>` | `/akun/pesanan/<id>` | order detail ("Awaiting payment" / "Menunggu pembayaran", "Paid" / "Lunas"); public, so API-created orders can be checked in a fresh browser |
| `/gateway/sandbox.pay.tokoku.id/<id>` | same | fake e-wallet sandbox: "Simulate success" / "Simulasikan sukses" → order placed |
| `/orders/<id>/success` | `/pesanan/<id>/berhasil` | heading "Order placed" / "Pesanan berhasil", `testid=order-id` |

Header on every page: `testid=cart-count` (number of distinct cart lines) and a "My account" /
"Akun saya" menu button with menu items (account / "Log out" / "Keluar"). Logging out always works
(also for guests) → `/login`.

**Demo cart:** every new browser session starts with 1× the first product (Plain Black Tee /
Kaos Polos Hitam, size L) in the cart, so cart and checkout cases can run on their own. Adding the
same product/size merges into that line (`cart-count` stays `1`).

**Intentional bug:** voucher `HEMAT10` shows "Voucher HEMAT10 applied" / "Voucher HEMAT10 dipakai"
and a 10% discount line, but `testid=grand-total` stays **Rp 90.000** (the seeded voucher case
expects Rp 81.000 and fails).

## JSON API

| Endpoint | Result |
|---|---|
| `GET /api/v1/products?limit=&q=&category=` (or `kategori=`) | `200 {data:[{id,slug,name,price,stock,category}], meta:{total,limit}}` |
| `GET /api/v1/products/{id or slug}` | `200 {data}` / 404 |
| `POST /api/v1/auth/login {email,password}` | `201 {data:{token,user}}` / `401 {error:{code:"invalid_credentials"}}` |
| `POST /api/v1/orders {sku:"PBT-L",qty}` + `Authorization: Bearer <token>` | `201 {data:{id,status,total}}` / 401 / 422 |
| `GET /api/v1/orders/{id}` | `200 {data}` / 404 |
| `GET /api/health` | `200 {ok:true}` |

Bearer tokens: `DEMO_ADMIN_TOKEN` or any token returned by the login endpoint. SKUs are
`<code>-<size>` with sizes `S`/`M`/`L`/`XL`; codes `PBT`, `PWT`, `PFS`, `LBL`, `BBC`, `CVT` (`en`)
or `KPH`, `KPP`, `KFK`, `BLN`, `TPB`, `TSK` (`id`).
