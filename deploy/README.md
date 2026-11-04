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
`GET /readyz` (database reachable).

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

Demo target app ("Tokoku", port 8099, published on 127.0.0.1 only):

```sh
docker compose -f deploy/docker-compose.yml --profile demo up -d --build
docker compose -f deploy/docker-compose.yml exec server \
  qatlas seed demo --target-url http://demo-target:8099 --admin-token adm_stg_8f3a
```

`qatlas seed demo` creates the demo users (`rina@tokoku.id` admin, `dimas@`/`sari@` with
`--password`, default `password123`; `budi@` stays invited and gets a printed invite link) and the
projects SHOP/PAY with environments, folders, test cases and flows. Existing projects are skipped
(`--reset` recreates them, deleting their runs); `--runs` enqueues a few demo runs for the worker.
`--admin-token` must match the demo target's `DEMO_ADMIN_TOKEN` (default `adm_stg_8f3a`) for
SHOP-T17; without it the secret is random. `qatlas seed demo --help` lists every flag.

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
| Artifacts | the artifacts volume / mount point (screenshots, videos; optional — subject to retention) |

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
