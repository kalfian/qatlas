# 12 — Deployment (Proxmox LXC)

Target: satu (atau lebih) **LXC di Proxmox**. Dua cara deploy yang sama-sama didukung dan memakai konfigurasi environment variable yang sama.

| | A. docker-compose | B. Manual (systemd) |
|---|---|---|
| Cocok untuk | Setup cepat, upgrade = ganti tag image | LXC tanpa Docker, overhead minimal, kontrol penuh |
| Prasyarat LXC | Docker di dalam LXC → `features: nesting=1` (dan `keyctl=1` untuk unprivileged) | Tidak perlu fitur tambahan |
| Postgres | Container `postgres` | Paket OS (`postgresql`) atau LXC terpisah |
| Browser Playwright | Sudah ada di image worker (berbasis image Playwright resmi) | `npx playwright install --with-deps chromium` (OS harus didukung Playwright: Debian/Ubuntu) |

## Komponen yang di-deploy

| Komponen | Isi |
|----------|-----|
| `qatlas` (binary Go) | `server`, `worker`, `all`, `migrate`, `user create-admin` |
| `runner/` (build JS) | Dipanggil oleh `qatlas worker` (`QATLAS_RUNNER_CMD`, default `node /opt/qatlas/runner/dist/main.js`) |
| `web/` (build static) | Di-serve oleh `qatlas server` (`QATLAS_WEB_DIR`) |
| PostgreSQL | Data + job queue |
| Storage artifact | Direktori lokal (`QATLAS_DATA_DIR`) — sebaiknya mount point Proxmox terpisah agar mudah diperbesar & di-backup — atau bucket S3-compatible (Garage), lihat [Artifact storage](#artifact-storage-local-vs-s3-garage) |

## A. docker-compose

```
deploy/
├── docker-compose.yml        # postgres, server, worker (+ garage opsional via profile `s3`, demo-target via `demo`)
├── garage/                   # garage.toml contoh + init.sh (layout, bucket, key)
├── Dockerfile.server         # binary Go + build web (image kecil)
├── Dockerfile.worker         # base image Playwright resmi (versi = versi npm playwright) + binary Go + runner
└── .env.example
```

Catatan:
- Worker butuh `shm_size` cukup (mis. `1gb`) atau `ipc: host` agar Chromium tidak crash karena `/dev/shm` kecil.
- `qatlas migrate up` dijalankan sebagai one-shot service sebelum `server` start.
- Volume: `pgdata`, `artifacts` (bind ke mount point LXC).

## B. Manual (binary + systemd)

Layout:
```
/opt/qatlas/
├── bin/qatlas
├── runner/            # dist + node_modules (playwright)
└── web/               # build static
/etc/qatlas/qatlas.env # konfigurasi (chmod 600, owner qatlas)
/var/lib/qatlas/       # artifacts, temp run
```

Unit systemd:
- `qatlas-server.service` → `qatlas server`
- `qatlas-worker.service` → `qatlas worker` (boleh tidak di-enable jika worker di LXC lain)
- atau satu `qatlas.service` → `qatlas all` untuk instalasi kecil

Keduanya berjalan sebagai user non-root `qatlas`, `Restart=on-failure`, `EnvironmentFile=/etc/qatlas/qatlas.env`.

Script `deploy/install.sh` (Phase 2/3) menangani: buat user, salin file, install unit, migrate, restart. Upgrade = jalankan ulang dengan rilis baru; rollback = kembali ke direktori rilis sebelumnya (`/opt/qatlas/releases/<versi>` + symlink `current`).

## Konfigurasi (env, ringkas)

| Variable | Contoh |
|----------|--------|
| `QATLAS_DATABASE_URL` | `postgres://qatlas:…@localhost:5432/qatlas` |
| `QATLAS_BASE_URL` | `https://qatlas.example.com` (untuk redirect OAuth & link invite) |
| `QATLAS_MASTER_KEY` | 32 byte base64 — enkripsi secret environment (**wajib di-backup terpisah**) |
| `QATLAS_DATA_DIR` | `/var/lib/qatlas` |
| `QATLAS_STORAGE` | kosong (default) = pakai **Admin → Storage**; `local` / `s3` (+ `QATLAS_S3_*`) = override dari env, lihat bagian berikut |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` | kosong (default) = pakai **Admin → Google sign-in**; di-set = override dari env (UI read-only), lihat docs/05 |
| `WORKER_CONCURRENCY` | `2` |
| `QATLAS_RUNNER_CMD` | perintah runner Node |

Nilai rahasia tidak di-commit; `.env.example` hanya berisi placeholder.

## Artifact storage: local vs S3 (Garage)

**Atur storage dari Admin → Storage (direkomendasikan); variabel env meng-override.**

- **Admin → Storage** (admin, sesi login): pilih local atau S3, isi endpoint, region, bucket, access key ID dan secret → *Test* (connect / bucket / write / read / delete beserta latensi) → *Save*. Save selalu mem-probe bucket dulu (put + read + delete objek `.qatlas-probe-…`); gagal → 422 dengan check yang gagal (`checks.<nama>`) dan **tidak ada yang disimpan**.
- **Penyimpanan setting:** tabel `system_settings` (key `storage`); secret S3 dienkripsi AES-256-GCM dengan `QATLAS_MASTER_KEY` (sama seperti secret environment), **write-only** (tidak pernah dikembalikan API; kosongkan field untuk mempertahankan secret lama), tidak masuk audit log (`settings.storage.update` hanya mencatat field yang berubah + apakah secret diganti).
- **Ganti tanpa restart:** proses yang menyimpan langsung menukar store-nya, lalu `NOTIFY qatlas_settings` membuat server/worker lain me-reload (listener LISTEN dengan reconnect; reload juga saat start). Upload yang sedang berjalan selesai di store tempat ia mulai.
- **Backend per artifact:** tiap baris `artifacts` mencatat tempat file-nya ditulis (`artifacts.storage` = `local`|`s3`). Download, retention dan delete memakai backend baris itu, jadi file lama tetap terbaca setelah pindah backend (setting S3 tetap disimpan saat kembali ke local). Artifact di S3 sementara S3 tidak dikonfigurasi → 503 `storage_unavailable`. Mengganti bucket/endpoint S3 **tidak** memindahkan objek.
- **Migrasi dari UI:** tombol *Migrate* menjalankan job worker `storage_migrate` (queue `maintenance`) yang menyalin artifact dari backend lain ke backend aktif, memverifikasi ukuran, mengubah baris, opsional menghapus sumber (`delete_source`), dan menampilkan progres (total/copied/failed). Hanya satu sekaligus (409); aman diulang; tanpa artifact untuk dipindah → langsung `done` dengan total 0.
- **Override env:** `QATLAS_STORAGE` yang tidak kosong (`local` | `s3` + `QATLAS_S3_*`) menang atas database; Admin → Storage menampilkan nilai env (read-only), Save → 409 `env_override`. Hapus `QATLAS_STORAGE` dan restart sekali untuk mengelola dari UI.
- **Setting DB rusak tidak menghalangi start:** bila S3 yang dipilih di UI gagal probe saat start, proses mencatat error, menyimpan artifact baru ke lokal, mengecek ulang tiap menit, dan Admin → Storage menampilkan alasannya (`warning`).
- **Upgrade dari instance dengan `QATLAS_STORAGE=s3`:** baris artifact lama default `local`. Biarkan `QATLAS_STORAGE=s3` di env saat `qatlas migrate up` / start pertama setelah upgrade — baris lama ditandai `s3` sekali (marker `artifacts_storage_backfill`). Bila terlewat: `UPDATE artifacts SET storage = 's3' WHERE storage = 'local';` (cek dengan `qatlas artifacts check`).

| | local (default) | S3 |
|---|---|---|
| Lokasi file | `QATLAS_DATA_DIR/artifacts/<project>/<run>/<artifact>.<ext>` | bucket, key `[prefix/]<project>/<run>/<artifact>.<ext>` (format key sama) |
| Server + worker beda CT | butuh direktori bersama (NFS/mount) | cukup akses jaringan ke endpoint S3 |
| Backup | ikut mount point | sisi Garage (snapshot CT / data dir) |

Variabel env (hanya untuk override; field yang sama ada di Admin → Storage, `backend/.env.example`):

| Variable | Default | Keterangan |
|---|---|---|
| `QATLAS_STORAGE` | kosong (= Admin → Storage) | `local` atau `s3`: mengunci backend, UI read-only |
| `QATLAS_S3_ENDPOINT` | — | URL dengan skema, tanpa path: `https://garage.kalfian.work` |
| `QATLAS_S3_REGION` | `us-east-1` | Garage: nilai `s3_region` di `garage.toml` (biasanya `garage`) |
| `QATLAS_S3_BUCKET` | — | bucket harus sudah ada |
| `QATLAS_S3_ACCESS_KEY` / `QATLAS_S3_SECRET_KEY` | — | key Garage dengan izin read + write ke bucket; secret tidak pernah di-log |
| `QATLAS_S3_FORCE_PATH_STYLE` | `true` | `https://host/bucket/key` (Garage/MinIO); `false` = virtual-host (AWS) |
| `QATLAS_S3_PREFIX` | kosong | prefix key opsional bila bucket dipakai bersama |

Perilaku:
- **Validasi saat start (override env).** Variabel yang kurang/salah format → `qatlas` berhenti dengan pesan per variabel. Dengan `QATLAS_STORAGE` di env, `server`, `worker` dan `all` memeriksa store (bucket ada + tulis, baca & hapus satu objek probe `.qatlas-probe-…`); gagal → proses tidak start (`artifact storage check failed (QATLAS_STORAGE=s3): … bucket does not exist` / `Access Denied (check QATLAS_S3_ACCESS_KEY …)`). Setting dari UI tidak pernah menghalangi start (lihat di atas).
- **`/readyz`** melaporkan `database`, `storage` (`ok`/`error`) dan `storage_backend` (backend untuk artifact baru: `local`/`s3`); storage tak terjangkau → 503 `artifact storage unreachable` (detail hanya di log).
- **Download tetap lewat server.** Bucket tetap private; `GET /api/v1/artifacts/{id}` mengecek RBAC lalu men-stream objek. Range (seek video) diterjemahkan menjadi GET ber-`Range` ke S3 (paling banyak 8 MiB per request, dikunci ke ETag objek), jadi seek tidak mengunduh seluruh file. Header CSP sandbox, `ETag` (id artifact) dan `Last-Modified` sama seperti mode lokal.
- **Upload** (screenshot/video dari worker, lampiran tester) dikirim dengan `Content-Type` artifact; ukuran tak diketahui ≤ 16 MiB → satu PUT, lebih besar → multipart.
- **Retention** menghapus objek dari backend masing-masing baris (S3 atau lokal); baris di backend yang tidak dikonfigurasi dibiarkan.

### Garage di CT terpisah (mis. `garage.kalfian.work`)

1. Garage WebUI → **Buckets** → buat bucket (mis. `qatlas`).
2. Garage WebUI → **Keys** → *Create key* (mis. `qatlas-app`) → salin **Access Key ID** (`GK…`) dan **Secret Key** (tampilkan dengan ikon mata / *show secret*). Lewat CLI: `garage key create qatlas-app`, lalu `garage key info --secret-key qatlas-app`.
3. Beri key izin **Read** + **Write** ke bucket (WebUI: halaman bucket → *Permissions* / *Allow key*; CLI: `garage bucket allow --read --write qatlas --key qatlas-app`). Izin *Owner* tidak perlu.
4. Admin → Storage → S3: endpoint `https://garage.kalfian.work`, region `garage`, bucket `qatlas`, access key ID + secret → *Test* → *Save*. (Atau kunci lewat env di `/etc/qatlas/qatlas.env` / `deploy/.env` lalu restart:)
   ```
   QATLAS_STORAGE=s3
   QATLAS_S3_ENDPOINT=https://garage.kalfian.work
   QATLAS_S3_REGION=garage
   QATLAS_S3_BUCKET=qatlas
   QATLAS_S3_ACCESS_KEY=GK…
   QATLAS_S3_SECRET_KEY=…
   ```
5. Pindahkan file lama dengan Admin → Storage → *Migrate* (atau CLI di bawah); cek `curl -fsS http://127.0.0.1:8090/readyz` → `"storage":"ok","storage_backend":"s3"`.

### Garage di docker-compose (profile `s3`)

`deploy/docker-compose.yml` punya service opsional `garage` (`dxflrs/garage:v2.5.0`, config `deploy/garage/garage.toml`, volume `garage-meta` + `garage-data`/`GARAGE_DATA`, tidak di-publish ke host). Isi `GARAGE_RPC_SECRET` (`openssl rand -hex 32`) di `deploy/.env`, lalu:

```sh
docker compose -f deploy/docker-compose.yml --profile s3 up -d garage
deploy/garage/init.sh              # layout node tunggal, bucket qatlas, key qatlas-app → mencetak nilainya
docker compose -f deploy/docker-compose.yml --profile s3 up -d
# isi di Admin → Storage (endpoint http://garage:3900, region garage), atau tempel baris QATLAS_S3_* ke deploy/.env sebagai override
```

### Pindah dari lokal ke S3

Cara biasa: simpan S3 di Admin → Storage, lalu *Migrate*. CLI melakukan hal yang sama di foreground (untuk script / store sangat besar):

```sh
qatlas artifacts migrate --from local --to s3 --dry-run   # daftar file yang akan disalin
qatlas artifacts migrate --from local --to s3             # salin + ubah baris (idempotent; objek dengan ukuran sama tidak disalin ulang)
qatlas artifacts check                                    # setiap artifact (belum expired) ada di store backend-nya?
qatlas artifacts migrate --from local --to s3 --delete-local   # opsional: hapus juga salinan lokal
```

Migrasi membaca baris `artifacts` yang belum di-purge dan tersimpan di `--from` (file yatim tanpa baris DB tidak disalin), menyalin dengan `Content-Type` dari DB, memverifikasi ukuran, lalu mengubah `artifacts.storage` ke `--to` sehingga download tetap jalan selama migrasi. Setting S3 diambil dari `QATLAS_S3_*` bila lengkap, selain itu dari Admin → Storage. Backend untuk artifact *baru* tidak diubah (Admin → Storage / `QATLAS_STORAGE`). `--from s3 --to local` juga bisa (rollback). Exit status 1 bila ada objek gagal (`migrate`) atau hilang/beda ukuran/di backend yang tidak dikonfigurasi (`check`).

## Jaringan & TLS

- `qatlas server` listen di port internal (mis. `8080`); TLS di reverse proxy yang sudah dipakai di infrastruktur.
- SSE butuh proxy yang tidak mem-buffer response (untuk nginx: `proxy_buffering off`; untuk Caddy umumnya langsung jalan — diverifikasi saat setup).
- Google sign-in: atur dari **Admin → Google sign-in** (upload OAuth client JSON tipe *Web application*). Redirect URI yang didaftarkan di Google Cloud Console: `{QATLAS_BASE_URL}/api/v1/auth/google/callback`, JavaScript origin: `{QATLAS_BASE_URL}` — `QATLAS_BASE_URL` harus https (kecuali localhost).
- Worker butuh akses jaringan ke aplikasi yang dites (perhatikan firewall/VLAN LXC).

## Backup

- Postgres: `pg_dump` terjadwal + snapshot/backup LXC Proxmox.
- Artifact: ikut backup mount point (atau diabaikan bila dianggap sementara — sesuai retention).
- `QATLAS_MASTER_KEY`: simpan di password manager; tanpa kunci ini secret environment tidak bisa dibuka.

## Hal yang perlu diverifikasi saat setup pertama

- Chromium/Firefox/WebKit berjalan di LXC (unprivileged) — terutama sandbox & `/dev/shm`.
- Kebutuhan RAM nyata per run paralel (dari spike Phase 3) → tentukan ukuran LXC & `WORKER_CONCURRENCY`.
- Docker di dalam LXC (opsi A) stabil dengan storage backend yang dipakai (mis. ZFS → periksa storage driver Docker).
