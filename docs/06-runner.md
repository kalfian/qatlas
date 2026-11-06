# 06 — Runner & Reporting

## Opsi run

Dipilih di dialog "Run" (FE), parameter MCP, atau body REST. Default bisa disimpan per project.

| Opsi | Nilai | Default |
|------|-------|---------|
| `environment` | environment project | env default |
| `browser` | `chromium`, `firefox`, `webkit` | `chromium` |
| `headless` | bool | `true` |
| `devices` | 1–6 device: preset (`desktop`, `ipad-mini`, `iphone-15`, …) atau `custom` lebar×tinggi; setiap case dijalankan per device (emulasi `isMobile`/touch/DPR/user agent) — [14](14-responsive-testing.md) | `desktop` |
| `viewport` | `{width, height}` — lama; = ukuran device pertama. Dikirim sendiri → jadi satu device | 1280×720 |
| `screenshot` | `off`, `on_failure`, `every_step` | `on_failure` |
| `video` | `off`, `on_failure`, `always` | `off` |
| `step_timeout_ms` | int | 10000 |
| `run_timeout_ms` | int | 900000 |
| `retries` | 0–2 (per test case) | 0 |

Catatan video `on_failure`: Playwright tidak bisa merekam "mundur", jadi video **tetap direkam** lalu **dihapus jika test passed**. Ada biaya CPU saat run, tapi storage hemat.

## Alur eksekusi

Engine eksekusi = **Playwright resmi di proses runner Node**; worker Go mengorkestrasi (protokol di [02](02-architecture.md#protokol-worker--runner)).

**Worker (Go)**
1. Ambil job → load run + snapshot → set `running`, NOTIFY.
2. Resolve variable: environment (decrypt secret di memori saja) → flow → test case. Siapkan direktori artifact sementara.
3. Kirim `run.start` ke runner yang punya slot kosong.
4. Untuk setiap event dari runner: mask secret → tulis `run_cases`/`run_steps` → upload screenshot/video dari direktori sementara ke `ArtifactStore` → NOTIFY.
5. `run.finished` → hitung summary → set status final → NOTIFY `run_finished`.
6. Selalu (defer): hapus direktori sementara, pastikan status final tertulis walau runner crash / timeout global (status `error`).

**Runner (Node + Playwright)**
1. Untuk setiap test case (urut):
   - Jika ada step UI dan belum ada context → `browser.newContext({ recordVideo? , viewport })`.
   - Untuk setiap step: interpolasi `{{vars.*}}` → eksekusi action dengan timeout → screenshot sesuai opsi (`page.screenshot`) → kirim `step.finished`.
   - Step gagal → step berikutnya `skipped` (kecuali `continue_on_failure`).
   - Akhir test case: tutup context (jika tidak shared) → path video tersedia setelah context ditutup → kirim `case.finished`.
2. Kirim `run.finished`. Error tak terduga → `runner.error`, tutup context.

## Run manual & flow campuran

**Run test case manual** tidak menyentuh worker/runner sama sekali:

1. `POST /runs` untuk test case manual → run dibuat langsung `awaiting_manual`, `assignee` = pemicu (bisa diganti maintainer).
2. Tester membuka halaman run → mode **eksekusi manual**: step satu per satu, tandai status, isi actual result, lampirkan file (`artifacts.kind = attachment`).
3. Progres disimpan per step (bisa ditinggal & dilanjutkan). Tombol **Selesai** → status final dihitung (`failed` > `blocked` > `passed`).
4. Event live tetap dikirim (orang lain yang melihat run ikut ter-update).

**Flow campuran** (automated + manual, hanya untuk `shared_session: false`):

1. Worker menjalankan item automated berurutan seperti biasa.
2. Ketemu item manual → worker menyimpan `resume_position`, set run `awaiting_manual`, **melepas slot & resource** (tidak ada browser yang ditahan menunggu manusia), job selesai.
3. Tester menyelesaikan case manual → jika masih ada item berikutnya, server meng-enqueue job lanjutan (River) → run kembali `running`.
4. `stop_on_failure` berlaku juga untuk hasil manual.
5. Run yang menunggu manual tidak punya timeout otomatis; bisa di-cancel. (Phase 5: pengingat/notifikasi ke assignee.)

## Masking secret

Semua nilai `secret.*` yang sudah ter-resolve dimasukkan ke "masker" per run; setiap string yang ditulis ke `error_message`, `details`, log, dan output MCP disaring → `••••`. (Screenshot/video tidak bisa dimask — dokumentasikan ke user.)

## Live progress

- Worker: setelah menulis ke DB, `pg_notify('run_events', '{"run_id":"…","type":"step_finished","run_step_id":"…"}')` (payload kecil; detail diambil dari DB).
- Server: satu koneksi `LISTEN run_events` → fan-out in-memory ke subscriber SSE per `run_id`.
- Endpoint: `GET /api/v1/runs/{id}/events` (SSE). Event: `run_started`, `case_started`, `step_started`, `step_finished`, `case_finished`, `run_finished`. Mendukung `Last-Event-ID` / FE re-fetch snapshot saat reconnect.
- Mode `qatlas all`: bus in-process (tanpa round-trip NOTIFY) memakai interface yang sama.

## Artifact

- Interface `ArtifactStore { Put, Get (dengan Range), Delete, PresignGet? }`.
- `LocalStore` (default, direktori `QATLAS_DATA_DIR/artifacts/{project}/{run}/...`) dan `S3Store` (MinIO/S3/R2).
- Diakses lewat `GET /api/v1/artifacts/{id}` (cek RBAC; mendukung HTTP Range agar video bisa di-seek), atau redirect ke presigned URL berumur pendek untuk S3.
- Format: screenshot PNG (opsional konversi WebP untuk hemat), video WebM (output Playwright).
- **Retention**: `expires_at` per artifact (default 30 hari, bisa diatur per project); job River harian menghapus artifact kedaluwarsa. Run & hasil step tetap ada, hanya file yang hilang (UI menampilkan "artifact expired").

## Report

Halaman run menampilkan:

- Header: key run, target (test case / flow), status, durasi, environment, browser, pemicu (user / MCP / API / schedule), waktu.
- Summary: jumlah case & step passed / failed / skipped.
- Per test case: daftar step dengan status, durasi, description/expected, error message (nilai aktual vs expected), thumbnail screenshot (klik → lightbox), detail request/response untuk step HTTP.
- Video player per test case (atau per flow jika shared session).
- Aksi: **Re-run** (opsi sama), **Re-run failed only** (untuk flow), cancel (saat berjalan), salin link, export JSON.
- Phase 5: export **JUnit XML** untuk CI, Playwright trace viewer.

## Resource & skala

- `WORKER_CONCURRENCY` membatasi job paralel per worker; setiap job ≈ satu browser context (puluhan–ratusan MB tergantung aplikasi target; perlu diukur saat spike Phase 3).
- Satu proses runner per worker; di dalamnya satu browser process per tipe browser, di-reuse antar run; runner di-restart berkala (mis. setiap N run) untuk menghindari memory leak.
- Test API-only tidak memakai browser sama sekali (`APIRequestContext` saja).
- Scale horizontal: tambah container worker.

## Spike Phase 3 (wajib sebelum implementasi penuh)

1. Runner Node + Playwright resmi via NDJSON: launch 3 browser, context per run, screenshot, `recordVideo`, path video setelah context close, ukuran image Docker.
2. Ukur RAM/CPU untuk 1, 2, 4 run paralel di target sederhana — bandingkan **runner long-lived (browser shared)** vs **satu proses per run**.
3. Uji cancel di tengah step, runner crash/hang (kill + restart), dan pembersihan proses browser zombie.
4. Cek apakah `expect` dari `@playwright/test` bisa dipakai di mode library; jika tidak, assertion ditulis sendiri dengan polling.
5. Keputusan: model proses runner (long-lived vs per-run) + konfigurasi concurrency default.
