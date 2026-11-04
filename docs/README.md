# QAtlas — Planning Docs

QAtlas adalah platform self-hosted untuk **mengelola test case**, **menyusun flow** (rangkaian test case), **menjalankan automation test secara async**, melihat **report** (pass/fail + screenshot/video), dan menyediakan **MCP server** agar AI bisa membuat, menjalankan, dan membaca hasil test.

> Status: **draft planning v0** (2026-11-04). Belum ada kode. Semua keputusan di sini masih bisa direvisi — lihat [11-open-questions.md](11-open-questions.md).

## Daftar dokumen

| # | Dokumen | Isi |
|---|---------|-----|
| 01 | [Overview](01-overview.md) | Tujuan, scope, persona, glossary |
| 02 | [Architecture](02-architecture.md) | Komponen, tech stack, model async, struktur repo |
| 03 | [Domain Model](03-domain-model.md) | Entitas & draft skema database |
| 04 | [Test Definition (Step DSL)](04-test-definition.md) | Format test case, action, variable, flow |
| 05 | [Auth & Access](05-auth-and-access.md) | Login email/password, Google, RBAC, API token |
| 06 | [Runner & Reporting](06-runner.md) | Eksekusi async, artifact screenshot/video, live progress |
| 07 | [MCP Server](07-mcp.md) | Tools untuk AI: buat test case → run → baca hasil |
| 08 | [REST API](08-api.md) | Outline endpoint (contract-first, OpenAPI) |
| 09 | [Frontend](09-frontend.md) | Stack FE, halaman, user journey |
| 10 | [Roadmap & Phases](10-roadmap.md) | Phase 1 (FE end-to-end dengan mock) s/d phase 5 |
| 11 | [Open Questions](11-open-questions.md) | Keputusan yang butuh konfirmasi + log keputusan |
| 12 | [Deployment](12-deployment.md) | Proxmox LXC: docker-compose & manual (systemd) |

## Ringkasan keputusan utama

| Area | Keputusan | Alasan singkat |
|------|-----------|----------------|
| Backend | **Go** — satu binary, mode `server` / `worker` / `all` | Async dengan goroutine, hemat resource, deploy mudah |
| Database | **PostgreSQL** + `pgx` + `sqlc` + `goose` | Relasional, JSONB untuk steps, juga jadi job queue |
| Job queue | **River** (queue berbasis Postgres) | Tidak perlu Redis; enqueue transaksional bersama insert run |
| Test engine | **Playwright resmi (Node)** sebagai *runner* yang dikendalikan worker Go via NDJSON stdin/stdout | Engine resmi & paling matang; screenshot, video, auto-wait native. Go tetap mengatur antrean, concurrency, DB, artifact |
| API testing | Playwright `APIRequestContext` (di runner yang sama) | Satu engine untuk UI & API; test API-only tidak launch browser |
| Format test case | **Step terstruktur (DSL JSON)**, diedit di UI, diterjemahkan runner ke API Playwright | Bisa dikelola non-coder & divalidasi untuk AI |
| Live progress | Postgres `LISTEN/NOTIFY` → **SSE** ke FE | Sederhana, tanpa broker tambahan |
| Artifact storage | Interface: **local filesystem** atau **S3-compatible** (MinIO) | Mulai simpel, bisa scale |
| Frontend | **React + Vite + TypeScript**, TanStack Router/Query, Tailwind + shadcn/ui | SPA cepat, ekosistem matang |
| Kontrak API | **OpenAPI** sebagai source of truth (`api/openapi.yaml`) | FE mock (phase 1) dan BE (phase 2) memakai kontrak yang sama |
| Mock phase 1 | **MSW** + mock DB in-memory/localStorage | FE bisa end-to-end penuh tanpa backend |
| Auth | Email+password (argon2id) + Google OIDC **hanya untuk user terdaftar**; session cookie; API token untuk MCP/CI | Sesuai requirement, aman by default |
| Test manual | Per test case (`execution: manual`) hanya bila perlu; dikerjakan tester di UI, bisa dicampur dalam flow | Skenario yang tidak bisa diotomasi tetap tercatat & ter-report |
| Tenancy | Satu instance = satu organisasi | Sederhana |
| Deploy | Proxmox LXC — docker-compose atau manual (binary + systemd) | Sesuai infra yang ada |
| MCP | Official Go SDK (`modelcontextprotocol/go-sdk`), Streamable HTTP di `/mcp`, auth Bearer API token | Native di binary yang sama |

## Phase singkat

1. **Phase 1 — Frontend end-to-end (mock)**: semua user journey bisa diklik dari login sampai report, data dari MSW. Tujuannya memvalidasi flow & UX.
2. **Phase 2 — Backend core**: auth, user, project, test case, flow, environment — FE pindah dari mock ke API asli.
3. **Phase 3 — Runner**: queue, worker Go, runner Node + Playwright resmi, artifact, SSE live progress, report.
4. **Phase 4 — MCP & API token**: AI bisa end-to-end (buat test → run → baca hasil).
5. **Phase 5 — Hardening & extras**: schedule, CI trigger, JUnit export, retention, observability, deployment.

Detail ada di [10-roadmap.md](10-roadmap.md).
