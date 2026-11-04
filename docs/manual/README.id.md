# Manual pengguna QAtlas

QAtlas menyimpan test case per project, menjalankannya dengan Playwright di server, dan
mengumpulkan hasilnya (screenshot, video, expected vs actual) dalam satu report. Skenario yang
tidak bisa dicek script dijalankan sebagai test case **manual** oleh tester, tetap di report
yang sama. AI agent bisa melakukan semua ini lewat MCP server bawaan.

Manual ini memakai satu project demo: **SHOP** (toko online "Tokoku"). Semua screenshot diambil
dari instance sungguhan: backend Go, worker, runner Playwright, dan toko demo.

> English: [README.md](README.md)

Catatan label: UI QAtlas default berbahasa Inggris, jadi manual ini menyebut label tombol sesuai
UI bahasa Inggris (seperti di screenshot). Kalau kamu memakai UI bahasa Indonesia, labelnya ikut
diterjemahkan, mis. **Add step** = **Tambah step**, **Save** = **Simpan**, **My tasks** =
**Tugas saya**.

![Menulis test case, menjalankannya, lalu membuka report](video/create-and-run-test-case.gif)

**Video walkthrough** (MP4, 1280×800, tanpa suara):

| Video | Isi | Durasi |
|---|---|---|
| [**Demo end-to-end**](video/end-to-end.mp4) | Seluruh produk dalam satu rekaman: login → environment → step editor → run → report → flow dengan cek manual → verifikasi email via Mailpit → riwayat & dashboard → Admin → Storage (S3) → API token / MCP → ganti bahasa | 1 mnt 59 dtk |
| [Membuat dan menjalankan test case](video/create-and-run-test-case.mp4) | Step editor dan palette action → simpan → run dengan screenshot dan video → report | 42 dtk |
| [Memperbaiki test yang gagal](video/fix-a-failing-test.mp4) | Run gagal → expected vs actual dan screenshot → perbaiki step → run ulang lolos | 28 dtk |
| [Eksekusi manual](video/manual-execution.mp4) | Flow berhenti di test case manual → tester mengerjakannya → flow lanjut otomatis | 25 dtk |

## Daftar isi

1. [Konsep](#1-konsep)
2. [Mulai](#2-mulai)
3. [Mengelola user (admin)](#3-mengelola-user-admin)
4. [Project dan member](#4-project-dan-member)
5. [Environment dan secret](#5-environment-dan-secret)
6. [Menulis test case](#6-menulis-test-case)
7. [Test case manual](#7-test-case-manual)
8. [Flow](#8-flow)
9. [Menjalankan test](#9-menjalankan-test)
10. [Membaca report](#10-membaca-report)
11. [Eksekusi manual](#11-eksekusi-manual)
12. [Riwayat run dan dashboard](#12-riwayat-run-dan-dashboard)
13. [API token dan MCP untuk AI](#13-api-token-dan-mcp-untuk-ai)
14. [CI](#14-ci)
15. [Troubleshooting dan FAQ](#15-troubleshooting-dan-faq)

---

## 1. Konsep

| Istilah | Arti |
|---|---|
| **Project** | Wadah test case, flow, environment, run, dan member. **Key**-nya yang pendek (`SHOP`) jadi awalan semua key: test case `SHOP-T12`, flow `SHOP-F1`, run `SHOP-R2`. |
| **Test case** | Satu skenario berupa urutan **step**. Setiap simpan membuat **revisi** baru; run menyimpan snapshot revisi yang dijalankan. |
| **Step** | Satu aksi beserta parameternya, mis. `goto` ke URL, `fill` input, `expect_text`, `http_request`. Step berupa data terstruktur, bukan kode, jadi aman diedit manusia maupun AI. |
| **Selector** | Cara step menemukan elemen. Utamakan `role=`, `label=`, `testid=` daripada CSS (lihat [Selector](#selector)). |
| **Variable** | `{{env.NAMA}}` dari environment, `{{secret.NAMA}}` untuk secret, `{{vars.nama}}` untuk variable test case/flow dan nilai yang disimpan saat run, `{{fn.uuid}}` dan helper lain. |
| **Environment** | Kumpulan variable dan secret per target, mis. `staging` dan `production`. Kamu memilihnya saat memulai run. |
| **Secret** | Nilai environment yang write-only: tidak bisa dibaca lagi oleh siapa pun, dan dimask `••••` di report, log, dan output MCP. |
| **Flow** | Urutan test case yang dijalankan sebagai satu run, opsional dalam satu sesi browser bersama. |
| **Run** | Satu eksekusi test case atau flow dengan opsi (browser, viewport, screenshot, video, retry). Run dikerjakan worker secara async. |
| **Test case manual** | Test case dengan `execution: manual`. Step-nya berisi instruksi dan hasil yang diharapkan, lalu ditandai tester Passed / Failed / Blocked / Skipped. |

**Role.** Setiap user punya role sistem, dan role per project:

| Role | Bisa |
|---|---|
| **Admin** (sistem) | Membuat, mengundang, dan menonaktifkan user; melihat dan membuat semua project. |
| **Member** (sistem) | Login dan bekerja di project tempat dia jadi member. |
| **Maintainer** (project) | Semua yang bisa dilakukan editor, ditambah member, environment, default run, retensi, dan arsip project. |
| **Editor** (project) | Membuat dan mengedit test case dan flow, memulai run, mengerjakan run manual. |
| **Viewer** (project) | Melihat test case, flow, run, dan report. Tidak ada tombol edit, run, atau settings. |

API token tidak pernah punya akses lebih dari role pemiliknya di setiap project.

**Status run** selalu berbahasa Inggris, di UI maupun output API/MCP: Queued, Running, Awaiting
manual, Passed, Failed, Blocked, Error (masalah infrastruktur, bukan assertion yang gagal),
Cancelled. Hasil step juga bisa Skipped.

## 2. Mulai

### Login

Buka URL QAtlas kamu dan login dengan email dan password dari admin (atau password yang kamu
buat lewat link undangan). Tidak ada pendaftaran mandiri. Kalau login Google sudah dikonfigurasi,
**Continue with Google** hanya berlaku untuk email yang sudah punya akun.

![Halaman login](img/login.png)

Di instance demo (`scripts/demo-server.sh start`) akunnya `rina@tokoku.id` (admin),
`dimas@tokoku.id` (editor SHOP), dan `sari@tokoku.id` (viewer SHOP), semuanya dengan password
`password123`.

### Navigasi

- **All projects** menampilkan project yang bisa kamu akses, beserta run terakhir dan pass rate
  7 hari.
- Pemilih project di atas sidebar membuka project: **Dashboard**, **Test cases**, **Flows**,
  **Runs**, **Environments**, **Settings**.
- **My tasks** berisi run manual yang menunggu kamu.
- **Search** (`Ctrl K`, `⌘ K` di macOS) melompat ke halaman, project, test case, dan flow; ketik
  key run seperti `SHOP-R12` untuk membuka run itu.
- Tombol matahari/bulan mengganti tema terang dan gelap.

![Daftar project](img/projects.png)

![Step editor di tema gelap](img/dark-step-editor.png)

![Command palette mencari "checkout"](img/command-palette.png)

### Bahasa

**Account → Language** mengganti bahasa UI antara **English** (default) dan **Bahasa
Indonesia**. Pilihan disimpan di profil, jadi ikut ke semua perangkat. Label status (Passed,
Failed, …) tetap berbahasa Inggris supaya sama dengan output MCP dan API.

![Pengaturan bahasa di halaman Account](img/account-language.png)

![Step editor dalam Bahasa Indonesia](img/ui-indonesian-step-editor.png)

## 3. Mengelola user (admin)

**Admin · Users** menampilkan semua user dengan role sistem, status (Invited, Active, Disabled),
dan login terakhir.

![Halaman Users](img/admin-users.png)

**Membuat user:** **Create user** → email dan nama → **Create user**. QAtlas menampilkan link
undangan yang berlaku 72 jam dan hanya bisa dipakai sekali. Kirim lewat chat atau email; orang
itu membukanya, membuat password, lalu langsung login. (QAtlas belum mengirim email sendiri.)

![Dialog link undangan setelah membuat user](img/admin-invite-link.png)

Menu **⋯** di baris user berisi:

- **Regenerate invite link** untuk undangan yang kedaluwarsa atau hilang.
- **Create password reset link** kalau ada yang lupa password (belum ada reset mandiri).
- **Change role** antara Member dan Admin.
- **Disable** / **Enable again**. Menonaktifkan user akan mengeluarkannya dari semua sesi,
  mencabut API token-nya, dan membatalkan link undangan yang masih terbuka.

Kamu tidak bisa mengubah role atau status akunmu sendiri. User baru belum melihat project apa
pun sampai maintainer menambahkannya ke project.

## 4. Project dan member

**All projects → Create project** meminta nama dan key (`SHOP`). Key tidak bisa diubah setelahnya
karena jadi bagian dari semua key test case, flow, dan run.

**Settings** (khusus maintainer) punya lima bagian:

| Bagian | Fungsi |
|---|---|
| General | Nama dan deskripsi |
| Members | Tambah user terdaftar dengan role, ubah role, hapus member |
| Run defaults | Nilai awal dialog Run untuk semua member project |
| Retention | Berapa hari screenshot, video, dan lampiran disimpan (1–365). Run dan hasil step tetap ada; report lama menampilkan "Artifact expired". |
| Danger zone | Arsipkan project (hilang dari daftar dan tidak bisa di-run; riwayat tetap disimpan) |

![Member project dan role-nya](img/project-members.png)

Hanya user yang terdaftar dan aktif yang bisa ditambahkan. Untuk orang baru, admin membuat
user-nya dulu ([bagian 3](#3-mengelola-user-admin)).

## 5. Environment dan secret

**Environments** berisi satu entri per target, mis. `staging` dan `production`. Environment yang
ditandai **Default** (bintang) dipakai kalau run tidak memilih environment.

- **Variables** adalah nilai biasa yang terlihat oleh semua member. Pakai di step sebagai
  `{{env.BASE_URL}}`. Edit tabelnya, lalu **Save variables**.
- **Secrets** bersifat write-only. **+ Secret** menyimpan nilai yang tidak bisa dilihat lagi;
  kamu hanya bisa **Replace value** atau menghapusnya. Pakai sebagai `{{secret.QA_PASSWORD}}`.
  Nilainya dienkripsi di database (AES-256-GCM) dan dimask `••••` di report, log, dan output MCP.

![Environment dengan variable dan secret write-only](img/environments.png)

![Menambah secret](img/environments-secret-dialog.png)

Pakai nama variable yang sama di semua environment, supaya satu test case bisa dijalankan ke
staging maupun production cukup dengan memilih environment lain di dialog Run.

## 6. Menulis test case

### Daftar test case

**Test cases** menampilkan folder di kiri dan tabel yang bisa difilter di kanan: cari judul atau
key, filter status, prioritas, tag, eksekusi (automated/manual), dan run terakhir. Filter
tersimpan di URL, jadi bisa di-bookmark atau dibagikan. Centang baris untuk aksi massal: pindah
folder, ubah status, tambah atau hapus tag, hapus.

![Daftar test case dengan folder dan filter](img/test-cases-list.png)

**+ Test case** membuat test case automated; panah di sebelahnya juga menyediakan test case
manual.

### Step editor

Editor menampilkan daftar step di kiri dan detail step terpilih di kanan. Setiap baris
menampilkan action, ringkasan yang mudah dibaca, dan hasil step itu di run terakhir (✓ lolos,
✗ gagal, ◌ di-skip).

![Step editor dengan panel samping terbuka di step ber-selector](img/step-editor-panel.png)

1. **Add step** (atau tekan `N`) membuka **palette action**. Ketik untuk mencari berdasarkan nama
   atau fungsinya, lalu `Enter`. Step disisipkan setelah step yang terpilih.
2. Isi field di panel samping. Field wajib ditandai error sampai diisi; label tab menampilkan
   jumlah error.
3. Opsional di setiap step: **Description** (ditampilkan di report menggantikan ringkasan),
   **Expected** (hasil yang diharapkan, dalam kalimat), dan di **Advanced**: timeout,
   **Continue even if this step fails**, dan **Always take a screenshot after this step**.
   Nonaktifkan step tanpa menghapusnya dengan `E` atau menu **⋯** di barisnya.
4. **Save** (`Ctrl S`). Simpan pertama memberi key ke test case; setiap simpan menambah revisi.

![Palette action yang difilter ke action HTTP](img/action-palette.png)

Action dikelompokkan di palette:

| Kelompok | Action |
|---|---|
| Navigation | `goto` |
| Interaction | `click`, `dblclick`, `hover`, `fill`, `type`, `press`, `select_option`, `check`, `uncheck` |
| Wait | `wait_for` (lebih disarankan), `wait` (jeda tetap, maks 30 dtk) |
| Data & variables | `extract_text`, `set_variable`, `screenshot` |
| UI assertions | `expect_visible`, `expect_hidden`, `expect_text`, `expect_value`, `expect_url`, `expect_title`, `expect_count` |
| HTTP | `http_request` (method, URL, header, query, body; `save` nilai JSONPath ke `vars`) |
| HTTP assertions | `expect_status`, `expect_json`, `expect_header`, `expect_response_time` |

Satu test case boleh mencampur step UI dan HTTP, mis. buat pesanan lewat API lalu cek di UI.
Browser hanya dijalankan kalau test case punya step UI. Assertion HTTP mengecek response dari
`http_request` terakhir.

### Selector

| Tulis | Menemukan | Padanan Playwright |
|---|---|---|
| `role=button[name='Pay now']` | Tombol berdasarkan nama aksesibelnya | `getByRole('button', { name: 'Pay now' })` |
| `label=Email` | Input berdasarkan label | `getByLabel('Email')` |
| `placeholder=Search products` | Input berdasarkan placeholder | `getByPlaceholder('Search products')` |
| `testid=grand-total` | `data-testid="grand-total"` | `getByTestId('grand-total')` |
| `text=Order placed` | Elemen berdasarkan teksnya | `getByText('Order placed')` |
| `#id`, `.class`, `xpath=…` | Selain itu | `locator(…)` |

Utamakan `role=`, `label=`, dan `testid=`: tidak gampang rusak saat layout atau styling berubah.
Semua action otomatis menunggu elemennya (auto-wait Playwright), jadi `wait` jarang diperlukan.

### Variable

Ketik `{{` di field mana pun untuk melihat saran.

| Namespace | Sumber | Contoh |
|---|---|---|
| `env.*` | Environment yang dipilih untuk run | `{{env.BASE_URL}}/login` |
| `secret.*` | Secret environment (dimask di report) | `{{secret.QA_PASSWORD}}` |
| `vars.*` | Tab **Variables** test case atau flow, plus `save` / `extract_text` / `set_variable` selama run | `{{vars.order_id}}` |
| `fn.*` | Helper bawaan | `{{fn.uuid}}`, `{{fn.now}}`, `{{fn.random_email}}`, `{{fn.random_int 1 100}}`, `{{fn.totp secret.NAMA}}` |

Kalau nama yang sama didefinisikan dua kali, sumber yang belakangan menang: environment →
variable flow → variable test case → nilai yang diset selama run.

### 2FA dan email

- **Kode TOTP.** `{{fn.totp secret.NAMA}}` menghasilkan kode aplikasi authenticator saat ini
  (RFC 6238) dari seed base32 (spasi, huruf kecil, dan padding `=` boleh). Seed juga bisa diambil
  dari `env.NAMA` atau `vars.nama`, atau ditulis langsung. Opsi: `digits=6..8` (default 6),
  `period=10..300` (default 30), `algorithm=SHA1|SHA256|SHA512`, mis.
  `{{fn.totp secret.OTP digits=8}}`. Kode dibuat saat step dijalankan; kalau sisa umur kode kurang
  dari 3 detik, runner menunggu kode berikutnya. Report menampilkan ekspresinya, tidak pernah
  seed-nya, dan kode yang dihasilkan dimask `••••`.
- **Menunggu email.** Di step **HTTP request**, buka **Polling** dan isi *Polling maksimal (ms)*
  (maks 120000). Request dikirim ulang setiap *Interval polling* (default 1000 ms, min 200) sampai
  status 2xx, *Polling sampai* (JSONPath) punya nilai yang tidak kosong, dan semua entri *Simpan*
  serta *Simpan dengan regex* ditemukan. Kalau waktu habis, step gagal dengan response terakhir,
  jumlah percobaan, dan apa yang belum ditemukan. Ringkasan step diakhiri `(polling ≤15 dtk)`.
- **Mengambil kode atau link dari email.** *Simpan dengan regex* (`nama → pola`) menjalankan regex
  JavaScript pada body response dan menyimpan capture group 1 (atau seluruh match). Untuk email
  mentah atau HTML, set *Decode body sebelum regex* ke `auto`: quoted-printable (`=3D`, soft line
  break) dan entitas HTML (`&amp;`) di-decode, dan response JSON dicari pada nilai string-nya.
- **API penangkap email.** Mailpit: `GET {{env.MAILPIT_URL}}/api/v1/search` dengan query parameter
  `query` = `to:{{vars.email}}` → `$.messages[0].ID`, lalu
  `GET {{env.MAILPIT_URL}}/api/v1/message/{{vars.mail_id}}` → `$.Subject`, `$.Text`, `$.HTML`
  (`/view/<ID>.html` dan `/view/<ID>.txt` menampilkan body apa adanya). MailHog:
  `GET …/api/v2/search?kind=to&query=<email>` → `$.items[0].Content.Body` dengan
  `regex_decode: auto`. Detail di [docs/04](../04-test-definition.md).

### Contoh: 2FA dan verifikasi email (test case demo)

Project demo SHOP punya tiga test case yang menunjukkan cara menguji faktor kedua serta link atau
kode yang dikirim lewat email tanpa campur tangan orang:

- **SHOP-T20 Log in with TOTP 2FA** — login sebagai `qa.2fa@tokoku.id` lalu mengisi
  `label=Authentication code` dengan `{{fn.totp secret.QA_TOTP_SEED}}`: kode 6 digit aplikasi
  authenticator saat ini, dihitung dari seed base32 yang disimpan sebagai secret.
- **SHOP-T21 Sign up and verify email (Mailpit)** — mendaftar dengan `{{fn.random_email}}`, lalu
  `http_request` ke `{{env.MAILPIT_URL}}/api/v1/search` dengan `poll_timeout_ms` dan
  `poll_until: $.messages[0].ID` diulang sampai email masuk (`save` menyimpan ID-nya). Request
  kedua membaca email mentah (`/api/v1/message/{{vars.mail_id}}/raw`, HTML quoted-printable) dan
  `save_regex` dengan `regex_decode: auto` mengambil link verifikasi, yang lalu dibuka oleh `goto`.
- **SHOP-T22 Verify email with the 6-digit code** — sama, tetapi `save_regex` `code is (\d{6})`
  mengambil kode dari JSON pesan Mailpit dan test case mengetiknya ke form.

[Mailpit](https://mailpit.axllent.org) adalah penangkap email lokal: `scripts/demo-server.sh`
menjalankannya di samping toko demo (UI di `http://127.0.0.1:8025`), dan environment `staging`
punya `MAILPIT_URL` serta secret `QA_TOTP_SEED`. Untuk aplikasimu sendiri, arahkan `MAILPIT_URL`
ke instance Mailpit/MailHog-mu dan simpan seed 2FA akun test sebagai secret.

### Mode JSON

**Form / JSON** di bagian atas menampilkan definisi mentah. Mode JSON memvalidasi terhadap schema
step sambil kamu mengetik, praktis untuk menyalin step antar test case atau menempel definisi
buatan AI.

![Mode JSON dengan validasi schema](img/step-editor-json.png)

### Shortcut keyboard

**Shortcuts** (atau `?`) menampilkan daftarnya. Shortcut berlaku saat fokus ada di daftar step,
bukan di dalam field teks.

| Tombol | Aksi |
|---|---|
| `↑` `↓` | Pilih step |
| `Enter` / `Esc` | Buka detail step / kembali ke daftar |
| `Alt ↑` `Alt ↓` | Pindahkan step |
| `Space` | Mulai drag, `↑ ↓` untuk memindah, `Space` untuk melepas |
| `N` | Tambah step (palette) |
| `D` | Duplikat |
| `E` | Aktifkan / nonaktifkan |
| `Del` | Hapus (bisa di-undo) |
| `Ctrl S` | Simpan |

![Popover shortcut keyboard](img/editor-shortcuts.png)

Tab **Revisions** menampilkan semua versi tersimpan beserta penulis dan catatan perubahannya,
menunjukkan perbedaan dengan versi sekarang, dan bisa mengembalikan revisi lama ke editor
(**Restore to draft**, lalu simpan). **Run history** menampilkan run test case ini.

## 7. Test case manual

Pakai test case manual hanya untuk hal yang tidak bisa dicek script: kode OTP via SMS, dokumen
yang dicetak atau diunduh, penilaian visual, perangkat fisik. Pilih **Manual test case** dari
panah di sebelah **+ Test case**.

Setiap step punya **Instruction** (apa yang dikerjakan tester) dan **Expected** opsional.
Variable juga berlaku di sini: `{{env.BASE_URL}}` diganti nilainya untuk tester, secret hanya
ditampilkan namanya.

![Editor test case manual](img/manual-test-case-editor.png)

Menjalankan test case manual membuat run berstatus **Awaiting manual** untuk assignee yang
dipilih (default: kamu). Lihat [Eksekusi manual](#11-eksekusi-manual).

## 8. Flow

Flow menjalankan beberapa test case berurutan sebagai satu run, mis. *login → tambah ke keranjang
→ checkout*.

![Daftar flow](img/flows-list.png)

Di flow builder, cari test case di panel kanan lalu klik (atau tekan `Enter`) untuk menambahkannya
di akhir; geser handle-nya (atau `Alt ↑ ↓`) untuk mengubah urutan.

![Flow builder dengan test case manual di tengah](img/flow-builder.png)

| Opsi | Efek |
|---|---|
| **Shared session** aktif | Satu browser untuk seluruh flow: cookie, login, dan `vars` terbawa ke test case berikutnya, dan flow merekam satu video. Test case manual tidak diizinkan. |
| **Shared session** mati | Setiap test case mulai dengan browser baru; `vars` runtime di-reset; satu video per test case. Test case manual boleh. |
| **Stop on failure** | Item berikutnya di-skip setelah ada yang gagal, kecuali item yang diset **Continue on failure**. |
| **Enabled** (per item) | Lewati item sementara tanpa menghapusnya. |
| **Variables** | `{{vars.*}}` tingkat flow; variable test case dengan nama sama menimpanya. |

Flow yang berisi test case manual berhenti di setiap test case manual sampai assignee
menyelesaikannya, lalu worker melanjutkan secara otomatis.

## 9. Menjalankan test

**Run** di test case atau flow membuka dialog Run. Nilai awalnya diambil dari default run project
dan pilihan terakhirmu.

![Dialog Run](img/run-dialog.png)

| Opsi | Nilai |
|---|---|
| Environment | Variable dan secret yang dipakai (default: environment berbintang) |
| Browser | Chromium, Firefox, WebKit (hanya browser yang terpasang di worker yang bisa jalan; instalasi default hanya Chromium) |
| Viewport | Desktop 1280×720, laptop, mobile, atau ukuran custom |
| Screenshot | Off, On failure, Every step |
| Video | Off, On failure (tetap merekam, lalu videonya dibuang kalau case lolos), Always |
| Retries per test case | 0, 1, 2 |
| Advanced | Headless on/off, timeout per step (default 10.000 ms) |

Untuk test case manual atau flow yang punya bagian manual, dialog juga meminta **assignee**.

Setelah **Run** kamu dibawa ke halaman run. Halaman ini update live: queued → running → hasil
setiap step begitu selesai, dengan waktu berjalan.

![Run yang sedang berjalan](img/run-live.png)

**Cancel** menghentikan step yang sedang jalan dan menandai sisanya Skipped; hasil yang sudah ada
tetap disimpan. **Re-run** mengulang run dengan opsi yang sama; menunya juga punya **Re-run
failed** (hanya test case yang gagal di flow) dan **Change options & run…**.

## 10. Membaca report

Tab **Steps** menampilkan setiap test case di run beserta step-nya. Step yang gagal otomatis
terbuka dan menampilkan:

- **Expected** dan **Actual** berdampingan,
- pesan error dari Playwright,
- description dan expected step,
- thumbnail screenshot halaman saat itu.

![Run gagal: expected vs actual dengan screenshot](img/run-failed-report.png)

Di sini test mengharapkan voucher menurunkan total jadi Rp 81.000, tapi halaman tetap menampilkan
Rp 90.000. Toko demo memang sengaja punya bug ini.

**Screenshots** mengumpulkan semua screenshot run, berlabel case, step, dan action. Klik salah satu
untuk membuka lightbox: `←` `→` untuk pindah, **Download**, **Open in new tab**, `Esc` untuk
menutup.

![Tab Screenshots](img/run-screenshots-tab.png)

![Lightbox screenshot](img/screenshot-lightbox.png)

**Video** memutar rekamannya: satu video untuk flow shared session, satu per test case untuk yang
lain.

![Tab Video](img/run-video-tab.png)

Untuk step `http_request`, buka step-nya untuk melihat method, URL, status, waktu, dan body request
serta response (secret dimask).

![Detail request HTTP](img/run-http-details.png)

**Details** menampilkan target, environment, trigger (Manual, via MCP, via API), waktu, dan opsi
run persisnya. Menu **⋯** berisi **Copy link**, **Export JSON**, dan **Download JUnit XML**.

Report yang sama di tema gelap:

![Report run gagal di tema gelap](img/dark-run-failed-report.png)

Di ponsel, report tersusun vertikal:

<img src="img/mobile-run-report.png" alt="Report run di ponsel selebar 390 px" width="320">

**Alur perbaikan yang umum** (lihat [video](video/fix-a-failing-test.mp4)): baca expected vs
actual dan screenshot → tentukan yang salah aplikasinya atau test-nya → kalau test-nya yang salah,
klik key test case, pilih step yang gagal, perbaiki, `Ctrl S` → **Run** lagi.

## 11. Eksekusi manual

Run manual yang ditugaskan ke kamu muncul di **My tasks** (sidebar menampilkan jumlahnya), yang
paling lama menunggu di atas.

![My tasks](img/my-tasks.png)

Buka tugasnya. Test case manual terbuka dengan daftar step di kiri dan instruksi aktif di kanan:

1. Kerjakan sesuai **Instruction** dan bandingkan dengan **Expected**.
2. Tandai step: **Pass** (`P`), **Fail** (`F`), **Blocked** (`B`), atau **Skip** (`S`).
3. **Actual result**: apa yang sebenarnya terjadi. Wajib kalau step gagal.
4. **Attachments**: tarik file, pilih file, atau tempel screenshot (`Ctrl V`). Maks 25 MB per file.
5. `Ctrl Enter` menyimpan dan pindah ke step berikutnya. Progres tersimpan otomatis, jadi kamu
   bisa berhenti dan lanjut nanti.
6. **Finish** menampilkan ringkasan dan menyelesaikan test case.

![Mengerjakan step manual: gagal dengan actual result](img/manual-execution.png)

**Change assignee** menyerahkan pekerjaan ke orang lain. Di flow, worker langsung melanjutkan ke
test case automated berikutnya begitu kamu selesai; dengan stop on failure, case manual yang gagal
membuat sisanya di-skip.

![Run flow yang selesai dengan hasil manual](img/manual-execution-done.png)

AI agent bisa memulai run manual tapi tidak bisa mengisi hasil manual: itu tetap tugas manusia.

## 12. Riwayat run dan dashboard

**Runs** menampilkan semua run project, terbaru di atas. Filter berdasarkan key target, status,
jenis (test case atau flow), trigger, dan rentang tanggal; filter tersimpan di URL.

![Riwayat run dengan filter status terbuka](img/runs-history.png)

**Dashboard** project menampilkan pass rate 7 dan 30 hari, total run, run yang menunggu
pengerjaan manual, tren run 30 hari, test case yang paling sering gagal, dan run terakhir.

![Dashboard project dalam Bahasa Indonesia](img/ui-indonesian-dashboard.png)

![Dashboard project di tema gelap](img/dark-dashboard.png)

<img src="img/mobile-dashboard.png" alt="Dashboard project di ponsel selebar 390 px" width="320">

## 13. API token dan MCP untuk AI

QAtlas punya MCP server di `<URL QAtlas kamu>/mcp`, jadi AI agent seperti Claude Code bisa melihat
project, menulis dan memvalidasi test case, menjalankannya, menunggu, lalu membaca report,
termasuk screenshot step yang gagal.

**Buat token:** **API tokens & MCP → Create token**. Pilih scope yang kamu perlukan:

| Scope | Mengizinkan |
|---|---|
| `read` | Melihat project, test case, flow, run, report; validasi |
| `write` | Membuat dan mengedit test case, folder, flow |
| `run` | Memulai dan membatalkan run |

Token bisa dibatasi ke project tertentu dan diberi masa berlaku (30 hari, 90 hari, tanpa batas).

![Dialog Create token](img/api-token-create.png)

Token hanya ditampilkan **sekali**, bersama perintah Claude Code yang siap pakai. Salin ke password
manager atau langsung ke Claude Code.

![Token dibuat, dengan perintah setup MCP (token di screenshot ini disamarkan)](img/api-token-created.png)

```bash
claude mcp add --transport http qatlas https://qatlas.example.com/mcp \
  --header "Authorization: Bearer qat_xxxxxxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

Lalu minta Claude, misalnya: *"Buat test case login untuk project SHOP, jalankan di staging, lalu
ringkas hasilnya."* Claude memakai tool `list_projects`, `get_step_schema`, `validate_test_case`,
`create_test_case`, `run_test_case`, `wait_for_run`, `get_run_report`, dan lainnya (total 19;
referensi: [docs/07-mcp.md](../07-mcp.md)).

- Run yang dimulai AI bertrigger **via MCP**.
- Satu token maksimal punya 3 run MCP yang queued atau running bersamaan.
- Tidak ada tool hapus, dan AI tidak bisa mengisi hasil manual.
- Untuk client yang hanya mendukung stdio: `claude mcp add qatlas -e QATLAS_TOKEN=qat_… -- qatlas mcp-stdio --url https://qatlas.example.com`.

Cabut token yang tidak dipakai lagi dengan **Revoke**. Token yang dicabut tetap ada di daftar,
dengan tanda.

![Daftar API token](img/api-tokens.png)

## 14. CI

Token API yang sama (scope `read` + `run`) bisa dipakai job CI untuk memulai run, menunggunya,
menggagalkan build kalau run gagal, dan menyimpan report JUnit XML. Setup, client
`scripts/qatlas-ci.sh`, dan contoh GitHub Actions: [docs/ci/README.md](../ci/README.md).

## 15. Troubleshooting dan FAQ

**Aku lupa password.** Minta admin memakai **Create password reset link** di barismu pada
**Admin · Users**.

**"Continue with Google" bilang akunku tidak terdaftar.** Login Google hanya untuk email yang sudah
dibuat admin. Minta admin membuat user dengan email yang persis sama.

**Tombol Run / Edit / Settings tidak muncul.** Kamu viewer di project ini. Minta maintainer
menjadikanmu editor.

**Step gagal karena timeout.** Elemennya tidak pernah muncul atau tidak cocok. Buka screenshot
step itu: apakah halamannya sesuai dugaan? Cek selector-nya (utamakan `role=`, `label=`,
`testid=`), dan pakai `wait_for` alih-alih `wait` untuk halaman yang lambat. Timeout default per
step 10 dtk; naikkan per step di **Advanced** atau per run di dialog Run.

**Status run Error, bukan Failed.** Error berarti infrastrukturnya bermasalah (browser crash,
worker restart, run melewati batas waktu), bukan assertion. Pesannya ada di header run. Jalankan
ulang; kalau terulang, cek log worker.

**Run terus Queued.** Tidak ada worker yang mengambil job. Pastikan `qatlas worker` (atau
`qatlas all`) berjalan dan log-nya menulis `runner ready`.

**Screenshot atau video bertuliskan "Artifact expired".** Sudah dihapus oleh retensi project. Run
dan hasil step tetap ada.

**Run dengan Firefox atau WebKit gagal start.** Worker hanya punya browser yang dipasang di sana
(instalasi default: Chromium; `deploy/install.sh --browsers "chromium webkit"` menambah yang lain).

**Progres live tidak update di belakang reverse proxy.** Progres memakai Server-Sent Events: proxy
tidak boleh mem-buffer `/api/v1/runs/{key}/events`. Lihat contoh nginx di
[deploy/README.md](../../deploy/README.md#reverse-proxy-and-tls).

**Boleh menaruh password di variable test case?** Jangan: variable test case terlihat oleh semua
member. Simpan sebagai secret environment dan pakai `{{secret.NAMA}}`.

---

### Membuat ulang screenshot dan video

Media di manual ini dibuat oleh script di [`scripts/`](scripts/README.md) terhadap instance demo
yang sedang berjalan, jadi bisa diperbarui setelah UI berubah.
