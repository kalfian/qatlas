# 11 — Open Questions

Keputusan yang perlu konfirmasi. Kolom "Asumsi saat ini" adalah default yang dipakai di dokumen lain sampai dijawab.

| # | Pertanyaan | Asumsi saat ini | Dampak jika berbeda |
|---|-----------|-----------------|---------------------|
| Q1 | Jenis test yang perlu didukung: web UI, API, mobile? | **Web UI + API** (bisa campur dalam satu test case). Engine Playwright tidak mencakup mobile native | Mobile native butuh Appium/emulator → arsitektur worker berbeda |
| Q4 | Kirim email (invite/reset) sejak awal? | Tidak; admin salin link. SMTP di Phase 5 | Butuh konfigurasi SMTP di Phase 2 |
| Q5 | Batasi login Google ke domain tertentu? | Opsional via config, default tidak dibatasi (tetap wajib terdaftar) | – |
| Q6 | Perlu role **runner** (boleh run, tidak boleh edit)? | Tidak; viewer / editor / maintainer | Tambah satu baris di matriks RBAC |
| Q7 | Retention artifact default? | **30 hari**, bisa diatur per project | Kebutuhan storage |
| Q9 | Butuh import dari tool lain (spreadsheet, TestRail, kode Playwright yang sudah ada)? | Tidak di v1 | Tambah milestone import |
| Q10 | Perlu browser recorder (record & playback) untuk membuat test? | Tidak di v1 (AI via MCP + `inspect_page` jadi alternatif) | Komponen recorder (extension / codegen) |
| Q11 | Nama produk "QAtlas" final? | Ya (mengikuti nama folder) | Branding saja |
| Q12 | Package manager FE: pnpm? | **pnpm** | – |
| Q13 | Spesifikasi LXC (OS template, CPU/RAM, storage untuk artifact) dan reverse proxy/domain yang dipakai? | Debian 12/Ubuntu 24.04, ≥2 vCPU / 4 GB RAM untuk server+worker kecil, reverse proxy yang sudah ada | Concurrency default & ukuran storage |

## Sudah diputuskan

| Tanggal | Keputusan | Sumber |
|---------|-----------|--------|
| 2026-11-04 | Engine test = **Playwright resmi (Node)** untuk UI & API. Test case tetap step terstruktur (DSL) yang diedit di UI; worker Go mengorkestrasi runner Node. `playwright-go` & executor HTTP Go dibatalkan. | Kalfian |
| 2026-11-04 | **Test manual** didukung, tetapi hanya untuk test case yang memang butuh manual (`execution: manual`); masuk scope Phase 1–3, bukan Phase 5. (Q2) | Kalfian |
| 2026-11-04 | **Satu organisasi** per instance; tidak multi-tenant. (Q3) | Kalfian |
| 2026-11-04 | Deploy ke **Proxmox LXC**, mendukung **docker-compose** dan **deploy manual**. (Q8) | Kalfian |
