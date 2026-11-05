# QAtlas — UI Direction (Phase 1)

> Arahan desain yang mengikat untuk milestone 1.1–1.8. Stack: React 19 + Vite + TS, Tailwind v4 (CSS-first), komponen shadcn-style di atas Radix, lucide-react, sonner. Copy UI bahasa Indonesia (sapaan **"kamu"**, konsisten); istilah teknis tetap Inggris: test case, flow, run, step, environment, secret, selector, token. Label status juga Inggris (Passed, Failed, …) supaya sama dengan output MCP/API.

## 1. Identitas visual

**Rasa**: alat kerja harian yang padat dan tenang, setara Linear / Vercel dashboard. Data diutamakan, chrome seminimal mungkin. **Warna dipakai untuk makna, bukan dekorasi.** Sembilan status run sudah memakai hampir semua hue, jadi tombol primary sengaja berwarna **tinta netral** (hampir hitam di light, hampir putih di dark). Satu-satunya hue "brand" adalah **biru 259** untuk focus ring, link, dan penanda nav aktif.

**Prinsip**
- Kepadatan dulu: body 13px, kontrol 32px, baris tabel 36px. Whitespace dipakai untuk mengelompokkan, bukan untuk "terasa premium".
- Layout rata kiri dengan hierarki jelas: judul halaman kiri, aksi utama kanan di baris yang sama. Hanya login yang berada di tengah.
- Garis di atas bayangan: permukaan dipisah dengan `border`; shadow hanya untuk overlay (popover, menu, dialog).
- Monospace untuk semua yang bisa disalin atau dicocokkan: key (`SHOP-T12`), selector, `{{variable}}`, JSON, token, durasi.
- Status selalu = ikon + label + warna, tidak pernah warna saja.

**Dilarang (pola AI slop)**: gradien ungu/biru/indigo di mana pun · glassmorphism, `backdrop-blur` dekoratif, blob blur · emoji sebagai ikon atau di heading · kartu `rounded-2xl` besar dengan shadow lembut dan banyak padding · strip "4 kartu statistik melayang" dengan ikon dalam lingkaran berwarna · semua konten di tengah · hero/ilustrasi di app (termasuk empty state: tidak ada ilustrasi stok, cukup ikon lucide 20px) · teks gradien · animasi masuk (fade/slide) di setiap list · default shadcn mentah (radius 0.625rem, font Geist, ring abu) · lorem ipsum / "Acme" / "John Doe" di seed (pakai data realistis: `SHOP`, "Rina Kusuma", "Checkout dengan voucher") · badge warna-warni untuk tag/prioritas (tag = netral, prioritas = teks + ikon).

## 2. Design tokens (`web/src/styles/globals.css`)

Kontras sudah diverifikasi dengan konversi oklch→sRGB dan rumus WCAG 2.x: semua pasangan teks lolos **AA ≥ 4.5:1**, dan elemen non-teks (ring, border input) **≥ 3:1**, di **kedua tema**. Setiap `--status-*` sudah dicek di atas `-bg` miliknya sendiri, `background`, `card`, dan `muted` (light min 4.81, dark min 5.36); `muted-foreground` di semua permukaan min 5.19 (light) / 6.04 (dark); `--input` 3.11 / 3.21; `--ring` 4.99 / 6.28. Semua warna status ada di dalam gamut sRGB. `--border` sengaja di bawah 3:1 (hanya pembagi, bukan batas kontrol).

```css
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

:root {
  --radius: 0.375rem;
  --background: oklch(1 0 0);                 --foreground: oklch(0.21 0.01 264);
  --card: oklch(1 0 0);                       --card-foreground: oklch(0.21 0.01 264);
  --popover: oklch(1 0 0);                    --popover-foreground: oklch(0.21 0.01 264);
  --primary: oklch(0.25 0.012 264);           --primary-foreground: oklch(0.985 0.002 264);
  --secondary: oklch(0.955 0.004 264);        --secondary-foreground: oklch(0.21 0.01 264);
  --muted: oklch(0.968 0.003 264);            --muted-foreground: oklch(0.50 0.012 264);
  --accent: oklch(0.955 0.004 264);           --accent-foreground: oklch(0.21 0.01 264);
  --destructive: oklch(0.53 0.20 27);         --destructive-foreground: oklch(0.99 0 0);
  --border: oklch(0.915 0.005 264);           --input: oklch(0.66 0.008 264);
  --ring: oklch(0.55 0.19 259);               --link: oklch(0.50 0.19 259);
  --chart-1: oklch(0.55 0.19 259); --chart-2: oklch(0.60 0.10 185); --chart-3: oklch(0.72 0.15 75);
  --chart-4: oklch(0.58 0.18 15);  --chart-5: oklch(0.55 0.02 264);
  --sidebar: oklch(0.982 0.002 264);          --sidebar-foreground: oklch(0.21 0.01 264);
  --sidebar-primary: oklch(0.25 0.012 264);   --sidebar-primary-foreground: oklch(0.985 0.002 264);
  --sidebar-accent: oklch(0.95 0.004 264);    --sidebar-accent-foreground: oklch(0.21 0.01 264);
  --sidebar-border: oklch(0.915 0.005 264);   --sidebar-ring: oklch(0.55 0.19 259);
  /* run status: teks/ikon + latar subtle */
  --status-passed: oklch(0.50 0.13 150);      --status-passed-bg: oklch(0.962 0.035 155);
  --status-failed: oklch(0.52 0.19 27);       --status-failed-bg: oklch(0.958 0.02 22);
  --status-error: oklch(0.53 0.14 50);        --status-error-bg: oklch(0.962 0.022 60);
  --status-blocked: oklch(0.52 0.105 80);     --status-blocked-bg: oklch(0.968 0.044 92);
  --status-running: oklch(0.50 0.095 225);    --status-running-bg: oklch(0.958 0.024 225);
  --status-queued: oklch(0.50 0.015 264);     --status-queued-bg: oklch(0.955 0.005 264);
  --status-awaiting-manual: oklch(0.51 0.19 300); --status-awaiting-manual-bg: oklch(0.958 0.022 300);
  --status-cancelled: oklch(0.45 0.01 264);   --status-cancelled-bg: oklch(0.94 0.004 264);
  --status-skipped: oklch(0.53 0.01 264);     --status-skipped-bg: oklch(0.97 0.003 264);
}

.dark {
  --background: oklch(0.165 0.006 264);       --foreground: oklch(0.96 0.003 264);
  --card: oklch(0.195 0.007 264);             --card-foreground: oklch(0.96 0.003 264);
  --popover: oklch(0.215 0.008 264);          --popover-foreground: oklch(0.96 0.003 264);
  --primary: oklch(0.94 0.004 264);           --primary-foreground: oklch(0.20 0.008 264);
  --secondary: oklch(0.26 0.009 264);         --secondary-foreground: oklch(0.96 0.003 264);
  --muted: oklch(0.235 0.008 264);            --muted-foreground: oklch(0.71 0.012 264);
  --accent: oklch(0.26 0.009 264);            --accent-foreground: oklch(0.96 0.003 264);
  --destructive: oklch(0.66 0.19 22);         --destructive-foreground: oklch(0.20 0.008 264);
  --border: oklch(0.29 0.009 264);            --input: oklch(0.50 0.01 264);
  --ring: oklch(0.68 0.16 259);               --link: oklch(0.74 0.13 259);
  --chart-1: oklch(0.70 0.15 259); --chart-2: oklch(0.72 0.11 185); --chart-3: oklch(0.80 0.14 80);
  --chart-4: oklch(0.70 0.16 15);  --chart-5: oklch(0.68 0.02 264);
  --sidebar: oklch(0.145 0.006 264);          --sidebar-foreground: oklch(0.96 0.003 264);
  --sidebar-primary: oklch(0.94 0.004 264);   --sidebar-primary-foreground: oklch(0.20 0.008 264);
  --sidebar-accent: oklch(0.235 0.008 264);   --sidebar-accent-foreground: oklch(0.96 0.003 264);
  --sidebar-border: oklch(0.29 0.009 264);    --sidebar-ring: oklch(0.68 0.16 259);
  --status-passed: oklch(0.78 0.15 152);      --status-passed-bg: oklch(0.27 0.05 155);
  --status-failed: oklch(0.74 0.15 22);       --status-failed-bg: oklch(0.28 0.07 22);
  --status-error: oklch(0.77 0.14 55);        --status-error-bg: oklch(0.28 0.055 50);
  --status-blocked: oklch(0.83 0.14 85);      --status-blocked-bg: oklch(0.28 0.05 85);
  --status-running: oklch(0.78 0.12 225);     --status-running-bg: oklch(0.27 0.05 230);
  --status-queued: oklch(0.74 0.012 264);     --status-queued-bg: oklch(0.25 0.008 264);
  --status-awaiting-manual: oklch(0.76 0.14 300); --status-awaiting-manual-bg: oklch(0.28 0.07 300);
  --status-cancelled: oklch(0.68 0.01 264);   --status-cancelled-bg: oklch(0.24 0.006 264);
  --status-skipped: oklch(0.66 0.01 264);     --status-skipped-bg: oklch(0.22 0.005 264);
}

@theme inline {
  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, monospace;
  --text-xs: 0.75rem;    --text-xs--line-height: 1rem;        /* 12 meta, badge, caption */
  --text-sm: 0.8125rem;  --text-sm--line-height: 1.25rem;     /* 13 DEFAULT UI */
  --text-base: 0.875rem; --text-base--line-height: 1.25rem;   /* 14 penekanan body */
  --text-lg: 1rem;       --text-lg--line-height: 1.5rem;      /* 16 judul section */
  --text-xl: 1.25rem;    --text-xl--line-height: 1.75rem;     /* 20 judul halaman */
  --text-2xl: 1.5rem;    --text-2xl--line-height: 2rem;       /* 24 instruksi manual, angka KPI */
  --radius-sm: calc(var(--radius) - 2px); --radius-md: var(--radius); --radius-lg: calc(var(--radius) + 2px);
  --shadow-overlay: 0 8px 24px -6px oklch(0 0 0 / 0.16), 0 2px 6px -2px oklch(0 0 0 / 0.08);
  --color-background: var(--background); --color-foreground: var(--foreground);
  --color-card: var(--card); --color-card-foreground: var(--card-foreground);
  --color-popover: var(--popover); --color-popover-foreground: var(--popover-foreground);
  --color-primary: var(--primary); --color-primary-foreground: var(--primary-foreground);
  --color-secondary: var(--secondary); --color-secondary-foreground: var(--secondary-foreground);
  --color-muted: var(--muted); --color-muted-foreground: var(--muted-foreground);
  --color-accent: var(--accent); --color-accent-foreground: var(--accent-foreground);
  --color-destructive: var(--destructive); --color-destructive-foreground: var(--destructive-foreground);
  --color-border: var(--border); --color-input: var(--input); --color-ring: var(--ring); --color-link: var(--link);
  --color-chart-1: var(--chart-1); --color-chart-2: var(--chart-2); --color-chart-3: var(--chart-3);
  --color-chart-4: var(--chart-4); --color-chart-5: var(--chart-5);
  --color-sidebar: var(--sidebar); --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-primary: var(--sidebar-primary); --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
  --color-sidebar-accent: var(--sidebar-accent); --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border); --color-sidebar-ring: var(--sidebar-ring);
  --color-status-passed: var(--status-passed); --color-status-passed-bg: var(--status-passed-bg);
  --color-status-failed: var(--status-failed); --color-status-failed-bg: var(--status-failed-bg);
  --color-status-error: var(--status-error); --color-status-error-bg: var(--status-error-bg);
  --color-status-blocked: var(--status-blocked); --color-status-blocked-bg: var(--status-blocked-bg);
  --color-status-running: var(--status-running); --color-status-running-bg: var(--status-running-bg);
  --color-status-queued: var(--status-queued); --color-status-queued-bg: var(--status-queued-bg);
  --color-status-awaiting-manual: var(--status-awaiting-manual); --color-status-awaiting-manual-bg: var(--status-awaiting-manual-bg);
  --color-status-cancelled: var(--status-cancelled); --color-status-cancelled-bg: var(--status-cancelled-bg);
  --color-status-skipped: var(--status-skipped); --color-status-skipped-bg: var(--status-skipped-bg);
}

@layer base {
  * { @apply border-border outline-ring; }
  html { color-scheme: light; } html.dark { color-scheme: dark; }
  body { @apply bg-background text-foreground font-sans text-sm antialiased; font-feature-settings: "cv11"; }
  .tabular, td, time { font-variant-numeric: tabular-nums; }
}
```

**Status badge** (`<StatusBadge status>`): `inline-flex h-5 items-center gap-1 rounded-sm px-1.5 text-xs font-medium bg-status-X-bg text-status-X`, ikon 12px. Ikon: passed `CircleCheck` · failed `CircleX` · error `OctagonAlert` · blocked `Ban` · running `LoaderCircle` (berputar) · queued `Clock` · awaiting manual `Hand` · cancelled `CircleSlash` · skipped `CircleDashed`. Step `pending` = queued. "error" (infra) dan "failed" (assertion) harus selalu bisa dibedakan dari ikon dan label, bukan hanya dari warna.

## 3. Tipografi, radius, spasi, shadow

- **Font**: `@fontsource-variable/inter` (sans; tabular figures, jelas di 12–13px) + `@fontsource-variable/jetbrains-mono` (mono; 0/O dan 1/l/I dibedakan untuk selector dan token; ligature **off**: `font-variant-ligatures: none`). Import keduanya di `main.tsx`. Geist tidak dipakai karena itu default shadcn.
- **Skala** (sudah ada di `@theme`): 12 / 13 / 14 / 16 / 20 / 24. Berat hanya **400, 500, 600** (500 untuk label/tombol/header tabel, 600 untuk judul). Tidak ada 700. Judul halaman `text-xl font-semibold tracking-tight`. Header kolom tabel `text-xs font-medium text-muted-foreground`, **tidak** uppercase. Label eyebrow uppercase hanya di mode manual ("INSTRUKSI", "EXPECTED"), `text-xs tracking-wide`.
- **Radius**: 6px (`rounded-md`) untuk kontrol dan panel · 8px (`rounded-lg`) untuk dialog/popover · 4px (`rounded-sm`) untuk badge, kbd, thumbnail · `rounded-full` hanya untuk avatar dan dot status. Tidak ada `rounded-xl` atau yang lebih besar.
- **Spasi** (grid 4px, skala Tailwind bawaan): tinggi kontrol `h-8` (default), `h-7` (toolbar/aksi di dalam baris), `h-9` (login, tombol keputusan mode manual), `h-11` (target sentuh mobile). Baris tabel `h-9`, item sidebar `h-8`. Padding halaman `px-6 py-5` (mobile `px-4 py-4`). Jarak: 8 di dalam grup, 16 antar grup, 24 antar section. Lebar panel: sidebar 240 · tree folder 240 · panel step 400.
- **Shadow**: hanya `shadow-overlay` untuk popover/menu/dialog/toast. Kartu dan tabel: `border` saja. Di dark, overlay dibedakan lewat `bg-popover` (lebih terang) + border.
- **Motion**: 120–160ms `ease-out` untuk hover, popover, dan expand. Saat diam, satu-satunya animasi adalah spinner `running` dan transisi lebar progress bar. `prefers-reduced-motion`: spinner jadi ikon statis, tanpa smooth scroll.

## 4. App shell

```
┌──────────────┬────────────────────────────────────────────────────────────┐
│ [SHOP ▾]     │ SHOP / Test cases / SHOP-T12     [Cari…  ⌘K] [◐] [RK▾]  h-12│
│ Toko Online  ├────────────────────────────────────────────────────────────┤
│ Dashboard    │                                                            │
│ Test cases   │  Judul halaman                           [Aksi sekunder][Primary]
│ Flows        │  …konten                                                   │
│ Runs         │                                                            │
│ Environments │                                                            │
│ Pengaturan*  │                                                            │
│ ──────────── │                                                            │
│ Tugas saya 3 │                                                            │
│ Admin*       │                                                            │
│ Akun         │   * hanya tampil untuk role yang berhak                    │
└──────────────┴────────────────────────────────────────────────────────────┘
```
- **Sidebar** `bg-sidebar border-r`, 240px. Project switcher di atas: Popover + Command (cari key/nama, project terakhir dipakai di atas), menampilkan key mono + nama. Nav project memakai ikon lucide 16px + label. Item aktif: `bg-sidebar-accent font-medium` + bar 2px `bg-ring` di kiri, plus `aria-current="page"`. Grup global (dipisah divider): **Tugas saya** (badge jumlah, `aria-label="Tugas saya, 3 menunggu"`), **Admin** (hanya admin), dan **Akun** di bawah (profil + API token; label berbeda dari "Pengaturan" project agar tidak ambigu). Bisa diciutkan jadi rail ikon 48px (tooltip label). Di <1024px sidebar jadi Sheet dari kiri lewat tombol menu di top bar.
- **Top bar** h-12, `border-b`: breadcrumb (key mono, segmen terakhir `aria-current`). Di kanan: tombol palette `Cari… ⌘K` (di Win/Linux tampil `Ctrl K`), toggle tema (menu: Terang / Gelap / Sistem, disimpan di localStorage dan diterapkan sebelum paint lewat script inline di `index.html`), menu user (inisial avatar → nama, email, Profil, API token, Keluar).
- **Command palette**: Dialog + cmdk. Grup: Navigasi, Project, Test case (key/judul), Run (key), Aksi ("Run test case ini", "Buat test case"). Hasil diambil dari Query cache + search mock.
- **Lebar konten**: tabel, run view, editor, flow builder = fluid (penuh). Form/settings `max-w-3xl`. Kolom fokus mode manual `max-w-2xl`. Login 360px. Header halaman: judul kiri, aksi kanan, `flex-wrap` di layar sempit.

## 5. Panduan per layar

**Login** — kolom 360px di tengah layar (satu-satunya layout tengah), wordmark "QAtlas" rata kiri di atas form. Email → Password → `Masuk` (primary, h-9, lebar penuh) → divider "atau" → `Lanjut dengan Google` (outline + logo G resmi, SVG). Tidak ada link daftar. Teks muted di bawah: "Belum punya akun atau lupa password? Hubungi admin." Error ditampilkan sebagai banner `role="alert"` di atas form: "Email atau password salah." · `not_registered`: "Akun Google ini belum terdaftar. Hubungi admin untuk diundang." · lockout menyebut durasinya. Saat submit, tombol disabled + spinner, input tetap terisi. `/invite/:token` memakai shell yang sama: set password (min 8 karakter, ada hint live) atau Google. Link kedaluwarsa = state error penuh.

**Projects** — list baris, bukan grid kartu: key (badge mono) · nama + deskripsi 1 baris · jumlah test case · status run terakhir + waktu relatif · pass rate 7 hari (angka + sparkline kecil 60px). `Buat project` hanya untuk admin (dialog: nama, key auto-uppercase 2–10 karakter dengan validasi live, deskripsi). Empty untuk admin: "Belum ada project" + tombol `Buat project`. Empty untuk member: "Kamu belum jadi member project mana pun. Minta maintainer menambahkanmu." (tanpa tombol).

**Project dashboard**
```
┌ Pass rate 7h  92% ▲3 │ Pass rate 30h  88% │ Run hari ini  14 │ Menunggu manual  2 ┐  ← satu strip border, divider vertikal
├ Tren run 30 hari (bar bertumpuk passed/failed/lainnya)  2/3 │ Paling sering gagal (top 5)  1/3 ┤
└ Run terakhir (tabel 10 baris, link "Lihat semua run")                                          ┘
```
Angka `text-2xl font-semibold tabular`. Grafik memakai token status. Setiap bar punya tooltip, dan tersedia tabel ringkasan `sr-only`. "Menunggu manual" menautkan ke runs dengan filter `awaiting_manual`.

**Test cases list**
```
┌ Test cases                                          [+ Test case ▾ Automated | Manual] ┐
├ Folder 240px      │ [Cari judul/key…] [Status▾][Prioritas▾][Tag▾][Execution▾][Last run▾] Reset │
│ ▾ Semua      24   │ ☐ Key      Judul                      Prioritas Status Tag   Last run   Diubah │
│   ▸ Auth      6   │ ☐ SHOP-T1  User bisa login…           ▲ High    Ready  auth  ✓ Passed 2j  Rina │
│   ▸ Checkout  9   │ ☐ SHOP-T4  Login dengan OTP ✋Manual   ─ Medium  Draft  …                   │
│ + Folder          │ ▸ bar bulk sticky saat ada pilihan: "3 dipilih · Pindah · Tag · Status · Run · Hapus · ✕" │
```
Semua state filter/search/folder/sort/halaman disimpan di URL (TanStack search params). Filter = Popover multi-select, chip aktif tampil di toolbar. Tree folder `role="tree"`: buat/rename inline, menu konteks (`⋯` + klik kanan), pindah via drag dengan alternatif keyboard lewat bulk "Pindah ke folder". Hapus folder yang berisi = konfirmasi + jumlah isi. Klik baris membuka editor; checkbox tidak ikut membuka. Shift+klik = pilih rentang, Esc mengosongkan pilihan. Tag ditampilkan sebagai chip netral (`bg-secondary`). Prioritas ditampilkan sebagai teks + ikon sinyal, dan hanya critical/high yang memakai `text-foreground font-medium`. Tablet: tree jadi tombol "Folder" yang membuka Sheet; kolom Tag dan Diubah disembunyikan.

**Test case editor (automated)**
```
┌ SHOP-T12  User bisa login dengan email & password   ● belum disimpan  [Form|JSON] [Run] [Simpan ⌘S] ┐
├ Steps (6) · Variables · Info · Revisi · Riwayat run                                                  │
├─────────────────────────────────────────────────────┬───────────────────────────────────────────────┤
│ ⋮⋮ 1  Globe  goto      Buka {{env.BASE_URL}}/login ✓ │ Step 4 · click                       [⋯]      │
│ ⋮⋮ 2  Text   fill      Isi `label=Email`           ✓ │ Selector  [role=button[name='Masuk']    ]     │
│▌⋮⋮ 4  Mouse  click     Klik `role=button[…Masuk]`  ✗ │  hint: utamakan role / label / testid         │
│ ⋮⋮ 5  Eye    expect_url URL mengandung /dashboard     │ Description [                    ]            │
│ + Tambah step   (N)                                   │ Expected    [                    ]            │
│                                                       │ ▸ Lanjutan: timeout, continue on failure, screenshot │
└───────────────────────────────────────────────────────┴───────────────────────────────────────────────┘
```
- Baris step: grip, nomor, ikon action, nama action (mono, muted), ringkasan human-readable dengan selector/nilai dalam mono, dot status run terakhir. Step disabled: `opacity-60` + label "Nonaktif" (bukan coret). Step dengan error validasi: bar kiri `bg-destructive`, ikon, dan jumlah error di tab Steps.
- Panel kanan 400px berisi form dinamis dari JSON Schema (react-hook-form + zod). Field dengan `{{` memunculkan autocomplete variable (env/vars/secret/fn). Field `secret.*` hanya menampilkan nama. Field selector menampilkan hint prioritas locator.
- **Palette action** (tombol `+ Tambah step` atau `N`): Popover + Command dengan grup Browser · Assertion · HTTP · Umum. Pencarian mencakup alias Indonesia ("klik", "isi", "tunggu"); tiap item punya deskripsi 1 baris. Step baru disisipkan setelah step terpilih, panel langsung terbuka, dan fokus pindah ke field pertama. `wait` diberi label peringatan "lebih baik wait_for".
- Drag reorder dengan dnd-kit (pointer + keyboard sensor). Aksi baris (menu `⋯`): Duplikat, Nonaktifkan/Aktifkan, Pindah ke atas/bawah, Hapus. Hapus satu step tidak memakai konfirmasi; sebagai gantinya ada toast sonner "Step dihapus · Urungkan" (5 detik).
- **Form/JSON**: JSON memakai CodeMirror selebar penuh, dan error schema tampil di gutter + daftar di bawah (path → pesan, klik untuk lompat). Kembali ke Form diblokir selama JSON tidak valid, dengan pesan alasannya. Sumber state-nya satu.
- Perubahan yang belum disimpan memunculkan indikator di header; berpindah halaman = dialog "Buang perubahan?". `Simpan` membuat revisi (toast "Revisi 7 tersimpan"). Konflik revisi (409) ditampilkan sebagai banner dengan pilihan "Muat ulang" / "Lihat perbedaan".
- **Varian manual**: badge `Hand` "Manual" di header, tanpa palette. Baris menampilkan Instruksi (clamp 2 baris) + Expected (muted). Panel berisi dua textarea (Instruksi, Expected) dengan autocomplete variable. Mengubah execution di tab Info = dialog konfirmasi yang menjelaskan nasib step.
- Tablet (<1280): panel jadi Sheet kanan di atas list.

**Flow builder**
```
┌ SHOP-F3  Checkout happy path                     [Run] [Simpan] ┐
├ [✓] Shared session  [✓] Stop on failure   Variables (1)          │
├──────────────────────────────────────────────┬──────────────────┤
│ 1 ⋮⋮ SHOP-T1 Login             Ready  ✓     │ Tambah test case │
│ 2 ⋮⋮ SHOP-T7 Tambah keranjang  Ready  ✗  [continue on failure ○] │ [Cari…]          │
│ 3 ⋮⋮ SHOP-T4 OTP  ✋Manual  ⚠ tidak boleh di shared session      │ hasil + status   │
└──────────────────────────────────────────────┴──────────────────┘
```
Item invalid ditampilkan inline (bar kiri destructive + pesan); `Run` diberi `aria-disabled` dengan tooltip alasan. Status `draft`/`deprecated` memunculkan peringatan, bukan blokir. Toggle continue-on-failure hanya relevan bila stop on failure aktif (selain itu disembunyikan). Item yang sama boleh muncul dua kali (tampilkan nomor urut).

**Run dialog** (`max-w-md`): Environment (select, ada tanda default) · Browser (segmented Chromium/Firefox/WebKit) · Viewport (preset + custom) · Screenshot (segmented Off / Saat gagal / Tiap step) · Video (Off / Saat gagal / Selalu) · Retries 0–2 · `▸ Lanjutan` (headless, timeout step/run). Nilai awal = pilihan terakhir project (localStorage per project, fallback default project). Catatan kecil di bawah Video: "Saat gagal tetap merekam, lalu dihapus jika passed." Target manual: hanya Environment + Assignee (maintainer bisa memilih orang lain). Submit langsung menuju run view (navigasi itu sendiri sudah jadi feedback, tanpa toast). Error pembuatan tampil inline di dialog.

**Run view**
```
┌ SHOP-R105  [⟳ Running] 00:42 · Flow SHOP-F3 Checkout · staging · Chromium · oleh Rina · 10:31   [Cancel][Re-run ▾][⋯] ┐
├ ██████████████▒▒░░░░░░  14/22 step · 13 passed · 1 failed                          (segmen per warna status)  │
├ Steps · Screenshots (6) · Video (1) · Detail                                                                    │
│ ▸ 1 SHOP-T1 Login                         ✓ Passed   3.2s                                                       │
│ ▾ 2 SHOP-T7 Tambah ke keranjang           ✗ Failed   4.1s                                                       │
│     ✓ 1 goto        Buka /produk                     0.8s  [▫]                                                  │
│     ✗ 3 expect_text Total keranjang                  10.0s                                                      │
│       ┌ Expected  Rp 50.000      Actual  Rp 0       (mono, berdampingan; stack di mobile)                       │
│       │ Timeout 10000ms menunggu `text=Rp 50.000`              [screenshot 320px → lightbox]                    │
│     ○ 4 click       Checkout                          Skipped                                                    │
```
- Durasi berjalan `tabular` dan update per detik; progress `role="progressbar"` dengan `aria-valuetext="14 dari 22 step"`.
- Case yang sedang berjalan selalu terbuka. Case yang passed tertutup otomatis setelah selesai. Case yang gagal terbuka. **Step gagal pertama di-expand dan di-scroll ke tampilan satu kali** (saat gagal muncul, atau saat halaman dibuka untuk run final), kecuali user sudah scroll/berinteraksi sejak run dimulai; pada kondisi itu tampilkan pill "1 step gagal ↓" saja.
- Step HTTP: collapsible request/response (method, URL, status, waktu, body JSON di CodeMirror read-only). Secret tampil `••••`. Artifact kedaluwarsa = placeholder abu "Artifact kedaluwarsa" dengan ukuran yang sama.
- Re-run ▾: "Re-run (opsi sama)", "Re-run yang gagal" (flow), "Ubah opsi & run…". `⋯`: Salin link, Export JSON. Cancel memakai konfirmasi.
- **Lightbox**: Dialog layar penuh `bg-background/95` (solid, tanpa blur). Gambar fit, klik = 100%/fit, ←/→ berpindah antar screenshot run, caption "Case 2 · Step 3 · expect_text", tombol Unduh / Buka di tab baru, Esc menutup, fokus kembali ke thumbnail asal.
- **Video**: `<video controls preload="metadata">` per case (atau satu per flow shared session), dengan label case di atasnya. Tidak autoplay.
- Mobile (report harus terbaca): header bertumpuk (key + badge, lalu meta wrap), tab bisa scroll horizontal, baris step wrap, screenshot di bawah teks dengan lebar penuh, Expected/Actual bertumpuk.

**Mode eksekusi manual** (run view saat user = assignee dan status awaiting manual)
```
┌ SHOP-R110 · Login dengan OTP SMS  [✋ Awaiting manual]  Step 2/5   Tersimpan 10:42   [Selesai] ┐
├ 1 ✓ Buka login ├───────────────── max-w-2xl ───────────────────────────────────────────┤
│ 2 ● Masukkan…  │ INSTRUKSI                                                                 │
│ 3   …          │ Masukkan kode OTP dari SMS              (text-2xl, variable ter-interpolasi) │
│ 4   …          │ EXPECTED                                                                  │
│ 5   …          │ Masuk ke dashboard                      (text-lg)                         │
│                │ [✓ Pass  P] [✗ Fail  F] [⊘ Blocked  B] [◌ Skip  S]   (h-9, kbd terlihat)   │
│                │ Actual result [textarea]                                                  │
│                │ Lampiran: tarik / pilih file / tempel (Ctrl+V)  [thumb ×][thumb ↻ gagal]  │
│                │ ← Sebelumnya (K)                                  Berikutnya (J) →         │
```
- Hanya satu step yang terfokus. Rail kiri = daftar step dengan status (klik untuk lompat). Shortcut **P/F/B/S/J/K** hanya aktif bila fokus tidak berada di field teks. Di dalam textarea, `Ctrl/⌘+Enter` = simpan lalu lanjut.
- Pass/Skip langsung maju ke step berikutnya yang belum ditandai. Fail/Blocked tetap di step tersebut dan memindahkan fokus ke Actual result (wajib diisi untuk Fail/Blocked, dengan validasi lembut sebelum pindah step). Tombol yang aktif `aria-pressed`, dan step yang sudah ditandai bisa diubah.
- Paste gambar di mana saja dalam mode ini akan melampirkan file. Teks biasa tetap ter-paste normal ke textarea. Tiap lampiran punya progress, retry, dan hapus.
- Autosave per step dengan indikator "Menyimpan… / Tersimpan 10:42" (`aria-live="polite"`); gagal simpan = banner + retry, dan status tidak hilang.
- `Selesai` membuka dialog ringkasan (x passed, y failed, …). Jika masih ada step yang belum ditandai, dialog menampilkan daftarnya + pilihan "Tandai sisanya Skipped & selesai" atau "Kembali".
- Non-assignee melihat layout yang sama secara read-only + "Dikerjakan oleh Rina", ter-update live. Maintainer mendapat tombol "Ganti assignee".
- Mobile: rail jadi stepper "Step 2/5 ▾" di atas, tombol keputusan grid 2×2 `h-11`, unggah dari kamera via `<input accept="image/*,video/*">`.

**Tugas saya** — tabel lintas project: Project · Run · Target · Progres (2/5 step) · Ditugaskan (relatif) · Status. Urutan default: paling lama dulu. Klik baris = masuk ke mode manual. Empty: "Tidak ada tugas manual. Run manual yang ditugaskan ke kamu akan muncul di sini."

**Environments** — list environment di kiri (bintang = default, `+ Environment`), dua section di kanan. **Variables**: tabel key/value mono, edit inline, tambah baris. **Secrets**: key · status ("Terisi · diubah 3 hari lalu" / "Belum diisi") · `Ganti nilai` · Hapus. Nilai secret **write-only**: input password (tombol tampilkan hanya untuk nilai yang sedang diketik), dan setelah disimpan tidak pernah ditampilkan lagi. Copy: "Nilai secret tidak bisa dilihat lagi setelah disimpan." Setiap key punya tombol salin `{{secret.KEY}}`. Non-maintainer: read-only, aksi disembunyikan.

**Project settings** (`max-w-3xl`, sub-nav kiri: Umum · Member · Default run · Retensi · Zona bahaya). Member: tabel nama/email · role (select inline untuk maintainer) · hapus (konfirmasi). `Tambah member` = combobox user yang sudah terdaftar (undangan user baru ada di Admin, beri link ke sana). Zona bahaya: arsipkan project dengan konfirmasi mengetik key project.

**Admin · Users** — tabel: nama · email · system role · status (invited/active/disabled, badge netral, disabled dengan teks muted) · login terakhir. `Buat user` = dialog (email, nama, role). Setelah sukses, dialog yang sama berganti ke state "Link undangan" berisi input mono read-only + `Salin` (berubah jadi "Tersalin ✓" 2 detik + toast) + "Berlaku 72 jam". Menu baris: Buat ulang link undangan · Buat link reset password · Ubah role · Nonaktifkan (konfirmasi destruktif: "Semua session dan API token Rina akan dicabut.").

**API token** (`/settings/tokens`) — tabel: nama · prefix `qat_ab12…` mono · scope (chip netral) · batas project · terakhir dipakai · kedaluwarsa · `Cabut`. `Buat token` = dialog (nama, scope read/write/run, batas project, kedaluwarsa 30/90 hari/tanpa). Setelah dibuat, dialog berganti ke state **sekali tampil**: banner peringatan "Salin sekarang — token tidak akan ditampilkan lagi", token mono + Salin, snippet MCP (`claude mcp add --transport http qatlas <origin>/mcp --header "Authorization: Bearer <token>"`) dengan token terisi + Salin, lalu tombol `Saya sudah menyalin`. Esc/klik luar sebelum ada salinan = konfirmasi. Cabut = dialog konfirmasi dengan nama token.

## 6. States

- **Loading**: skeleton dengan bentuk final (baris tabel h-9 × 8, blok panel), `animate-pulse` hanya bila motion diizinkan, tanpa spinner halaman penuh. Delay 150ms sebelum skeleton tampil agar tidak berkedip. Aksi tombol: spinner 14px di dalam tombol + `aria-busy`, lebar tombol dikunci.
- **Empty**: ikon lucide 20px muted + satu kalimat + **satu** aksi primary bila user berhak (mis. "Belum ada test case di folder ini" → `Buat test case`). Bedakan dari "tidak ada hasil filter", yang aksinya `Reset filter`.
- **Error**: inline di area yang gagal (tabel/panel), bukan toast. Isinya pesan manusiawi + `Coba lagi` + detail teknis collapsible (status, request id). 403 = "Kamu tidak punya akses ke halaman ini". 404 = key yang dicari + link kembali. Toast hanya untuk hasil aksi singkat (tersimpan, disalin, gagal simpan).
- **Destruktif**: AlertDialog, judul berupa kata kerja + objek ("Hapus 3 test case?"), konsekuensi konkret, tombol `destructive` berlabel aksi (bukan "OK"), fokus awal di `Batal`. Objek bernilai tinggi (project, environment yang punya secret) wajib mengetik key. Hapus step/item flow di editor = undo toast, bukan dialog.
- **Izin (sembunyikan vs disable)**: *Sembunyikan* jika role tidak akan pernah bisa (viewer: tidak ada Buat/Edit/Run/Hapus/Pengaturan/aksi bulk; editor: aksi edit environment/secret, member, dan Pengaturan project tidak tampil). *Disable* jika user berhak tapi kondisi belum terpenuhi (flow invalid, run sudah selesai, form belum valid). Pakai `aria-disabled="true"` (tetap bisa difokus) + tooltip/teks alasan via `aria-describedby`. Untuk viewer, form ditampilkan sebagai teks read-only (definition list / step list tanpa grip), bukan input disabled. Uji dengan dev toolbar ganti user (J8).

## 7. Checklist aksesibilitas

- [ ] Landmark: `nav` sidebar (`aria-label="Navigasi project"`), `header`, `main`, breadcrumb `nav aria-label="Breadcrumb"`. Ada skip link "Lompat ke konten".
- [ ] Fokus terlihat di semua kontrol: `focus-visible:ring-2 ring-ring ring-offset-2 ring-offset-background` (≥3:1, sudah dicek). Tidak ada `outline-none` tanpa pengganti.
- [ ] Step editor: list dengan roving tabindex. ↑/↓ memilih, Enter membuka panel dan memfokus field pertama, Esc kembali ke baris, Alt+↑/↓ memindah step (diumumkan: "Step 4 dipindah ke posisi 3"), `N` tambah, `D` duplikat, `E` aktif/nonaktif, Delete hapus (+ undo). dnd-kit memakai `KeyboardSensor` + `announcements` berbahasa Indonesia. Tiap baris punya nama aksesibel "Step 4, click, Klik tombol Masuk, gagal di run terakhir".
- [ ] Shortcut satu huruf tidak pernah aktif di dalam input, bisa dilihat di tooltip/`kbd`, dan ada daftarnya (`?`). Hindari chord yang dipakai browser (Ctrl+D/T/W/N/L); `⌘/Ctrl+S` dan `⌘/Ctrl+K` diizinkan dengan `preventDefault`.
- [ ] Mode manual: tombol keputusan bertipe `button` dengan `aria-keyshortcuts="P"` dsb. Saat pindah step, fokus pindah ke heading instruksi (`tabIndex=-1`) dan region `aria-live="polite"` mengumumkan "Step 3 dari 5". Lampiran yang ditempel diumumkan.
- [ ] Dialog/AlertDialog/Sheet (Radix): fokus terkunci, Esc menutup, fokus kembali ke pemicu. Dialog token/invite memindahkan fokus ke tombol Salin saat state berganti.
- [ ] Lightbox: `role="dialog" aria-modal`, label = caption, ←/→ diumumkan ("Screenshot 3 dari 6"), `alt` = "Screenshot step 3 (expect_text) pada SHOP-T7", fokus kembali ke thumbnail.
- [ ] Run live: satu region `aria-live="polite"` ringkas yang hanya mengumumkan **perubahan level case dan status final** ("Case 2 gagal", "Run selesai: Failed, 1 dari 3 case gagal"), bukan setiap step. Status final bisa `role="status"`. Spinner punya `aria-hidden`, label status adalah teks.
- [ ] Tree folder `role="tree"` / `treeitem` dengan `aria-expanded`. Tabel memakai `<table>` asli, checkbox baris berlabel "Pilih SHOP-T1", header bisa sort dengan `aria-sort`.
- [ ] Status tidak hanya warna (ikon + label). Grafik punya alternatif tabel. Kontras token sesuai §2.
- [ ] Form: setiap input punya `<Label>`, error lewat `aria-invalid` + `aria-describedby`. Fokus pindah ke field error pertama saat submit gagal. Input secret `autocomplete="new-password"`.
- [ ] Target sentuh ≥44px di breakpoint mobile untuk run view dan mode manual. Zoom 200% tanpa scroll horizontal di halaman form.
- [ ] Verifikasi milestone 1.8: tab-through tiap journey J1–J12 tanpa mouse, axe di e2e Playwright, dan cek light + dark.
