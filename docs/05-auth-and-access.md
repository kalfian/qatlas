# 05 — Auth & Access

## Prinsip

- **Tidak ada self sign-up.** Hanya user yang dibuat/diundang admin yang bisa login.
- Dua metode login untuk user terdaftar: **email + password** dan **Google**.
- Akses data diatur per project (RBAC). Admin sistem bisa melihat & mengatur semuanya.

## Onboarding user

1. Admin membuat user di `/admin/users` (email, nama, system role).
2. Sistem membuat **invite link** sekali pakai (berlaku mis. 72 jam). v1: link ditampilkan untuk disalin admin; kirim email via SMTP = opsional (phase 5).
3. User membuka link → set password **atau** langsung "Login with Google" dengan email yang sama.
4. Status user `invited` → `active`.

Bootstrap: admin pertama dibuat lewat CLI `qatlas user create-admin --email ...` (tidak ada endpoint publik untuk ini).

## Email + password

- Hash **argon2id** (parameter disimpan di string hash agar bisa di-upgrade).
- Minimal 8 karakter (invite accept, ganti password, `qatlas user create-admin`); cek terhadap daftar password umum.
- Rate limit login per IP + per email; lockout sementara setelah N kali gagal. Di belakang proxy (`QATLAS_TRUST_PROXY=true`) IP diambil dari entri paling kanan `X-Forwarded-For`, `X-Real-IP` hanya fallback (header itu bisa dikirim klien dan diteruskan Caddy/Cloudflare).
- Pesan error generik ("email atau password salah") agar tidak membocorkan keberadaan akun.
- Reset password: admin generate reset link (v1); self-service via email (phase 5, butuh SMTP).

## Login with Google (hanya user terdaftar)

- OAuth2 Authorization Code + **PKCE**, `state` & `nonce`; verifikasi ID token via `go-oidc`.
- Syarat diterima:
  1. `email_verified == true`;
  2. email cocok dengan user berstatus `invited`/`active` (case-insensitive);
  3. jika user sudah punya `google_sub`, harus sama (mencegah pembajakan jika email Google berpindah tangan);
  4. opsional allowed domains dari konfigurasi aktif (mis. hanya `perusahaan.com`).
- Flow selalu berjalan di host `QATLAS_BASE_URL`: `/auth/google/start` yang dibuka dari hostname lain (mis. domain LAN `*.kalfian.work` di samping domain publik) di-redirect dulu ke `{QATLAS_BASE_URL}/api/v1/auth/google/start`, karena cookie state harus ada di host tempat Google mengirim callback. Sesi hasil login Google ada di host base URL.
- Login pertama → simpan `google_sub`, status jadi `active`.
- Jika tidak terdaftar → redirect ke `/login?error=not_registered` dengan pesan "Akun belum terdaftar, hubungi admin". **Tidak** membuat user baru.

### Konfigurasi: Admin → Google sign-in

- **Admin → Google sign-in** (admin, sesi login; API token 403): upload file OAuth client JSON dari Google Cloud Console, aktifkan, opsional isi allowed domains → *Save*. Berlaku tanpa restart (`/auth/config.google_enabled`, `/auth/google/start|callback` membaca konfigurasi aktif per request; proses lain me-reload lewat `NOTIFY qatlas_settings 'google_auth'`).
- Di Google Cloud Console: *APIs & Services → Credentials → Create credentials → OAuth client ID*, tipe **Web application** (client "Desktop app"/`installed` ditolak). Daftarkan **Authorized redirect URI** `{QATLAS_BASE_URL}/api/v1/auth/google/callback` dan **Authorized JavaScript origin** `{QATLAS_BASE_URL}` (keduanya ditampilkan di halaman admin), lalu download JSON-nya (berisi `client_secret` hanya saat client/secret baru dibuat).
- Validasi (422 `validation_failed`, detail `client_json`): JSON harus terbaca, punya bagian `web` dengan `client_id` (`….apps.googleusercontent.com`) dan `client_secret`; `project_id`, `redirect_uris`, `javascript_origins` ikut disimpan. Allowed domains dinormalisasi (lowercase, tanpa `@`, harus hostname valid; error di `allowed_domains[i]`). Tanpa `client_json` → kredensial lama dipertahankan (wajib saat pertama kali).
- Penyimpanan: `system_settings` key `google_auth`; `client_secret` dienkripsi dengan `QATLAS_MASTER_KEY` (`secret_enc`), **write-only** (tidak pernah dikembalikan API, tidak di-log, tidak masuk audit). Audit `settings.google_auth.update|delete` mencatat `client_id` + field yang berubah.
- `GET` menunjukkan `redirect_uri_registered` (apakah JSON yang di-upload memuat redirect URI di atas) dan `warning` bila belum terdaftar, bila `QATLAS_BASE_URL` bukan https (Google hanya menerima http untuk localhost) atau masih default.
- **Override env:** bila `GOOGLE_CLIENT_ID` (+ `GOOGLE_CLIENT_SECRET`, opsional `GOOGLE_ALLOWED_DOMAINS`) di-set di environment server, env yang dipakai (`source: env`, halaman admin read-only, PUT/DELETE → 409 `env_override`). `GOOGLE_ALLOWED_DOMAINS` tanpa `GOOGLE_CLIENT_ID` diabaikan.
- `DELETE` menghapus konfigurasi tersimpan → Google sign-in nonaktif (kecuali dari env).

## Session (web)

- Token session acak 32 byte, disimpan **hash**-nya di tabel `sessions`; dikirim sebagai cookie `HttpOnly`, `Secure`, `SameSite=Lax`.
- Masa berlaku sliding (mis. 7 hari idle, maks 30 hari).
- CSRF: request yang mengubah data wajib header `X-CSRF-Token` (double-submit) — ditambah SameSite.
- Logout menghapus session; admin bisa revoke semua session user (otomatis saat user di-disable).

## API token (untuk MCP & CI)

- Dibuat user di `/settings/tokens`; ditampilkan **sekali**: `qat_<prefix>_<secret>`. Disimpan hash SHA-256.
- Atribut: nama, scopes (`read`, `write`, `run`), batas project opsional, kedaluwarsa opsional.
- Hak efektif = **irisan** scope token ∩ role user di project. Token tidak pernah bisa melebihi hak pemiliknya.
- Dipakai sebagai `Authorization: Bearer qat_...` untuk REST maupun `/mcp`.
- `last_used_at` diperbarui; token bisa di-revoke kapan saja; user di-disable → semua token mati.

## RBAC

**System role**

| Role | Hak |
|------|-----|
| `admin` | Kelola user, buat project, akses penuh semua project |
| `member` | Hanya project tempat ia menjadi member |

**Project role**

| Aksi | viewer | editor | maintainer |
|------|:------:|:------:|:----------:|
| Lihat test case, flow, run, report | ✅ | ✅ | ✅ |
| Buat/ubah/hapus test case, folder, flow | | ✅ | ✅ |
| Jalankan run, cancel run sendiri | | ✅ | ✅ |
| Mengerjakan bagian manual run (sebagai assignee) | | ✅ | ✅ |
| Ganti assignee run manual | | | ✅ |
| Cancel run orang lain | | | ✅ |
| Kelola environment & secret | | | ✅ |
| Kelola member & setting project, archive project | | | ✅ |

> Perlu dikonfirmasi: apakah perlu role "runner" (boleh run tapi tidak edit)? Lihat [11](11-open-questions.md).

Implementasi: satu fungsi `authz.Can(actor, action, project)` di service layer, dipakai oleh REST handler & MCP tool.

## Audit log

Dicatat: login (sukses/gagal), perubahan user/role/member, perubahan environment/secret (tanpa nilai), create/update/delete test case & flow, run dibuat/di-cancel, token dibuat/di-revoke.

## Catatan keamanan lain

- Secret environment dienkripsi AES-256-GCM dengan `QATLAS_MASTER_KEY`; tidak pernah dikirim balik ke FE (hanya nama + "set/belum set").
- Runner bisa mengakses jaringan internal (sifat alat testing). Sediakan opsi **allowlist host per project** untuk mengurangi risiko SSRF bila instance dipakai banyak tim.
- Screenshot/video bisa berisi data sensitif aplikasi target → akses artifact selalu melewati cek RBAC; retention dibatasi.
