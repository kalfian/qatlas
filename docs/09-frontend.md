# 09 — Frontend

## Stack

| Kebutuhan | Pilihan | Alasan |
|-----------|---------|--------|
| Build | Vite + React + TypeScript | Cepat, SPA cukup (tidak butuh SEO/SSR) |
| Routing | TanStack Router | Type-safe route & search params (filter list tersimpan di URL) |
| Server state | TanStack Query | Cache, refetch, optimistic update |
| UI | Tailwind CSS + shadcn/ui (Radix) | Komponen accessible, mudah dikustom |
| Form | react-hook-form + zod | Validasi step per action |
| Drag & drop | dnd-kit | Urutkan step & item flow |
| API client | `openapi-typescript` + `openapi-fetch` | Types dari `api/openapi.yaml` |
| Mock | MSW (Mock Service Worker) | Phase 1 tanpa backend; handler mengikuti kontrak OpenAPI |
| Editor teks/JSON | CodeMirror 6 | Mode "JSON view" test case untuk power user |
| Test FE | Vitest + Testing Library; Playwright untuk e2e FE | |

Build FE menghasilkan static file yang bisa di-serve oleh `qatlas server` (satu container) atau CDN terpisah.

## Peta halaman

| Route | Halaman |
|-------|---------|
| `/login` | Email+password, tombol "Login with Google", pesan error `not_registered` |
| `/invite/:token` | Set password / lanjut dengan Google |
| `/projects` | Daftar project (yang user punya akses), buat project (admin) |
| `/p/:key` | Dashboard project: pass rate 7/30 hari, run terakhir, test paling sering gagal |
| `/p/:key/tests` | Tree folder + tabel test case (filter tag/status/prioritas/last run, search, bulk action) |
| `/p/:key/tests/new`, `/p/:key/tests/:caseKey` | Detail & editor: info, **step editor**, variable, riwayat revisi, riwayat run, tombol Run |
| `/p/:key/flows` | Daftar flow |
| `/p/:key/flows/:flowKey` | Flow builder: pilih test case (search), drag urutan, opsi shared session/stop on failure, Run |
| `/p/:key/runs` | Riwayat run (filter status/target/trigger/tanggal) |
| `/p/:key/runs/:runKey` | **Live progress + report**: timeline step, screenshot lightbox, video player, re-run. Jika ada case manual & user = assignee → **mode eksekusi manual** |
| `/my-tasks` | Run manual yang ditugaskan ke saya (lintas project) |
| `/p/:key/environments` | Environment: variable & secret (write-only) |
| `/p/:key/settings` | Info project, member & role, default opsi run, retention |
| `/admin/users` | Kelola user: buat, salin invite link, ubah role, disable |
| `/settings/profile` | Nama, password, status link Google |
| `/settings/tokens` | API token + snippet setup MCP |

## Komponen kunci

- **Step editor**: list step (drag untuk urutkan), tiap baris: ikon action, ringkasan human-readable ("Klik `role=button[name='Masuk']`"), status run terakhir. Klik → panel form dinamis sesuai action (dari JSON Schema). Aksi: tambah (palette action dengan search), duplikat, disable, hapus, keyboard shortcut. Toggle **Form / JSON**.
- **Run dialog**: environment, browser, headless, viewport, screenshot (`off`/`on_failure`/`every_step`), video (`off`/`on_failure`/`always`), retries. Ingat pilihan terakhir per project.
- **Run view**: header status (badge, durasi berjalan), progress bar, daftar case → step yang ter-update live; step gagal otomatis di-expand dan di-scroll ke tampilan; tab Screenshots (galeri) & Video.
- **Mode eksekusi manual**: satu step terfokus (instruksi + expected besar dan jelas), tombol Pass / Fail / Blocked / Skip dengan shortcut keyboard, kolom actual result, upload/paste lampiran (paste screenshot dari clipboard), progres tersimpan otomatis, tombol Selesai.
- **Penanda execution**: ikon/label "Manual" di list test case, flow builder, dan report.
- **Status badge** konsisten: queued, running (animasi), awaiting manual, passed, failed, blocked, error, cancelled, skipped.
- **Command palette** (Ctrl/⌘+K): lompat ke project/test case/run.

## Live progress

- Hook `useRunProgress(runKey)` membungkus sumber update.
- Phase 1: polling `GET /runs/{key}` tiap ~1 detik saat status aktif (MSW mensimulasikan progres berbasis waktu).
- Phase 3: diganti SSE `/runs/{key}/events` + refetch snapshot saat reconnect; komponen pemakai tidak berubah.

## Mock layer (Phase 1)

- `web/src/mocks/db.ts` — in-memory store (tabel sama dengan [03](03-domain-model.md)), di-persist ke `localStorage` agar tahan reload.
- `web/src/mocks/seed.ts` — data contoh: 3 user (admin, editor, viewer), 2 project, ±20 test case dalam folder, 3 flow, 2 environment, puluhan run historis campuran passed/failed.
- `web/src/mocks/runSimulator.ts` — saat run dibuat: status `queued` → `running` → step diselesaikan bertahap (300–800 ms/step); hasil deterministik dari aturan sederhana (mis. step dengan selector mengandung `fail` atau test bertag `flaky` → gagal acak) untuk mendemokan report gagal. Screenshot & video memakai file contoh statis di `web/public/mock-artifacts/`.
- Run manual di mock: langsung `awaiting_manual`; flow campuran disimulasikan berhenti di item manual lalu lanjut setelah case manual diselesaikan. Seed berisi beberapa test case manual.
- Auth mock: login sesuai seed user; tombol Google membuka dialog "pilih akun Google (simulasi)" yang menguji kasus terdaftar vs tidak terdaftar.
- **Dev toolbar** (hanya mode mock): ganti user aktif (cek tampilan per role), reset data demo, atur kecepatan simulasi.
- Mode dipilih via env `VITE_API_MODE=mock|real`.

## Kualitas UI

- Semua list punya state **loading / empty / error**; aksi destruktif pakai konfirmasi.
- Responsive: target utama desktop (≥1280), tetap usable di tablet; report run tetap terbaca di mobile.
- Aksesibilitas: navigasi keyboard penuh di step editor, kontras warna status, label ARIA.
- Dark mode.
- Sebelum implementasi UI Phase 1, minta arahan desain ke agent UI/UX dan review hasil akhirnya (sesuai workflow).
