# 04 — Test Definition (Step DSL)

Test case disimpan sebagai **data terstruktur (JSON)**, bukan kode. Alasannya:

- Bisa diedit lewat UI (form per step) maupun oleh AI via MCP.
- Bisa divalidasi dengan satu **JSON Schema** (`backend/schema/step-dsl.schema.json`) yang dipakai BE, FE, dan diekspos ke AI.
- Step yang sama juga terbaca manusia (`description` + `expected`) → berfungsi sebagai dokumentasi test case manual.

## Bentuk test case

```json
{
  "title": "User bisa login dengan email & password",
  "priority": "high",
  "status": "ready",
  "tags": ["auth", "smoke"],
  "variables": { "email": "qa@example.com" },
  "steps": [
    { "id": "s1", "action": "goto", "url": "{{env.BASE_URL}}/login",
      "description": "Buka halaman login" },
    { "id": "s2", "action": "fill", "selector": "label=Email", "value": "{{vars.email}}" },
    { "id": "s3", "action": "fill", "selector": "label=Password", "value": "{{secret.QA_PASSWORD}}" },
    { "id": "s4", "action": "click", "selector": "role=button[name='Masuk']" },
    { "id": "s5", "action": "expect_url", "value": "/dashboard", "match": "contains",
      "description": "Diarahkan ke dashboard", "expected": "URL mengandung /dashboard" },
    { "id": "s6", "action": "expect_visible", "selector": "text=Selamat datang" }
  ]
}
```

## Field umum setiap step

| Field | Wajib | Keterangan |
|-------|-------|-----------|
| `id` | ya | ID stabil (untuk diff revisi & mapping hasil) |
| `action` | ya | Lihat tabel action |
| `description` | tidak | Kalimat manusia; ditampilkan di report |
| `expected` | tidak | Hasil yang diharapkan (teks) |
| `timeout_ms` | tidak | Override timeout default (10000) |
| `continue_on_failure` | tidak | Default `false` → step sisanya di-skip jika gagal |
| `enabled` | tidak | Default `true` |
| `screenshot` | tidak | Paksa screenshot setelah step ini, apa pun opsi run |

## Action v1

### Browser (UI)

| Action | Parameter | Catatan |
|--------|-----------|---------|
| `goto` | `url` | |
| `click`, `dblclick`, `hover` | `selector` | |
| `fill` | `selector`, `value` | Kosongkan lalu isi |
| `type` | `selector`, `value`, `delay_ms?` | Ketik per karakter |
| `press` | `key`, `selector?` | Mis. `Enter`, `Control+A` |
| `select_option` | `selector`, `value` / `label` | |
| `check`, `uncheck` | `selector` | |
| `wait_for` | `selector`, `state` (`visible`/`hidden`/`attached`) | Lebih disarankan daripada `wait` |
| `screenshot` | `name?`, `full_page?` | Screenshot eksplisit |
| `extract_text` | `selector`, `save_as` | Simpan ke `vars` |
| `expect_visible`, `expect_hidden` | `selector` | |
| `expect_text` | `selector`, `value`, `match` (`equals`/`contains`/`regex`) | |
| `expect_value` | `selector`, `value`, `match` | Nilai input |
| `expect_url`, `expect_title` | `value`, `match` | |
| `expect_count` | `selector`, `value` (int), `op` (`eq`/`gte`/`lte`) | |

**Selector** dipetakan runner ke locator Playwright resmi:

| Selector DSL | Locator Playwright |
|--------------|--------------------|
| `role=button[name='Masuk']` | `page.getByRole('button', { name: 'Masuk' })` |
| `label=Email` | `page.getByLabel('Email')` |
| `placeholder=Cari` | `page.getByPlaceholder('Cari')` |
| `testid=submit` | `page.getByTestId('submit')` |
| `text=Selamat datang` | `page.getByText('Selamat datang')` |
| lainnya (`#id`, `.btn`, `xpath=...`) | `page.locator(...)` |

Rekomendasi di UI & ke AI: utamakan `role`/`label`/`testid` daripada CSS rapuh. Semua aksi memakai auto-wait Playwright.

### HTTP (API)

| Action | Parameter |
|--------|-----------|
| `http_request` | `method`, `url`, `headers?`, `query?`, `body?` (json/text/form), `save?` (`{ "token": "$.data.token" }` → JSONPath ke `vars`), `save_regex?` (`{ "otp": "code: (\\d{6})" }` → regex ke `vars`), `regex_decode?` (`none`/`quoted_printable`/`html`/`auto`), `poll_timeout_ms?`, `poll_interval_ms?`, `poll_until?` — lihat [Email testing](#email-testing-mailpit--mailhog) |
| `expect_status` | `value` (int) atau `in` (array) |
| `expect_json` | `path` (JSONPath), `op` (`eq`,`neq`,`contains`,`exists`,`gt`,`lt`,`matches`), `value?` |
| `expect_header` | `name`, `value`, `match` |
| `expect_response_time` | `max_ms` |

Assertion HTTP berlaku terhadap **response `http_request` terakhir**. Dieksekusi dengan Playwright `APIRequestContext`; jika test/flow punya browser context, dipakai `context.request` sehingga cookie sesi UI ikut terkirim.

Contoh lengkap — token chaining (`save` → header `Authorization: Bearer {{vars.token}}`), CRUD (201 + `Location` → 204 → 404), negative test (422 dengan `$.error.details[0].path`, 401 + `WWW-Authenticate`), `query`, `expect_header` regex, `expect_response_time`, dan polling refund sampai `succeeded` (`poll_until: $.data.succeeded_at`): [manual → API testing](manual/README.md#api-testing) ([ID](manual/README.id.md#api-testing)), test case demo SHOP-T23…T27 dan PAY-T1…T3 (flow SHOP-F4), dijalankan terhadap REST API `demo-target` ([endpoint](../demo-target/README.md#json-api)).

### Umum

| Action | Parameter |
|--------|-----------|
| `set_variable` | `name`, `value` |
| `wait` | `ms` (maks 30000; ditandai warning di UI) |

Satu test case boleh mencampur step UI dan HTTP (mis. buat data via API, verifikasi via UI). Browser hanya di-launch jika ada step UI.

## Test case manual

Untuk skenario yang tidak bisa/tidak layak diotomasi. Test case diberi `"execution": "manual"` dan semua step memakai action `manual`:

```json
{
  "title": "Login dengan OTP SMS",
  "execution": "manual",
  "steps": [
    { "id": "m1", "action": "manual",
      "description": "Buka {{env.BASE_URL}}/login dan masukkan nomor 0812xxxx",
      "expected": "Form OTP muncul dan SMS diterima < 30 detik" },
    { "id": "m2", "action": "manual",
      "description": "Masukkan kode OTP dari SMS",
      "expected": "Masuk ke dashboard" }
  ]
}
```

- Saat run, variable non-secret di-interpolasi agar tester melihat nilai sebenarnya; `secret.*` hanya tampil sebagai nama.
- Tester menandai setiap step `passed` / `failed` / `blocked` / `skipped`, mengisi *actual result*, dan boleh melampirkan file (screenshot/video dari perangkatnya).
- v1: action `manual` hanya boleh di test case `manual`, dan test case `automated` tidak boleh berisi step `manual`. (Kandidat lanjutan: step manual di tengah test automated.)
- Mengubah `execution` test case yang sudah punya step → UI meminta konfirmasi (step automated berubah jadi teks instruksi, atau sebaliknya perlu ditulis ulang).

## Variable & interpolasi

Sintaks `{{...}}`, dievaluasi tepat sebelum step dijalankan.

| Namespace | Sumber | Contoh |
|-----------|--------|--------|
| `env.*` | Variable environment yang dipilih saat run | `{{env.BASE_URL}}` |
| `secret.*` | Secret environment (terenkripsi; **dimask `••••` di report, log, dan output MCP**) | `{{secret.QA_PASSWORD}}` |
| `vars.*` | Variable test case/flow + hasil `save`/`extract_text`/`set_variable` | `{{vars.token}}` |
| `fn.*` | Built-in | `{{fn.uuid}}`, `{{fn.now}}`, `{{fn.random_email}}`, `{{fn.random_int 1 100}}`, `{{fn.totp secret.OTP_SEED}}` ([2FA](#2fa-totp)) |

Urutan prioritas (yang belakang menimpa): environment → flow variables → test case variables → runtime (`save`/`set_variable`).

## 2FA (TOTP)

`{{fn.totp <ref> [digits=6] [period=30] [algorithm=SHA1|SHA256|SHA512]}}` menghasilkan kode TOTP (RFC 6238) — kode yang sama dengan aplikasi authenticator.

| Bagian | Keterangan |
|--------|-----------|
| `<ref>` (wajib, argumen pertama) | `secret.NAMA`, `env.NAMA`, `vars.nama` (di-resolve seperti variable biasa; nilainya = seed **base32**), atau seed base32 literal. Spasi, `-`, huruf kecil, dan padding `=` ditoleransi (mis. `jbsw y3dp ehpk 3pxp`). Seed literal tidak boleh mengandung spasi. |
| `digits=` | 6–8, default 6 |
| `period=` | 10–300 detik, default 30 |
| `algorithm=` | `SHA1` (default), `SHA256`, `SHA512` (case-insensitive) |

- Kode dihitung **saat step dieksekusi** (tepat sebelum interpolasi step). Jika sisa periode < 3 detik, runner menunggu periode berikutnya dulu agar kode tidak kedaluwarsa saat dicek target.
- Seed tidak valid / ref tidak dikenal → step `failed` dengan pesan jelas (`Invalid {{fn.totp secret.OTP_SEED}}: the seed is not valid base32 …`); seed **tidak pernah** dicetak (seed literal ditampilkan sebagai `{{fn.totp …}}`).
- Ringkasan/report menampilkan ekspresinya (`Fill label=Kode with "{{fn.totp secret.OTP_SEED}}"`). Kode yang dihasilkan (dan seed-nya) diperlakukan seperti secret: dimask `••••` di semua event runner sesudahnya.
- Validasi (editor, `POST …/validate`, MCP): argumen `fn.totp` yang salah = **error**; fungsi `fn.*` yang tidak dikenal = **warning**.

```json
{ "id": "s5", "action": "fill", "selector": "label=Kode autentikasi", "value": "{{fn.totp secret.QA_TOTP_SEED}}" }
```

Seed dari halaman setup 2FA aplikasi: `extract_text` (`save_as: "otp_seed"`) lalu `{{fn.totp vars.otp_seed}}`.

## Email testing (Mailpit / MailHog)

`http_request` bisa **menunggu** sesuatu yang asinkron (email masuk, job selesai) dan **mengambil** kode/link dari teks dengan regex.

| Param | Keterangan |
|-------|-----------|
| `save_regex` | Objek `{ "nama": "regex" }`. Regex JavaScript (`pola` atau `/pola/flags`). Nilai yang disimpan = capture group 1 jika ada, selain itu seluruh match. Dijalankan pada body response setelah `regex_decode`. Tidak cocok → step gagal: `Cannot save "otp": pattern /code: (\d{6})/ not found in the response` (kecuali sedang polling). |
| `regex_decode` | `none` (default, body apa adanya) · `quoted_printable` (soft line break `=\n` + `=XX` → UTF-8) · `html` (entitas `&amp;`, `&#39;`, `&#x41;` …) · `auto` (quoted-printable bila teks terlihat QP — ada soft line break, `=3D`, atau header `Content-Transfer-Encoding: quoted-printable` — lalu entitas HTML). Selain `none`, body **JSON** dicari pada nilai string-nya (sudah di-unescape, satu per baris), sehingga `\u0026`/`\n` dari encoder JSON tidak mengganggu. |
| `poll_timeout_ms` | `0`/kosong = kirim sekali. `1…120000` = kirim ulang sampai: status **2xx** **dan** `poll_until` (jika ada) ditemukan **dan** semua `save` (JSONPath) serta `save_regex` ter-resolve → step `passed` dan nilai disimpan. Habis waktu → `failed` dengan response terakhir di `details`, `details.attempts`, dan pesan berisi apa yang belum ditemukan. |
| `poll_interval_ms` | Jeda antar percobaan, default 1000, min 200. |
| `poll_until` | JSONPath yang harus ada dan bukan `null`/array kosong, mis. `$.messages[0]`. |

- Polling tidak dibatasi `timeout_ms` step (itu batas per request); total dibatasi `poll_timeout_ms`. Error jaringan saat polling dihitung "belum".
- Ringkasan menambah ` (poll ≤15s)`: `GET {{env.MAILPIT_URL}}/api/v1/search?query=to:{{vars.email}} (poll ≤15s)`.
- Gunakan param `query` (bukan menulis `?query=to:…` di URL) agar `+` di alamat email ter-encode (`%2B`); `+` mentah di URL dibaca server sebagai spasi.
- JSONPath `save`/`poll_until` yang salah sintaks dan regex yang tidak valid gagal seketika (tidak di-poll).

**Mailpit** (`MAILPIT_URL` = URL UI/API Mailpit, mis. `http://127.0.0.1:8025`) — diverifikasi dengan Mailpit v1.33.0:

| Endpoint | Isi |
|----------|-----|
| `GET /api/v1/search?query=to:<email>` | `{ total, count, messages: [{ ID, Subject, From, To, Snippet, … }] }` — kosong = `messages: []` dengan status 200 |
| `GET /api/v1/message/<ID>` | `{ ID, Subject, Text, HTML, From, To, … }` (`latest` = pesan terbaru) |
| `GET /view/<ID>.html`, `/view/<ID>.txt` | Body HTML / teks apa adanya (tanpa JSON) |
| `GET /api/v1/message/<ID>/raw` | Sumber email mentah (sering quoted-printable → `regex_decode: auto`) |

```json
[
  { "id": "e1", "action": "http_request", "method": "GET", "url": "{{env.MAILPIT_URL}}/api/v1/search",
    "query": { "query": "to:{{vars.email}}" }, "save": { "mail_id": "$.messages[0].ID" },
    "poll_timeout_ms": 15000, "description": "Tunggu email verifikasi" },
  { "id": "e2", "action": "http_request", "method": "GET", "url": "{{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}",
    "save": { "subject": "$.Subject" },
    "save_regex": { "otp": "code: (\\d{6})", "verify_link": "href=\"([^\"]+/verify[^\"]*)\"" }, "regex_decode": "auto" },
  { "id": "e3", "action": "expect_json", "path": "$.Subject", "op": "contains", "value": "Verifikasi" },
  { "id": "e4", "action": "goto", "url": "{{vars.verify_link}}" }
]
```

**MailHog** — `GET {{env.MAILHOG_URL}}/api/v2/search?kind=to&query=<email>` → `$.items[0].Content.Body` (body mentah, biasanya quoted-printable):

```json
{ "id": "h1", "action": "http_request", "method": "GET", "url": "{{env.MAILHOG_URL}}/api/v2/search",
  "query": { "kind": "to", "query": "{{vars.email}}" }, "poll_until": "$.items[0].Content.Body",
  "save_regex": { "reset_link": "href=\"([^\"]+)\"" }, "regex_decode": "auto", "poll_timeout_ms": 15000 }
```

## Flow

```json
{
  "name": "Checkout happy path",
  "shared_session": true,
  "stop_on_failure": true,
  "variables": { "product": "Kaos Polos" },
  "items": [
    { "test_case_id": "…SHOP-T1 (Login)…" },
    { "test_case_id": "…SHOP-T7 (Tambah ke keranjang)…" },
    { "test_case_id": "…SHOP-T9 (Checkout)…", "continue_on_failure": false }
  ]
}
```

- `shared_session: true` → satu browser context untuk seluruh flow (cookie/login terbawa) dan `vars` runtime diteruskan ke test case berikutnya. Video menjadi satu file per flow.
- `shared_session: false` → setiap test case terisolasi (context baru, `vars` runtime di-reset); video per test case.
- `stop_on_failure: true` → item berikutnya di-skip jika satu item gagal (kecuali item tersebut diset `continue_on_failure`).
- Flow boleh mencampur test case automated & manual (lihat [06](06-runner.md#run-manual--flow-campuran)), **kecuali** flow `shared_session: true` — validasi menolak test case manual di flow seperti itu, karena sesi browser runner tidak bisa dipakai tester.

## Validasi

- JSON Schema memvalidasi struktur per `action` (field wajib, tipe, enum).
- Validasi semantik tambahan: `id` step unik, variable `secret.*` yang dirujuk ada di environment (warning, bukan error, karena environment dipilih saat run), `wait` > 30s ditolak.
- `http_request`: `poll_timeout_ms` 0–120000, `poll_interval_ms` ≥ 200, `regex_decode` enum, setiap pola `save_regex` tidak kosong dan ≤ 1000 karakter. Editor (TS) juga meng-compile pola dengan `new RegExp`; backend Go **tidak** (RE2 berbeda dengan regex JavaScript: lookbehind/backreference valid di JS ditolak RE2), jadi regex tidak valid dilaporkan editor dan runner. Path & pesan identik di TS dan Go.
- `{{fn.*}}` di param step (bukan `description`/`expected`): fungsi tidak dikenal → warning; argumen `fn.totp` salah → error.
- Endpoint `POST /api/v1/projects/{key}/test-cases/validate` dan tool MCP `validate_test_case` mengembalikan error per step (path + pesan) → AI bisa memperbaiki sendiri.

## Kandidat lanjutan (bukan v1)

- `include` step: memanggil test case lain sebagai sub-routine (mis. "Login" dipakai ulang).
- `upload_file`, iframe/multi-tab, `if`/loop sederhana, data-driven (satu test case × dataset CSV).
- Import/export (YAML, CSV) dan import dari tool lain.
