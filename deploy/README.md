# Deploying QAtlas

Target: one (or more) **Proxmox LXC** containers. Two supported methods share the same
environment variables (reference: [`backend/.env.example`](../backend/.env.example), design:
[`docs/12-deployment.md`](../docs/12-deployment.md)):

| | A. docker-compose | B. Binary + systemd |
|---|---|---|
| Good for | quick setup, upgrade = new image tag | LXC without Docker, minimal overhead |
| LXC features | `nesting=1` (+ `keyctl=1` if unprivileged) | `nesting=1` (default for new CTs; needed by the unit sandboxing) |
| Postgres | `postgres:16` container (not published on the host) | OS package or a separate LXC |
| Browsers | in the worker image (official Playwright 1.64.1 image) | `install.sh` runs `playwright install --with-deps chromium` |
| Files | `deploy/docker-compose.yml`, `Dockerfile.server`, `Dockerfile.worker`, `.env.example` | `deploy/install.sh`, `rollback.sh`, `systemd/*.service`, `qatlas.env.example` |

Processes: `qatlas server` (API + SPA, port **8090**), `qatlas worker` (job queue + Node runner
+ Chromium), or both in one process with `qatlas all`. Health: `GET /healthz` (process up),
`GET /readyz` (database and artifact storage reachable). Artifacts live on local disk or in an
S3 bucket (Garage) — see [Artifact storage](#artifact-storage-local-or-s3-garage).

---

## 0. Prepare the LXC (Proxmox host)

Template: **Debian 12** or **Ubuntu 24.04** (both supported by Playwright `--with-deps`).
Sizing to start with: 2 vCPU, 4 GB RAM (+ ~0.5 GB per extra `WORKER_CONCURRENCY` slot), 20 GB
root disk; artifacts on their own mount point so they can grow and be backed up separately.

```sh
# on the Proxmox host (CT 120 as an example)
pct set 120 --features nesting=1                 # method B (systemd sandboxing)
pct set 120 --features nesting=1,keyctl=1        # method A, unprivileged CT (Docker in LXC)
pct set 120 -mp0 local-zfs:50,mp=/var/lib/qatlas # artifacts volume (method B path)
# for method A mount it e.g. at /mnt/qatlas-artifacts and set QATLAS_ARTIFACTS to that path
pct reboot 120
```

- Unprivileged CT: container uid N is host uid 100000+N. Always `chown` from **inside** the CT.
- Docker on ZFS-backed CTs: check `docker info | grep -i 'storage driver'` → it must be
  `overlay2` (ZFS ≥ 2.2, i.e. PVE ≥ 8.1). `vfs` works but is slow and wastes disk.
- The worker must reach the apps under test (firewall / VLAN of the CT).

---

## A. docker-compose

### Install

```sh
# inside the CT: Docker Engine + compose plugin (https://docs.docker.com/engine/install/debian/)
apt-get update && apt-get install -y ca-certificates curl git openssl
# … add Docker's apt repo as documented, then:
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

git clone https://github.com/kalfian/qatlas.git /opt/qatlas-src && cd /opt/qatlas-src
git checkout <release-tag>
cp deploy/.env.example deploy/.env && chmod 600 deploy/.env
openssl rand -hex 24        # → POSTGRES_PASSWORD (URL-safe, it is part of the DSN)
openssl rand -base64 32     # → QATLAS_MASTER_KEY (store it in the password manager NOW)
$EDITOR deploy/.env         # + QATLAS_BASE_URL, QATLAS_VERSION=<release-tag>, ports

docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml exec server \
  qatlas user create-admin --email you@example.com --name "Your Name"   # prompts for a password
```

Service order: `postgres` (healthy) → `migrate` (one-shot `qatlas migrate up`, exits 0) →
`server` + `worker`. The app is published on `${QATLAS_BIND_ADDR}:${QATLAS_HTTP_PORT}`
(default `0.0.0.0:8090`); Postgres is not published (`docker compose exec postgres psql -U qatlas qatlas`).
The worker gets `shm_size: 1gb` (`WORKER_SHM_SIZE`) and `init: true` for Chromium.
Server (uid 1001 `qatlas`) and worker (uid 1001 `pwuser`) share the `artifacts` volume; a
bind-mounted artifacts directory must be `chown -R 1001:1001`.

Demo target app ("Tokoku", port 8099) and Mailpit (email catcher for the sign-up / verification
demo cases; UI+API port 8025), both published on 127.0.0.1 only:

```sh
docker compose -f deploy/docker-compose.yml --profile demo up -d --build
docker compose -f deploy/docker-compose.yml exec server \
  qatlas seed demo --target-url http://demo-target:8099 --admin-token adm_stg_8f3a \
    --mailpit-url http://mailpit:8025
```

`qatlas seed demo` creates the demo users (`rina@tokoku.id` admin, `dimas@`/`sari@` with
`--password`, default `password123`; `budi@` stays invited and gets a printed invite link) and the
projects SHOP/PAY with environments, folders, test cases and flows. Existing projects are skipped
(`--reset` recreates them, deleting their runs); `--runs` enqueues a few demo runs for the worker.
`--admin-token` must match the demo target's `DEMO_ADMIN_TOKEN` (default `adm_stg_8f3a`) for
SHOP-T17; without it the secret is random. `--mailpit-url` is where the worker reaches Mailpit for
the email cases (SHOP-T21/T22), and `--qa-totp-seed` must match the demo target's `DEMO_TOTP_SEED`
for the TOTP case (SHOP-T20; both default to the public demo seed). `qatlas seed demo --help` lists
every flag.

### Targets reachable only through the host's VPN

If the apps under test are only reachable through a VPN or route on the Docker host (OpenVPN
`tun0`, WireGuard, Tailscale subnet routes, split DNS), run the worker on the host network with
the override `deploy/docker-compose.host-worker.yml`:

```sh
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.host-worker.yml \
  --env-file deploy/.env up -d --build
```

The worker then uses the host's routes and resolver, like a browser on that machine. Because it can
no longer resolve the `postgres` service name, Postgres is published on loopback only
(`127.0.0.1:${QATLAS_DB_HOST_PORT:-55434}`) and the worker connects there. Pick a free port with
`QATLAS_DB_HOST_PORT` in `.env` if 55434 is taken.

### Upgrade / rollback

```sh
cd /opt/qatlas-src && git fetch --tags && git checkout <new-tag>
sed -i 's/^QATLAS_VERSION=.*/QATLAS_VERSION=<new-tag>/' deploy/.env
docker compose -f deploy/docker-compose.yml up -d --build   # migrate runs before server/worker start
```

With a registry instead of building on the CT: `make docker VERSION=<tag> IMAGE_PREFIX=registry.example.com/qatlas/`,
`docker push` both images, set `QATLAS_IMAGE_PREFIX` + `QATLAS_VERSION` in `deploy/.env`, then
`docker compose -f deploy/docker-compose.yml pull && docker compose -f deploy/docker-compose.yml up -d`.

Rollback = set `QATLAS_VERSION` back to the previous tag (its images are still present) and
`up -d`. Migrations are not rolled back; take a `pg_dump` before every upgrade (see Backups).

---

## B. Binary + systemd

### Build the release (any machine with Go 1.27, Node 22, corepack)

```sh
make release VERSION=0.3.0     # → dist/qatlas-0.3.0-linux-amd64.tar.gz (+ .sha256)
```

Contents: `VERSION`, `bin/qatlas` (static), `web/` (SPA, real API mode), `runner/dist` +
`package.json` + `package-lock.json` (production dependency only: `playwright@1.64.1`),
`deploy/{install.sh,rollback.sh,qatlas.env.example,README.md,systemd/*.service}`.

### Packages on the CT (Debian 12 / Ubuntu 24.04)

```sh
apt-get update && apt-get install -y ca-certificates curl tar gnupg
# Node.js 22 — the distro packages are too old (Debian 12: 18, Ubuntu 24.04: 18).
# NodeSource (https://github.com/nodesource/distributions): installs /usr/bin/node + npm
curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
less /tmp/nodesource_setup.sh && bash /tmp/nodesource_setup.sh && apt-get install -y nodejs

# PostgreSQL (or point QATLAS_DATABASE_URL at another LXC). QAtlas is developed on 16:
# Ubuntu 24.04 ships 16; on Debian 12 use the PGDG repo (https://www.postgresql.org/download/linux/debian/).
apt-get install -y postgresql
sudo -u postgres createuser -P qatlas            # choose a URL-safe password
sudo -u postgres createdb -O qatlas qatlas
```

Chromium's OS libraries are installed by `install.sh` (`playwright install --with-deps`, uses apt).

### Install

```sh
sha256sum -c qatlas-0.3.0-linux-amd64.tar.gz.sha256
tar -xzf qatlas-0.3.0-linux-amd64.tar.gz
sudo ./qatlas-0.3.0-linux-amd64/deploy/install.sh          # first run: writes /etc/qatlas/qatlas.env, exits 2
sudo $EDITOR /etc/qatlas/qatlas.env                        # QATLAS_DATABASE_URL, QATLAS_BASE_URL; back up the generated QATLAS_MASTER_KEY
sudo ./qatlas-0.3.0-linux-amd64/deploy/install.sh          # installs, migrates, starts
sudo qatlas user create-admin --email you@example.com --name "Your Name"
```

`install.sh` is idempotent. Options: `--mode split|all|server|worker` (default: previous mode,
first install `split` = `qatlas-server` + `qatlas-worker`; `all` = one `qatlas.service`),
`--browsers "chromium webkit"`, `--skip-browsers`, `--skip-migrate`, `--no-start`, `--keep N`,
`--release-dir <dir|tar.gz>`. Worker on a separate CT: install the same release there with
`--mode worker` (no migrations run there) and allow it in Postgres' `pg_hba.conf`.

Layout:

```
/opt/qatlas/releases/<version>/{bin/qatlas,web,runner,deploy}
/opt/qatlas/current  -> releases/<version>       /opt/qatlas/previous -> releases/<older>
/opt/qatlas/ms-playwright/                       # browsers (PLAYWRIGHT_BROWSERS_PATH), shared by releases
/etc/qatlas/qatlas.env                           # root:qatlas 0640, systemd EnvironmentFile syntax
/etc/qatlas/install-mode                         # split | all | server | worker
/var/lib/qatlas/                                 # QATLAS_DATA_DIR + HOME of user qatlas (artifacts, run temp dirs)
/usr/local/sbin/qatlas                           # wrapper: runs the current binary as qatlas with qatlas.env
/etc/systemd/system/qatlas{,-server,-worker}.service
```

The units run as the non-root user `qatlas` with `NoNewPrivileges`, `ProtectSystem=strict`
(+ `ReadWritePaths=/var/lib/qatlas`), `ProtectHome`, `PrivateTmp`, kernel/cgroup protection,
an empty capability set and restricted address families. The server additionally uses
`PrivateDevices`, `MemoryDenyWriteExecute`, `RestrictNamespaces` and a `@system-service`
syscall filter; the worker/all-in-one units leave those out because Node's JIT and Chromium
need them. A `226/NAMESPACE` exit status means the CT lacks `nesting=1`. To relax an option
locally use a drop-in (`systemctl edit qatlas-worker`), not the shipped file:

```ini
[Service]
ProtectKernelTunables=no
```

### Upgrade / rollback

```sh
sudo -u postgres pg_dump -Fc qatlas > /root/qatlas-before-0.4.0.dump    # always
sudo ./qatlas-0.4.0-linux-amd64/deploy/install.sh   # migrate with the new binary → switch current → restart
sudo /opt/qatlas/current/deploy/rollback.sh          # back to /opt/qatlas/previous
sudo /opt/qatlas/current/deploy/rollback.sh --list   # or: rollback.sh <version>
```

Migrations run *before* `current` is switched; if they fail, the old release keeps running.
Rollback does not touch the database (restore the dump if the new schema is incompatible).
The last 5 releases are kept (`--keep`), plus whatever `current`/`previous` point at.

---

## Artifact storage: local or S3 (Garage)

Screenshots, videos and attachments live either under `QATLAS_DATA_DIR/artifacts` (local, the
default) or in an S3-compatible bucket. The bucket stays private: downloads still go through
`GET /api/v1/artifacts/{id}` (RBAC, HTTP Range for video seeking — translated into ranged GETs
against the bucket). Storage keys are the same everywhere (`<project>/<run>/<artifact>.<ext>`,
plus the optional prefix).

**Configure storage from Admin → Storage (recommended); env vars override.**

- **Admin → Storage** (admins, signed-in session): choose local or S3, enter endpoint, region,
  bucket, access key ID and secret, *Test* (connect / bucket / write / read / delete, with
  timings), *Save*. Saving probes the bucket first (put + read + delete a `.qatlas-probe-…`
  object) and refuses with the failing check — nothing is saved. The settings are stored in
  the database (`system_settings`); the secret is AES-256-GCM encrypted with
  `QATLAS_MASTER_KEY`, write-only (never returned; leave it empty to keep the stored one) and
  never in the audit log (`settings.storage.update` records which fields changed and whether
  the secret was replaced). Server and worker switch **without a restart**: the saving process
  swaps its stores at once and `NOTIFY qatlas_settings` makes every other server/worker reload.
  Uploads already in flight finish on the store they started with.
- **Per-artifact backend:** every artifact row records where its file was written
  (`artifacts.storage`). Downloads, retention and deletes use that backend, so switching never
  strands older files — local files stay readable after switching to S3 and vice versa (S3
  settings are kept when you switch back to local). An artifact on S3 while no S3 is configured
  answers 503 `storage_unavailable`. Changing the bucket/endpoint of a configured S3 does
  **not** move objects: migrate to local first, or copy the bucket yourself.
- **Migrate from the UI:** *Migrate* copies every artifact stored on the other backend into the
  active one in the background (worker job `storage_migrate`, queue `maintenance`), verifies
  the size, flips each row, optionally deletes the source, and shows progress. One at a time
  (409 while queued/running); re-running is safe.
- **Environment override:** a non-empty `QATLAS_STORAGE` (`local` | `s3` + `QATLAS_S3_*` below)
  wins over the database; Admin → Storage shows the env values read-only and Save answers 409
  `env_override`. Remove `QATLAS_STORAGE` (and restart once) to manage storage in the UI. In
  override mode `server`, `worker` and `all` still refuse to start when the configured store
  fails its probe, e.g. `artifact storage check failed (QATLAS_STORAGE=s3): … Access Denied`.
- **Broken database settings never block startup:** when the S3 selected in the UI fails its
  probe at start, the process logs an error, stores new artifacts locally, re-checks every
  minute and Admin → Storage shows the reason (`warning`) until it works again or is fixed.
- `/readyz` returns `{"status":"ok","database":"ok","storage":"ok","storage_backend":"s3"}`
  (the backend new artifacts go to), or 503 with `"storage":"error"` while it is unreachable.

**Upgrading an instance that ran with `QATLAS_STORAGE=s3`:** artifact rows created before this
version default to `local`. Keep `QATLAS_STORAGE=s3` in the environment for the first
`qatlas migrate up` / start after the upgrade — it marks the existing rows as `s3` once (marker
`artifacts_storage_backfill`). If that was missed: `UPDATE artifacts SET storage = 's3' WHERE
storage = 'local';` (only when every file really is in the bucket; `qatlas artifacts check`
verifies). Afterwards you may drop the env vars and configure the same bucket in the UI.

Environment variables (override only):

| Variable | Default | |
|---|---|---|
| `QATLAS_STORAGE` | unset (= Admin → Storage) | `local` or `s3`: pins the backend, UI read-only |
| `QATLAS_S3_ENDPOINT` | — | scheme + host, no path: `https://garage.kalfian.work`, `http://garage:3900` |
| `QATLAS_S3_REGION` | `us-east-1` | Garage: the `s3_region` of its `garage.toml` (usually `garage`) |
| `QATLAS_S3_BUCKET` | — | must exist |
| `QATLAS_S3_ACCESS_KEY`, `QATLAS_S3_SECRET_KEY` | — | key with read + write on the bucket (the secret is never logged) |
| `QATLAS_S3_FORCE_PATH_STYLE` | `true` | path-style URLs (Garage, MinIO); `false` for AWS virtual-host style |
| `QATLAS_S3_PREFIX` | empty | optional key prefix when the bucket is shared |

The same fields exist in Admin → Storage.

### External Garage (e.g. `https://garage.kalfian.work`)

1. Garage WebUI → **Buckets** → create the bucket (e.g. `qatlas`).
2. Garage WebUI → **Keys** → create a key (e.g. `qatlas-app`) and copy its **Access Key ID**
   (`GK…`) and **Secret Key** (revealed on the key's page). CLI equivalent on the Garage host:
   `garage key create qatlas-app` and `garage key info --secret-key qatlas-app`.
3. Give the key **read** and **write** on the bucket (WebUI: the bucket's permissions / allow
   key; CLI: `garage bucket allow --read --write qatlas --key qatlas-app`). Owner is not needed.
4. Admin → Storage → S3: endpoint `https://garage.kalfian.work`, region `garage`, bucket
   `qatlas`, the access key ID and secret → *Test* → *Save*. (Or pin it via the environment
   in `/etc/qatlas/qatlas.env` (B) / `deploy/.env` (A) and restart:)

   ```sh
   QATLAS_STORAGE=s3
   QATLAS_S3_ENDPOINT=https://garage.kalfian.work
   QATLAS_S3_REGION=garage
   QATLAS_S3_BUCKET=qatlas
   QATLAS_S3_ACCESS_KEY=GK…
   QATLAS_S3_SECRET_KEY=…
   ```

5. Move existing files with Admin → Storage → *Migrate* (or the CLI below) and check
   `curl -fsS http://127.0.0.1:8090/readyz`.

### Bundled Garage (docker-compose, profile `s3`)

`deploy/docker-compose.yml` has an optional single-node `garage` service (`dxflrs/garage:v2.5.0`,
config [`deploy/garage/garage.toml`](garage/garage.toml), volumes `garage-meta` and
`${GARAGE_DATA:-garage-data}`, not published on the host — add
`ports: ["127.0.0.1:3900:3900", "127.0.0.1:3903:3903"]` in an override for host access).

```sh
echo "GARAGE_RPC_SECRET=$(openssl rand -hex 32)" >> deploy/.env
docker compose -f deploy/docker-compose.yml --profile s3 up -d garage
deploy/garage/init.sh          # layout, bucket "qatlas", key "qatlas-app"; prints the values
docker compose -f deploy/docker-compose.yml --profile s3 up -d
# Admin → Storage → S3: endpoint http://garage:3900, region garage, bucket/key from init.sh
# (or paste the printed QATLAS_S3_* lines into deploy/.env as an environment override)
```

`init.sh` is idempotent (`deploy/garage/init.sh <bucket> <key-name>`, `GARAGE_CAPACITY=100G`);
the secret key is printed only when the key is created (later: `docker compose -f
deploy/docker-compose.yml exec garage /garage key info --secret-key qatlas-app`). Keep the
`--profile s3` flag on every `up`, otherwise compose leaves Garage stopped: with the env
override server/worker fail their storage check (they restart until it is back); with UI
settings they fall back to local storage for new artifacts and show a warning.

### Moving existing artifacts (`qatlas artifacts migrate`)

Admin → Storage → *Migrate* is the usual way. The CLI does the same in the foreground (useful
for scripts and very large stores):

```sh
qatlas artifacts migrate --from local --to s3 --dry-run    # list what would be copied
qatlas artifacts migrate --from local --to s3              # copy + switch each row; [n/total] per file + a summary
qatlas artifacts check                                     # every non-expired artifact present in the store of its backend?
qatlas artifacts migrate --from local --to s3 --delete-local   # optional: also remove the local copies
```

With docker-compose run them as `docker compose -f deploy/docker-compose.yml exec server qatlas
artifacts …` (the server container has the artifacts volume); with systemd as `sudo qatlas
artifacts …`. S3 settings come from `QATLAS_S3_*` when complete, otherwise from Admin → Storage
(needs `QATLAS_MASTER_KEY`). The command reads the non-purged `artifacts` rows stored on
`--from` (orphan files without a row are not copied), uploads with the stored content type,
verifies the size and then points the row at `--to`, so downloads keep working throughout.
Where *new* artifacts go is not changed (Admin → Storage or `QATLAS_STORAGE`). Local files are
kept unless `--delete-local` (which also cleans up sources left by an earlier run).
`--from s3 --to local` works for a rollback. Exit status 1 when an object failed (`migrate`) or
is missing / has the wrong size / sits on an unconfigured backend (`check`; `--store local|s3`
checks only the artifacts on that backend).

---

## Google sign-in

Configure it from **Admin → Google sign-in** (admins, signed-in session); the env vars are an
optional override.

1. Google Cloud Console → *APIs & Services → Credentials → Create credentials → OAuth client
   ID*, type **Web application** (a *Desktop app* client is rejected).
2. Add the **Authorized redirect URI** `https://qatlas.example.com/api/v1/auth/google/callback`
   and the **Authorized JavaScript origin** `https://qatlas.example.com` — both are shown on the
   admin page, derived from `QATLAS_BASE_URL`, which must be https (Google allows http only for
   localhost).
3. Download the client JSON (Google includes `client_secret` only when the client or a new
   secret is created) and upload it on the admin page, switch sign-in on, optionally restrict
   the email domains → *Save*. It applies at once on every server process, no restart.

The page warns when the uploaded JSON does not list the redirect URI or the base URL is not
https. The client secret is encrypted with `QATLAS_MASTER_KEY` (`system_settings` key
`google_auth`), never returned or logged; the audit log (`settings.google_auth.update|delete`)
records the client ID and the changed fields. Only invited/registered users can sign in.

**Env override:** `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (+ optional
`GOOGLE_ALLOWED_DOMAINS`) set on the server win over the database settings: the page is
read-only and saving answers 409 `env_override`. Remove them and restart to manage Google
sign-in from the UI.

---

## Reverse proxy and TLS

`qatlas server` speaks plain HTTP on 8090; terminate TLS in the existing proxy. Set
`QATLAS_BASE_URL=https://qatlas.example.com` (Secure cookies, invite links, Google redirect
`https://qatlas.example.com/api/v1/auth/google/callback`) and `QATLAS_TRUST_PROXY=true` only
when the proxy **overwrites** `X-Real-IP` / `X-Forwarded-For` (login rate limiting uses them).
Bind the app to `127.0.0.1` (`QATLAS_BIND_ADDR`, or `QATLAS_HTTP_ADDR=127.0.0.1:8090`) when the
proxy runs on the same CT.

Run progress uses **Server-Sent Events** (`GET /api/v1/runs/{key}/events`, 15 s heartbeat):
the proxy must not buffer it and must allow long-lived responses.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name qatlas.example.com;
    # ssl_certificate …;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;   # overwrite, do not append
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location ~ ^/api/v1/runs/[^/]+/events$ {
        proxy_pass http://127.0.0.1:8090;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 1h;
    }
}
```

Caddy streams `text/event-stream` without buffering by default:

```caddy
qatlas.example.com {
    reverse_proxy 127.0.0.1:8090
}
```

---

## Backups

What to keep — and what is useless without the rest:

| Item | How |
|---|---|
| Database | `pg_dump -Fc` (schedule it) + Proxmox CT backup/snapshot |
| `QATLAS_MASTER_KEY` | password manager, separately from the dumps. Without it environment secrets cannot be decrypted. |
| Config | `deploy/.env` (A) or `/etc/qatlas/qatlas.env` (B) |
| Artifacts | the artifacts volume / mount point (screenshots, videos; optional — subject to retention); with `QATLAS_STORAGE=s3` the Garage data instead (CT backup of the Garage host, or the `garage-meta` + `garage-data` volumes) |

```sh
# A. docker-compose
docker compose -f deploy/docker-compose.yml exec -T postgres pg_dump -U qatlas -Fc qatlas > qatlas-$(date +%F).dump
docker run --rm -v qatlas_artifacts:/a:ro -v "$PWD":/b alpine tar -czf /b/artifacts-$(date +%F).tgz -C /a .
#    restore: docker compose … exec -T postgres pg_restore -U qatlas -d qatlas --clean --if-exists < qatlas-….dump

# B. systemd
sudo -u postgres pg_dump -Fc qatlas > /var/backups/qatlas-$(date +%F).dump
tar -czf /var/backups/qatlas-artifacts-$(date +%F).tgz -C /var/lib/qatlas .
#    restore: systemctl stop qatlas-server qatlas-worker;
#             sudo -u postgres pg_restore -d qatlas --clean --if-exists qatlas-….dump; start again
```

Cron example (B): `15 2 * * * postgres pg_dump -Fc qatlas > /var/backups/qatlas-$(date +\%u).dump`
in `/etc/cron.d/qatlas-backup` (7 rotating dumps).

---

## Verification

```sh
# A
docker compose -f deploy/docker-compose.yml ps                 # server healthy, migrate Exited (0)
docker compose -f deploy/docker-compose.yml logs migrate worker | tail -n 30   # "runner ready" from the worker
curl -fsS http://127.0.0.1:8090/healthz && curl -fsS http://127.0.0.1:8090/readyz
curl -fsS http://127.0.0.1:8090/ | grep -q '<title>QAtlas</title>' && echo SPA ok
docker compose -f deploy/docker-compose.yml exec -T -w /opt/qatlas/runner worker \
  node --input-type=module -e 'import {chromium} from "playwright"; const b = await chromium.launch(); console.log("chromium", b.version()); await b.close()'

# B
systemctl status qatlas-server qatlas-worker          # or qatlas
journalctl -u qatlas-worker -n 50                     # "runner ready"
curl -fsS http://127.0.0.1:8090/healthz && curl -fsS http://127.0.0.1:8090/readyz
sudo qatlas migrate status
sudo -u qatlas env HOME=/var/lib/qatlas PLAYWRIGHT_BROWSERS_PATH=/opt/qatlas/ms-playwright \
  node /opt/qatlas/current/runner/dist/main.js </dev/null   # prints {"type":"ready","playwright":"1.64.1"} and exits
```

Then sign in at `QATLAS_BASE_URL`, create a project and environment, and run one UI test case
against a reachable app (or the demo target) — this is the real check that Chromium works in
the CT (sandbox, `/dev/shm`) and tells you the RAM per parallel run for `WORKER_CONCURRENCY`.

## Make targets (repository root)

| Target | Does |
|---|---|
| `make dev-db` | Postgres for development on `127.0.0.1:55432` (`deploy/docker-compose.dev.yml`) |
| `make build` | `dist/web` (SPA, `VITE_API_MODE=real`), `runner/dist`, `dist/qatlas` |
| `make test` | `go vet` + `go test ./...`, web vitest, runner integration tests |
| `make docker` | `qatlas-server:$(VERSION)`, `qatlas-worker:$(VERSION)` (`IMAGE_PREFIX=` for a registry) |
| `make release` | `dist/qatlas-$(VERSION)-linux-$(GOARCH).tar.gz` + `.sha256` |

`VERSION` defaults to `git describe --tags --always --dirty`.
