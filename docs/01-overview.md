# 01 — Overview

## Masalah

- Test case sering tersebar (spreadsheet, dokumen, kode) dan sulit dilacak per project.
- Menjalankan automation test butuh setup lokal; hasilnya (screenshot/video) tidak terkumpul di satu tempat.
- AI coding assistant belum punya jalur standar untuk membuat dan menjalankan test lalu membaca hasilnya.

## Tujuan

1. Satu tempat untuk **mengelola test case per project** (folder, tag, prioritas, status, riwayat revisi).
2. **Flow**: susun beberapa test case menjadi satu skenario berurutan (mis. Login → Tambah ke keranjang → Checkout).
3. **Run async**: jalankan test case / flow di server, banyak run paralel, resource terkendali.
4. **Report** per run: pass/fail per step, pesan error, **screenshot** dan/atau **video** (bisa dipilih per run).
   - Test case yang memang butuh manusia (mis. OTP via SMS, cek visual/fisik, captcha) bisa ditandai **manual**: dikerjakan tester langkah demi langkah, hasilnya masuk report yang sama. Manual hanya dipakai bila perlu; default tetap automation.
5. **Multi user** dengan akses per project. User dibuat/diundang admin; login dengan email+password atau **Google (hanya email terdaftar)**.
6. **MCP server** agar AI bisa: membaca project & test case → membuat/mengubah test case → menjalankan → menunggu → membaca report (termasuk screenshot step yang gagal).

## Non-goals (untuk v1)

- Mobile app testing native (Appium) — mungkin nanti.
- Load/performance testing.
- Visual regression (diff screenshot) — kandidat phase lanjutan.
- Multi-tenant SaaS (banyak organisasi terisolasi). **Diputuskan: satu instance = satu organisasi.**
- Record & playback browser recorder — kandidat phase lanjutan.

## Persona

| Persona | Kebutuhan utama |
|---------|-----------------|
| **Admin** | Kelola user (buat/undang, nonaktifkan), buat project, atur akses |
| **QA Engineer** | Tulis & rapikan test case, susun flow, jalankan, analisis kegagalan |
| **Developer** | Jalankan test terkait fitur, lihat report, trigger dari CI |
| **Viewer / PM** | Lihat status kualitas & report tanpa mengubah apa pun |
| **AI Agent (via MCP)** | Bertindak atas nama user (pakai API token user), dengan hak akses user tersebut |

## Glossary

| Istilah | Arti |
|---------|------|
| **Project** | Wadah test case, flow, environment, run, dan member |
| **Test Case** | Satu skenario test berisi urutan **step** (action + parameter + expected) |
| **Manual test case** | Test case `execution: manual`; step berisi instruksi + expected, dikerjakan tester, bukan runner |
| **Step** | Satu aksi: `goto`, `click`, `fill`, `expect_text`, `http_request`, dll. Lihat [04](04-test-definition.md) |
| **Flow** | Kumpulan test case berurutan, opsional berbagi session browser & variable |
| **Environment** | Set variable & secret per project (mis. `staging`, `production`) yang dipakai saat run |
| **Run** | Satu eksekusi test case atau flow, dengan opsi (browser, screenshot, video) |
| **Artifact** | File hasil run: screenshot, video, (nanti) trace, log |
| **Revision** | Snapshot test case setiap disimpan; run selalu menyimpan snapshot yang dijalankan |
