# 07 — MCP Server

Tujuan: AI (Claude Code, Claude Desktop, IDE agent, dll.) bisa menjalankan siklus penuh **pahami konteks → buat/ubah test case → jalankan → tunggu → baca hasil → perbaiki** tanpa membuka UI.

## Transport & auth

- **Streamable HTTP** di `https://<host>/mcp`, satu proses dengan API server (SDK: `github.com/modelcontextprotocol/go-sdk`).
- Auth: `Authorization: Bearer qat_...` (API token user, lihat [05](05-auth-and-access.md)). Semua tool berjalan dengan hak user pemilik token ∩ scope token.
- Contoh setup (ditampilkan di halaman `/settings/tokens`):
  ```bash
  claude mcp add --transport http qatlas https://qatlas.example.com/mcp \
    --header "Authorization: Bearer qat_xxx"
  ```
- `qatlas mcp-stdio --url ... --token ...` sebagai proxy untuk client yang hanya mendukung stdio (lihat [Connecting Claude Code](#connecting-claude-code)).
- Mode **stateless** (tanpa `Mcp-Session-Id`): setiap POST berdiri sendiri, jadi restart server / beberapa instance tidak memutus client. GET `/mcp` → 405 (server tidak pernah mengirim pesan duluan).
- Token tanpa header / tidak valid / dicabut → `401` (`WWW-Authenticate: Bearer`). Cookie sesi browser **tidak** diterima di `/mcp` (karena itu tidak perlu CSRF).
- Scope token: `read` untuk list/get/validate/wait/report, `write` untuk create/update, `run` untuk `run_*`/`cancel_run`; batas project pada token dan role user tetap berlaku (via `authz.ProjectAccess`).

## Connecting Claude Code

Buat API token di `/settings/tokens` (scope `read` + `write` + `run` untuk siklus penuh; `read` saja untuk analisis), lalu:

```bash
# Streamable HTTP (disarankan)
claude mcp add --transport http qatlas https://qatlas.example.com/mcp \
  --header "Authorization: Bearer qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Bagikan ke seluruh tim lewat .mcp.json repo (token dari env masing-masing developer):
claude mcp add --scope project --transport http qatlas https://qatlas.example.com/mcp \
  --header 'Authorization: Bearer ${QATLAS_TOKEN}'
```

Alternatif stdio (client yang hanya mendukung stdio, atau jaringan yang memblok long-poll HTTP). Binary `qatlas` harus ada di `PATH` mesin client; token lewat env agar tidak terlihat di daftar proses:

```bash
claude mcp add qatlas -e QATLAS_TOKEN=qat_xxx -- qatlas mcp-stdio --url https://qatlas.example.com
```

`mcp-stdio` menerima `--url` (atau `QATLAS_URL`; `/mcp` ditambahkan otomatis) dan `--token` (atau `QATLAS_TOKEN`), menyambung ke `/mcp` server, lalu meneruskan semua tool, resource dan prompt apa adanya — otorisasi tetap di server. Cek dengan `claude mcp list` / `/mcp` di Claude Code; coba "list QAtlas projects".

## Tools

### Konteks

| Tool | Input | Output |
|------|-------|--------|
| `list_projects` | – | key, nama, role user |
| `get_project` | `project` | ringkasan: jumlah test case, environment (nama + variable non-secret + **nama** secret), run terakhir |
| `get_step_schema` | – | JSON Schema step DSL + contoh + panduan selector (juga tersedia sebagai resource) |
| `list_folders` | `project` | tree folder |

### Test case

| Tool | Input | Output |
|------|-------|--------|
| `list_test_cases` | `project`, `query?`, `tags?`, `folder?`, `status?`, `limit/cursor` | key, title, status, tags, last_run_status |
| `get_test_case` | `key` (mis. `SHOP-T12`) | definisi lengkap + revision |
| `validate_test_case` | definisi | `valid` + daftar error per step (path + pesan) |
| `create_test_case` | `project`, definisi | key baru + revision |
| `update_test_case` | `key`, `base_revision`, definisi/patch | revision baru (tolak jika `base_revision` usang → hindari menimpa editan manusia) |

### Flow

| Tool | Input | Output |
|------|-------|--------|
| `list_flows`, `get_flow` | | |
| `create_flow`, `update_flow` | nama, `items` (key test case), opsi | key flow |

### Run & report

| Tool | Input | Output |
|------|-------|--------|
| `run_test_case` | `key`, `environment?`, `options?` | `run_key`, status `queued` |
| `run_flow` | `key`, `environment?`, `options?` | `run_key` |
| `wait_for_run` | `run_key`, `timeout_s` (maks ~120) | status terkini; jika selesai → summary. AI memanggil ulang bila belum selesai |
| `get_run_report` | `run_key`, `include_screenshots` (`none`/`failed`/`all`) | summary + step per case (status, error, nilai aktual vs expected). Screenshot step gagal dikirim sebagai **image content** agar AI bisa melihat |
| `list_runs` | `project`, filter target/status, limit | |
| `cancel_run` | `run_key` | |

### Bantuan menulis selector (stretch, Phase 4b)

| Tool | Input | Output |
|------|-------|--------|
| `inspect_page` | `url` / `environment` + path, `steps_before?` (mis. login dulu) | screenshot + ringkasan accessibility tree / elemen interaktif (role, name, label, testid) agar AI bisa menyusun selector yang stabil |

Ini dijalankan sebagai job worker singkat lewat runner Playwright (kandidat: `locator.ariaSnapshot()` — verifikasi di versi Playwright yang dipin), dibatasi rate & timeout.

## Resources & prompts

- Resource `qatlas://docs/step-dsl` — isi dokumen DSL + JSON Schema.
- Resource `qatlas://projects/{key}/test-cases/{case}` — definisi test case.
- Prompt `write_test_case` — template: requirement → test case siap validasi.
- Prompt `triage_failed_run` — template: baca report run gagal → tentukan apakah bug aplikasi atau test rapuh → usulan perbaikan.

## Contoh sesi AI

1. `list_projects` → pilih `SHOP`.
2. `get_step_schema` + `list_test_cases(tags=["auth"])` untuk melihat gaya yang ada.
3. (opsional) `inspect_page` halaman login.
4. `validate_test_case` → perbaiki → `create_test_case` → dapat `SHOP-T31`.
5. `run_test_case(SHOP-T31, environment="staging", options={screenshot:"on_failure"})` → `SHOP-R210`.
6. `wait_for_run(SHOP-R210)` (berulang sampai selesai).
7. `get_run_report(SHOP-R210, include_screenshots="failed")` → lihat step 4 gagal + screenshot.
8. `update_test_case(SHOP-T31, base_revision=1, ...)` → run ulang → passed.

## Guardrail

- Tidak ada tool delete di v1 (hapus hanya via UI) — mengurangi risiko AI merusak data.
- AI boleh **membuat** test case manual dan memicu run-nya, tapi **tidak bisa mengisi hasil manual** (itu tugas manusia). `wait_for_run` mengembalikan `awaiting_manual` + assignee agar AI berhenti menunggu dan memberi tahu user.
- Semua aksi tercatat di audit log dengan `actor_token_id` dan trigger `mcp`; run dari MCP diberi label "via MCP" di UI. Implementasi: entry service biasa (mis. `test_case.create`, `run.create` dengan `meta.trigger=mcp`) + satu entry `mcp.tool_call` (`meta.tool`, `meta.trigger=mcp`) per tool yang mengubah data.
- Secret tidak pernah dikembalikan; hanya nama.
- Rate limit per token: maks **3** run yang dibuat via MCP berstatus `queued`/`running` sekaligus per token (`awaiting_manual` dan run selesai tidak dihitung) → tool error `rate_limited` berisi daftar run aktif.
- Output dibatasi ukurannya (pagination, potong log panjang) agar hemat context AI: list default 25 / maks 100 dengan `next_cursor`; `wait_for_run` `timeout_s` maks 120; `get_run_report` menampilkan step gagal lengkap (error ≤ 1500 karakter, details ≤ 2000) dan step lulus ringkas (maks 80 per case), screenshot maks 5 gambar ≤ 1 MB (sisanya berupa link).
- Error tool berbentuk `{"error":{"code","message","details":[{path,message}]},"hint"}` dengan `isError: true` — sama dengan envelope REST plus saran langkah berikutnya untuk AI.
