# @qatlas/demo-target — "Tokoku"

A tiny, dependency-free fake Indonesian shop used as the target app for QAtlas runner tests and
demos. Node `http` server, server-rendered HTML, one CSS and one JS file, all state in memory.

```bash
node demo-target/server.mjs                 # http://localhost:8099
PORT=0 node demo-target/server.mjs          # random free port, printed on the first stdout line
```

Use with the SHOP environment: `BASE_URL=http://localhost:8099`, `API_URL=http://localhost:8099/api`,
secrets `QA_PASSWORD=Qa-Staging-2026!`, `ADMIN_TOKEN=adm_stg_8f3a`.

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8099` | listen port (`0` = random) |
| `HOST` | `127.0.0.1` | listen address |
| `DEMO_QA_PASSWORD` | `Qa-Staging-2026!` | password of `qa.bot@tokoku.id` ("QA Bot") |
| `DEMO_ADMIN_TOKEN` | `adm_stg_8f3a` | static bearer token accepted by `POST /api/v1/orders` |

## Pages

| Path | What |
|---|---|
| `/` | title "Tokoku — Belanja hemat setiap hari", header `navigation` "Utama", search `Cari produk` |
| `/cari?q=` | search results, `testid=product-card` |
| `/kategori` | checkboxes "Pakaian pria" / "Pakaian wanita" / "Aksesoris" → `?kategori=pakaian-pria`, heading with the category name |
| `/produk/kaos-polos-hitam` | `testid=product-price` "Rp 90.000", `testid=stock-label` "Stok: 12", select `Ukuran`, "Tambah ke keranjang" → "Berhasil ditambahkan ke keranjang" |
| `/keranjang` | `Jumlah` inputs (saved on change), "Hapus item", empty state "Keranjang kamu kosong" |
| `/checkout` | `Kode voucher` + "Pakai", `Alamat`, radios "Transfer bank" / "E-wallet", "Bayar sekarang", `testid=grand-total` |
| `/login` | `Email`, `Password`, "Masuk"; wrong password → "Email atau password salah"; success → `/akun` "Halo, QA Bot" |
| `/akun` | account page (guests are redirected to `/login`) |
| `/akun/pesanan/<id>` | order detail ("Menunggu pembayaran" / "Lunas"); public, so API-created orders can be checked in a fresh browser |
| `/gateway/sandbox.pay.tokoku.id/<id>` | fake e-wallet sandbox: "Simulasikan sukses" → "Pesanan berhasil" |
| `/pesanan/<id>/berhasil` | heading "Pesanan berhasil", `testid=order-id` |

Header on every page: `testid=cart-count` (number of distinct cart lines) and an "Akun saya" menu
button with menu items (account / "Keluar"). "Keluar" always works (also for guests) → `/login`.

**Demo cart:** every new browser session starts with 1× Kaos Polos Hitam (L) in the cart, so cart
and checkout cases can run on their own. Adding the same product/size merges into that line
(`cart-count` stays `1`).

**Intentional bug:** voucher `HEMAT10` shows "Voucher HEMAT10 dipakai" and a 10% discount line,
but `testid=grand-total` stays **Rp 90.000** (the seeded voucher case expects Rp 81.000 and fails).

## JSON API

| Endpoint | Result |
|---|---|
| `GET /api/v1/products?limit=&q=&kategori=` | `200 {data:[{id,slug,name,price,stock,category}], meta:{total,limit}}` |
| `GET /api/v1/products/{id or slug}` | `200 {data}` / 404 |
| `POST /api/v1/auth/login {email,password}` | `201 {data:{token,user}}` / `401 {error:{code:"invalid_credentials"}}` |
| `POST /api/v1/orders {sku:"KPH-L",qty}` + `Authorization: Bearer <token>` | `201 {data:{id,status,total}}` / 401 / 422 |
| `GET /api/v1/orders/{id}` | `200 {data}` / 404 |
| `GET /api/health` | `200 {ok:true}` |

Bearer tokens: `DEMO_ADMIN_TOKEN` or any token returned by the login endpoint. SKUs are
`<code>-<size>` (`KPH`, `KPP`, `KFK`, `BLN`, `TPB`, `TSK` × `S`/`M`/`L`/`XL`).
