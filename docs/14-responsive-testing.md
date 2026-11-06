# 14 — Responsive testing (device & viewport)

Status: diputuskan 2026-11-06 (Kalfian memilih cakupan "Lengkap": device emulation + run multi-device + step responsive). Visual diff/baseline **bukan** bagian fitur ini (lihat [04 → Kandidat lanjutan](04-test-definition.md#kandidat-lanjutan-bukan-v1)).

## Ringkasan

1. **Preset device dengan emulasi asli.** Tidak hanya lebar×tinggi: `isMobile`, `hasTouch`, `deviceScaleFactor` dan user agent device (dari descriptor Playwright yang terpasang di runner).
2. **Run multi-device (matrix).** Satu run memilih 1–6 device; setiap test case (atau setiap item flow) dijalankan **per device**. Laporan: grid *case × device* + detail per device (step, screenshot, video).
3. **Step responsive.** `set_viewport`, `expect_no_horizontal_scroll`, dan field umum step `only_on` (`mobile`/`tablet`/`desktop`).

## Katalog device

Sumber tunggal: [`api/devices.json`](../api/devices.json). `scripts/sync-devices.mjs` menyalinnya ke `backend/internal/devices/devices.json` (di-embed Go) dan `web/src/lib/devices.json`; test di kedua sisi gagal bila salinan berbeda dari `api/devices.json`.

| id | Label | Kategori | Viewport | DPR | mobile/touch | Descriptor Playwright |
|----|-------|----------|----------|-----|--------------|----------------------|
| `desktop` | Desktop | desktop | 1280×720 | 1 | – | – |
| `laptop` | Laptop | desktop | 1440×900 | 1 | – | – |
| `desktop-fhd` | Desktop Full HD | desktop | 1920×1080 | 1 | – | – |
| `ipad-pro-11` | iPad Pro 11 | tablet | 834×1194 | 2 | ✓/✓ | `iPad Pro 11` |
| `ipad-mini` | iPad Mini | tablet | 768×1024 | 2 | ✓/✓ | `iPad Mini` |
| `galaxy-tab-s4` | Galaxy Tab S4 | tablet | 712×1138 | 2.25 | ✓/✓ | `Galaxy Tab S4` |
| `iphone-15` | iPhone 15 | mobile | 393×659 | 3 | ✓/✓ | `iPhone 15` |
| `iphone-se` | iPhone SE | mobile | 320×568 | 2 | ✓/✓ | `iPhone SE` |
| `pixel-7` | Pixel 7 | mobile | 412×839 | 2.625 | ✓/✓ | `Pixel 7` |
| `galaxy-s9plus` | Galaxy S9+ | mobile | 320×658 | 4.5 | ✓/✓ | `Galaxy S9+` |

Ukuran/DPR diambil dari descriptor Playwright 1.64.1. **User agent tidak disimpan di katalog**: runner mengambilnya dari `devices[playwright]` saat run (selalu cocok dengan versi Playwright yang terpasang); bila descriptor tidak ada → tanpa override UA (tidak error).

**Custom**: `{ "id": "custom", "width", "height", "category?", "label?" }` → DPR 1, bukan mobile, tanpa touch. `category` default dari lebar: `< 768` → `mobile`, `768–1023` → `tablet`, `≥ 1024` → `desktop`. `label` default `"{w}×{h}"` (maks 40 karakter). Batas: lebar 320–3840, tinggi 320–2160 (sama dengan validasi viewport yang sudah ada).

## Kontrak API

### `RunOptions` (response run & `default_run_options` project)

- **Baru, wajib di response:** `devices: Device[]` (1–6), urutan = urutan kolom laporan.
  `Device = { id, label, category: mobile|tablet|desktop, width, height, device_scale_factor, is_mobile, has_touch }`.
- `viewport` tetap ada (kompatibilitas) dan **selalu = ukuran `devices[0]`**.
- Run/project lama tanpa `devices` tersimpan → dibaca sebagai satu device dari `viewport`: preset non-mobile yang ukurannya sama persis (`desktop`/`laptop`/`desktop-fhd`) bila ada, selain itu `custom`. Tidak perlu backfill data.

### Input (`RunCreate.options`, `PATCH /projects/{key}` `default_run_options`, MCP)

- `devices?: DeviceInput[]` (1–6), `DeviceInput = { id: <preset id> } | { id: "custom", width, height, category?, label? }`.
- Prioritas: `devices` → (bila hanya `viewport` dikirim) satu device dari `viewport` seperti aturan di atas → default project.
- Error 422 `validation_failed` (run; `PATCH /projects/{key}` tetap memakai 400 seperti validasi opsi lain, path `default_run_options.devices[i]…`): `options.devices` (kosong / > 6), `options.devices[i].id` (id tak dikenal), `options.devices[i].width|height|category|label`, `options.devices[i]` duplikat (preset id sama, atau custom dengan ukuran+kategori sama).
- Browser `firefox` + device `is_mobile`: diterima; runner tidak mengirim `isMobile` (tidak didukung Firefox), viewport/DPR/touch/UA tetap dipakai. UI menampilkan catatan.

### `RunCase`

- **Baru:** `device_index: integer` (0-based ke `run.options.devices`). Run lama → 0.
- `position` tetap unik per run dan berurutan **device demi device**: device 0 = posisi 1..N, device 1 = N+1..2N, dst. (N = jumlah case/item flow yang di-enable).

### `RunStep`

- **Baru:** `only_on: (mobile|tablet|desktop)[] | null` — snapshot dari step DSL. Step yang tidak berlaku untuk kategori device case-nya dibuat dengan `enabled = false` **dan status `skipped`** saat run dibuat (juga di case manual, jadi tester tidak perlu menandainya dan *complete* tidak terblokir step pending). UI membedakan "dinonaktifkan" vs "tidak berlaku di {kategori}" lewat `only_on`.

### `Step` (DSL)

- Field umum baru `only_on?: ("mobile"|"tablet"|"desktop")[]` — tidak boleh kosong, tanpa duplikat. Tanpa field = semua device.
- Action baru:

| Action | Kind | Parameter | Perilaku |
|--------|------|-----------|----------|
| `set_viewport` | ui | `width` (320–3840), `height` (320–2160) | `page.setViewportSize`. Hanya ukuran; `isMobile`/UA/touch tidak bisa berubah di tengah context. Kategori untuk `only_on` tetap kategori device run. Ringkasan: `Set viewport 768×1024`. |
| `expect_no_horizontal_scroll` | ui | `selector?` (container; default dokumen), `tolerance_px?` (0–50, default 0) | Gagal bila `scrollWidth > clientWidth + tolerance_px`. `details = { expected: "content width ≤ {clientWidth}px", actual: "content width {scrollWidth}px", offenders: [≤ 5 elemen terlebar yang melewati tepi kanan: "tag#id.class (right edge {n}px)"] }`. Ringkasan: `Expect no horizontal scroll` (+ ` in {selector}`). |

## Eksekusi (worker & runner)

- `run_cases.device_index smallint NOT NULL DEFAULT 0` (migrasi `0003_run_devices.sql`). `runs.options` menyimpan `devices` yang sudah di-resolve.
- **Planner**: segmen tidak pernah melewati batas device; `stop_on_failure` hanya berlaku **di dalam device yang sama** (gagal di iPhone → sisa case iPhone di-skip, device berikutnya tetap jalan). Aturan yang sama di state machine `runs.Continue` (dipakai complete-manual) dan simulator mock.
- **Shared session** (flow): satu session per device (session baru saat pindah device).
- **Case manual** ikut diulang per device; tester melihat label device + ukurannya di layar eksekusi manual (dan memakai device/devtools yang sesuai).
- **Pesan runner**: `run.start.options.viewport = {width,height}` device segmen + `options.device = { id, label, category, width, height, device_scale_factor, is_mobile, has_touch, playwright: string|null }`. Runner membuat context dengan `viewport`, `deviceScaleFactor`, `hasTouch`, `isMobile` (kecuali Firefox), `userAgent` dari descriptor bila ada; ukuran video = viewport.
- Batas run: jumlah run_cases = N × jumlah device (maks 6×). Batas waktu run (`run_timeout_ms`) dihitung ulang per segmen device.
- *Re-run failed* tetap memilih per test case: case yang gagal di satu device dijalankan ulang di semua device run tersebut.
- `viewport` saja di `RunCreate` tetap memakai validasi lama (1–10000) demi kompatibilitas; device custom lewat `devices` memakai 320–3840 × 320–2160.

## Laporan

- **Web**: run > 1 device → tab/tampilan *Matrix* (baris case, kolom device, sel status yang bisa diklik ke detail case di device itu) + daftar case dikelompokkan per device; header detail case menampilkan chip device (`iPhone 15 · 393×659`). Run 1 device → chip device di panel detail (menggantikan baris "Viewport").
- **JUnit**: run > 1 device → nama testcase `"{title} [{device label}]"`, `classname` tetap.
- **MCP**: `run_test_case`/`run_flow` menerima `options.devices` berupa array string: id preset atau `"custom:{w}x{h}"`; respons start, `wait_for_run` dan `get_run_report` menyertakan device per case dan ringkasan per device (> 1 device); step di report menampilkan `only_on`. Deskripsi tool memuat daftar id preset.

## UI

- Dialog Run & *Settings → Run defaults*: pemilih multi-device dikelompokkan Desktop / Tablet / Mobile (checkbox, maks 6) + baris custom (lebar×tinggi). Ringkasan: "3 devices · 2 mobile". Pilihan terakhir per project tetap diingat (localStorage) seperti opsi lain.
- Editor step: action baru di katalog (`set_viewport`, `expect_no_horizontal_scroll`) + opsi "Hanya di" (multi-pilih mobile/tablet/desktop) di opsi lanjutan step; badge di daftar step.

## Demo

`demo-target` (Tokoku) mendapat layout responsif (menu hamburger di < 768 px) dan satu halaman dengan bug overflow yang disengaja di layar sempit; seed menambah test case responsive + flow `Responsive smoke` (desktop, iPad Mini, iPhone 15) dan satu contoh run matrix.
