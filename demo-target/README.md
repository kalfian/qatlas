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
PAY environment: `API_URL=http://localhost:8099/api/v2`, secret `API_KEY=demo_pay_key_123`
(`qatlas seed demo` sets both — `--target-url`, `--pay-api-key`).
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
| `DEMO_API_KEY` | `demo_pay_key_123` | `X-Api-Key` of the Tokoku Pay API (`/api/v2`; **demo-only, public**) — `qatlas seed demo --pay-api-key` |
| `DEMO_REFUND_DELAY_MS` | `2000` | a refund is `pending` this long after it was created, then `succeeded` (for polling demos) |
| `DEMO_WEBHOOK_SECRET` | `whsec_demo_123` | HMAC-SHA256 key of the signatures returned by `POST /api/v2/test/webhooks` |
| `DEMO_RATE_LIMIT` | `600` | API reads (GET) per client (bearer token, API key or address) per minute; over it → `429` |

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

Two small REST APIs for API-testing demos (the SHOP "API" cases SHOP-T15…T17, SHOP-T23…T27, flow
SHOP-F4, and the PAY project). English responses, JSON everywhere (except `GET /api/v2/health`).

- Every response (pages too) has `X-Request-Id` (`req_…`; a sane incoming `X-Request-Id` is echoed).
- API reads (`GET`) have `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (seconds);
  over `DEMO_RATE_LIMIT` per minute → `429 rate_limited` + `Retry-After`.
- Errors: `{"error":{"code","message","details?"}}`; `details` = `[{path, message}]`, one per invalid
  field (422). Unknown endpoint → 404 `not_found`; known path, wrong method → 405
  `method_not_allowed` + `Allow`; malformed JSON / not an object → 400 `bad_request`.
- Missing/invalid bearer token → `401 unauthenticated` with `WWW-Authenticate: Bearer realm="tokoku"`
  (invalid/expired token: `…, error="invalid_token", …`).

### `/api/v1` — Tokoku shop

| Endpoint | Result |
|---|---|
| `GET /api/health` | `200 {ok:true}` |
| `POST /api/v1/auth/login {email,password,totp?}` | `201 {data:{token,token_type:"Bearer",expires_in:3600,user:{email,name}}}`; wrong credentials `401 invalid_credentials`; missing fields `422`; TOTP users also need `totp` (`401 totp_required` / `invalid_totp`) |
| `GET /api/v1/me` + Bearer | `200 {data:{email,name,role,two_factor}}` / `401` + `WWW-Authenticate` |
| `GET /api/v1/products?limit=&offset=&category=&q=` | `200 {data:[{id,slug,name,price,stock,category}], meta:{total,limit,offset,count,next_offset}}` (`limit` 1–100, default 20; `kategori=` also works). With a Bearer token your own products are listed too |
| `GET /api/v1/products/{id or slug}` | `200 {data}` / `404 {error:{code:"not_found"}}` |
| `POST /api/v1/products {name,price,stock?,category?}` + Bearer | `201 {data}` + `Location: /api/v1/products/prd_…`; invalid → `422 validation_failed` with `details` (`name` required ≤ 120 chars, `price` integer 1–100000000, `stock` integer 0–100000, `category` one of the categories) |
| `PATCH /api/v1/products/{id}` + Bearer | `200 {data}` (only the given fields, same validation); catalog products → `403 forbidden` |
| `DELETE /api/v1/products/{id}` + Bearer | `204`; afterwards `GET` → `404` |
| `POST /api/v1/orders {sku:"PBT-L",qty}` + Bearer | `201 {data:{id,status,total}}` + `Location` / `401` / `422` |
| `GET /api/v1/orders/{id}` | `200 {data}` / `404` |
| `GET /api/v1/slow?ms=` | waits `ms` (capped at 10000), then `200 {data:{requested_ms,delayed_ms,max_ms}}` — for `expect_response_time` |

Bearer tokens: `DEMO_ADMIN_TOKEN` or a token from the login endpoint (valid 1 hour). Products
created through the API live in memory **per token** (other tokens, and requests without a token,
get 404), so parallel test runs don't collide; at most 100 per token. Everything resets on restart.
SKUs are `<code>-<size>` with sizes `S`/`M`/`L`/`XL`; codes `PBT`, `PWT`, `PFS`, `LBL`, `BBC`, `CVT`
(`en`) or `KPH`, `KPP`, `KFK`, `BLN`, `TPB`, `TSK` (`id`).

### `/api/v2` — Tokoku Pay

Every endpoint except `/api/v2/health` needs `X-Api-Key: <DEMO_API_KEY>` (missing → `401
missing_api_key`, wrong → `401 invalid_api_key`). Amounts are integers in the smallest unit.

| Endpoint | Result |
|---|---|
| `GET /api/v2/health` | `200` `ok` (text/plain, no key needed) |
| `POST /api/v2/payment-intents {amount,currency,description?}` | `201 {data:{id:"pi_…",object,amount,currency,status:"requires_payment",amount_refunded,amount_refundable,…}}` + `Location`; `currency` one of `IDR`/`USD`/`SGD`, else `422` |
| `GET /api/v2/payment-intents/{id}` | `200 {data}` / `404` |
| `POST /api/v2/payment-intents/{id}/confirm` | `200 {data:{status:"succeeded",confirmed_at,…}}` (idempotent) |
| `POST /api/v2/refunds {payment_intent,amount?,reason?}` | `201 {data:{id:"re_…",status:"pending",succeeded_at:null,…}}` + `Location`; becomes `succeeded` (with `succeeded_at`) `DEMO_REFUND_DELAY_MS` later. Without `amount` = everything left. Intent not paid → `409 invalid_state`; more than what is left → `422 amount_exceeds_refundable`, `details[0].path = "amount"` |
| `GET /api/v2/refunds/{id}` | `200 {data}` (status computed on read) / `404` |
| `POST /api/v2/test/webhooks {event}` | `200 {delivered:true,event,id,signature:"t=<unix>,v1=<hex>",payload}` — nothing is sent; `v1` = HMAC-SHA256(`DEMO_WEBHOOK_SECRET`, `"<t>.<payload>"`). `event` one of `payment.succeeded`, `payment.failed`, `refund.succeeded`, `refund.failed`, else `422` |

Polling a refund in a test case: `poll_until: "$.data.succeeded_at"` (null while pending), see
[docs/manual](../docs/manual/README.md#api-testing).

```bash
B=http://localhost:8099/api
TOKEN=$(curl -s -XPOST $B/v1/auth/login -d '{"email":"qa.bot@tokoku.id","password":"Qa-Staging-2026!"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).data.token')
curl -i -XPOST $B/v1/products -H "Authorization: Bearer $TOKEN" -d '{"name":"QA Mug","price":45000}'
curl -i -XPOST $B/v2/payment-intents -H 'X-Api-Key: demo_pay_key_123' -d '{"amount":90000,"currency":"IDR"}'
```
