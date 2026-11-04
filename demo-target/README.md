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
node demo-target/server.mjs                 # http://localhost:8099, English (sign-up mail → 127.0.0.1:1025)
DEMO_LANG=id node demo-target/server.mjs    # Indonesian
PORT=0 node demo-target/server.mjs          # random free port, printed on the first stdout line
```

Use with the SHOP environment: `BASE_URL=http://localhost:8099`, `API_URL=http://localhost:8099/api`,
`MAILPIT_URL=http://localhost:8025`, secrets `QA_PASSWORD=Qa-Staging-2026!`, `ADMIN_TOKEN=adm_stg_8f3a`,
`QA_TOTP_SEED=TOKOKU2FADEMOSEEDQATLASTOTPDEMOA` (`qatlas seed demo` sets
`BASE_URL`/`API_URL`/`MAILPIT_URL`/`QA_PASSWORD`/`QA_TOTP_SEED` for you — `--target-url`,
`--mailpit-url`, `--qa-totp-seed`; pass `--admin-token` = `DEMO_ADMIN_TOKEN` for SHOP-T17).
`scripts/demo-server.sh` and `scripts/e2e-real.sh` also start Mailpit for the sign-up cases
(SHOP-T21, SHOP-T22).

| Env | Default | Meaning |
|---|---|---|
| `PORT` | `8099` | listen port (`0` = random) |
| `HOST` | `127.0.0.1` | listen address |
| `DEMO_LANG` | `en` | `en` or `id` |
| `DEMO_QA_PASSWORD` | `Qa-Staging-2026!` | password of `qa.bot@tokoku.id` ("QA Bot") |
| `DEMO_ADMIN_TOKEN` | `adm_stg_8f3a` | static bearer token accepted by `POST /api/v1/orders` |
| `DEMO_TOTP_SEED` | `TOKOKU2FADEMOSEEDQATLASTOTPDEMOA` | base32 TOTP seed of `qa.2fa@tokoku.id` (**demo-only, public** — it protects nothing) |
| `DEMO_SMTP_HOST` / `DEMO_SMTP_PORT` | `127.0.0.1` / `1025` | SMTP server for sign-up emails, e.g. [Mailpit](https://mailpit.axllent.org) (no TLS, no AUTH) |
| `DEMO_PUBLIC_URL` | `http://localhost:<port>` | base URL of the link in the verification email (must be reachable by the runner's browser) |
| `DEMO_MAIL_DELAY_MS` | `1500` | the sign-up email is delivered this long after the "Check your email" page, like a mail queue (`0` = before the page) |

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
| `/login/2fa` | same | after a correct password for a TOTP user: `Authentication code` / `Kode autentikasi` + "Verify" / "Verifikasi"; wrong code → "Invalid authentication code" / "Kode autentikasi salah" (5 wrong codes → back to `/login`) |
| `/signup` | same | `Name` / `Nama`, `Email`, `Password` (≥ 8 characters), "Create account" / "Buat akun" → sends the verification email → `/verify?email=…` |
| `/verify?email=` | same | "Check your email" / "Cek email kamu" with the code form: `Verification code` / `Kode verifikasi` + "Verify" / "Verifikasi"; wrong code → "Invalid verification code" |
| `/verify?token=` | same | link from the email → "Email verified" / "Email terverifikasi" (the account can log in from now on); unknown/expired/used token → 400 "This verification link is invalid or has expired" |
| `/account` | `/akun` | account page (guests are redirected to `/login`) |
| `/account/orders/<id>` | `/akun/pesanan/<id>` | order detail ("Awaiting payment" / "Menunggu pembayaran", "Paid" / "Lunas"); public, so API-created orders can be checked in a fresh browser |
| `/gateway/sandbox.pay.tokoku.id/<id>` | same | fake e-wallet sandbox: "Simulate success" / "Simulasikan sukses" → order placed |
| `/orders/<id>/success` | `/pesanan/<id>/berhasil` | heading "Order placed" / "Pesanan berhasil", `testid=order-id` |

Header on every page: `testid=cart-count` (number of distinct cart lines) and a "My account" /
"Akun saya" menu button with menu items (account / "Log out" / "Keluar"). Logging out always works
(also for guests) → `/login`.

**Accounts:** `qa.bot@tokoku.id` ("QA Bot") and `qa.2fa@tokoku.id` ("QA 2FA", TOTP enabled), both
with `DEMO_QA_PASSWORD`. `qa.2fa` gets `/login/2fa` after the password; the code is RFC 6238 (SHA-1,
6 digits, 30 s) from `DEMO_TOTP_SEED`, and the previous/next period are accepted too. In QAtlas:
`{{fn.totp secret.QA_TOTP_SEED}}`. Accounts created through `/signup` live in memory like everything
else.

**Sign-up email:** `/signup` sends one `multipart/alternative` message (text + HTML, both
quoted-printable) from `no-reply@tokoku.id`, subject "Verify your Tokoku account" / "Verifikasi akun
Tokoku kamu", containing "Your verification code is 123456" and the link
`${DEMO_PUBLIC_URL}/verify?token=…` (30 minutes, single use). Any address with a dot in the domain
is accepted (also `qa+abc@example.com` from `{{fn.random_email}}`). The email arrives
`DEMO_MAIL_DELAY_MS` after the page, so test cases have to poll the inbox. The SMTP server is checked
before the page is shown: if it is unreachable the page says so (502 "We couldn't send the
verification email") and no account is created.

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
| `POST /api/v1/auth/login {email,password,totp?}` | `201 {data:{token,user}}` / `401 {error:{code:"invalid_credentials"}}`; TOTP users also need `totp` (`401 totp_required` / `invalid_totp`) |
| `POST /api/v1/orders {sku:"PBT-L",qty}` + `Authorization: Bearer <token>` | `201 {data:{id,status,total}}` / 401 / 422 |
| `GET /api/v1/orders/{id}` | `200 {data}` / 404 |
| `GET /api/health` | `200 {ok:true}` |

Bearer tokens: `DEMO_ADMIN_TOKEN` or any token returned by the login endpoint. SKUs are
`<code>-<size>` with sizes `S`/`M`/`L`/`XL`; codes `PBT`, `PWT`, `PFS`, `LBL`, `BBC`, `CVT` (`en`)
or `KPH`, `KPP`, `KFK`, `BLN`, `TPB`, `TSK` (`id`).
