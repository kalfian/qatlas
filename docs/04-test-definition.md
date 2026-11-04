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
| `http_request` | `method`, `url`, `headers?`, `query?`, `body?` (json/text/form), `save?` (`{ "token": "$.data.token" }` → JSONPath ke `vars`) |
| `expect_status` | `value` (int) atau `in` (array) |
| `expect_json` | `path` (JSONPath), `op` (`eq`,`neq`,`contains`,`exists`,`gt`,`lt`,`matches`), `value?` |
| `expect_header` | `name`, `value`, `match` |
| `expect_response_time` | `max_ms` |

Assertion HTTP berlaku terhadap **response `http_request` terakhir**. Dieksekusi dengan Playwright `APIRequestContext`; jika test/flow punya browser context, dipakai `context.request` sehingga cookie sesi UI ikut terkirim.

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
| `fn.*` | Built-in | `{{fn.uuid}}`, `{{fn.now}}`, `{{fn.random_email}}`, `{{fn.random_int 1 100}}` |

Urutan prioritas (yang belakang menimpa): environment → flow variables → test case variables → runtime (`save`/`set_variable`).

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
- Endpoint `POST /api/v1/projects/{key}/test-cases/validate` dan tool MCP `validate_test_case` mengembalikan error per step (path + pesan) → AI bisa memperbaiki sendiri.

## Kandidat lanjutan (bukan v1)

- `include` step: memanggil test case lain sebagai sub-routine (mis. "Login" dipakai ulang).
- `upload_file`, iframe/multi-tab, `if`/loop sederhana, data-driven (satu test case × dataset CSV).
- Import/export (YAML, CSV) dan import dari tool lain.
