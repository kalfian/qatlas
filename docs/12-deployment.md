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
| Storage artifact | Direktori lokal (`QATLAS_DATA_DIR`) — sebaiknya mount point Proxmox terpisah agar mudah diperbesar & di-backup — atau S3-compatible |

## A. docker-compose

```
deploy/
├── docker-compose.yml        # postgres, server, worker (+ minio opsional via profile)
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
| `QATLAS_STORAGE` | `local` / `s3` (+ `QATLAS_S3_*`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_ALLOWED_DOMAINS` | |
| `WORKER_CONCURRENCY` | `2` |
| `QATLAS_RUNNER_CMD` | perintah runner Node |

Nilai rahasia tidak di-commit; `.env.example` hanya berisi placeholder.

## Jaringan & TLS

- `qatlas server` listen di port internal (mis. `8080`); TLS di reverse proxy yang sudah dipakai di infrastruktur.
- SSE butuh proxy yang tidak mem-buffer response (untuk nginx: `proxy_buffering off`; untuk Caddy umumnya langsung jalan — diverifikasi saat setup).
- Redirect URI Google: `{QATLAS_BASE_URL}/api/v1/auth/google/callback`.
- Worker butuh akses jaringan ke aplikasi yang dites (perhatikan firewall/VLAN LXC).

## Backup

- Postgres: `pg_dump` terjadwal + snapshot/backup LXC Proxmox.
- Artifact: ikut backup mount point (atau diabaikan bila dianggap sementara — sesuai retention).
- `QATLAS_MASTER_KEY`: simpan di password manager; tanpa kunci ini secret environment tidak bisa dibuka.

## Hal yang perlu diverifikasi saat setup pertama

- Chromium/Firefox/WebKit berjalan di LXC (unprivileged) — terutama sandbox & `/dev/shm`.
- Kebutuhan RAM nyata per run paralel (dari spike Phase 3) → tentukan ukuran LXC & `WORKER_CONCURRENCY`.
- Docker di dalam LXC (opsi A) stabil dengan storage backend yang dipakai (mis. ZFS → periksa storage driver Docker).
