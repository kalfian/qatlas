# QAtlas

Platform self-hosted untuk mengelola test case per project, menyusun flow, menjalankan automation test (Playwright) secara async, melihat report (screenshot/video), test manual bila perlu, dan MCP server untuk AI.

- Planning & keputusan: [`docs/`](docs/README.md) — mulai dari [`docs/README.md`](docs/README.md) dan [`docs/10-roadmap.md`](docs/10-roadmap.md).
- Arahan desain UI: [`docs/design/ui-direction.md`](docs/design/ui-direction.md).
- Kontrak API (source of truth FE & BE): [`api/openapi.yaml`](api/openapi.yaml).

## Status

**Phase 1 — Frontend end-to-end (mock).** Semua data berasal dari mock API di browser (MSW + simulator run), disimpan di `localStorage`. Belum ada backend.

## Menjalankan (dev)

Butuh Node ≥ 22 dan pnpm 10 (via corepack).

```bash
corepack enable          # atau: corepack pnpm <cmd>
pnpm install
pnpm dev                 # http://localhost:5173 (juga listen di 0.0.0.0)
```

Login demo (mode mock): `rina@tokoku.id` / `password123` (admin). User lain: `dimas@tokoku.id` (editor SHOP), `sari@tokoku.id` (viewer SHOP), password sama. Tombol **Mock** di kiri bawah: ganti user, atur kecepatan simulasi, reset data demo.

Akses lewat IP (`http://<ip>:5173`) didukung: karena bukan secure context, mock memakai mode *fetch-patch* alih-alih service worker (otomatis).

## Perintah

| Perintah | Fungsi |
|----------|--------|
| `pnpm dev` | Dev server Vite (HMR) |
| `pnpm build` | Typecheck + build produksi ke `web/dist` |
| `pnpm lint` | ESLint |
| `pnpm typecheck` | TypeScript |
| `pnpm test` | Unit test (Vitest) |
| `pnpm e2e` | E2E Playwright untuk journey Phase 1 |
| `pnpm api:types` | Generate `web/src/api/schema.d.ts` dari `api/openapi.yaml` |

## Struktur

```
api/openapi.yaml     kontrak API v0
docs/                planning, keputusan, desain
web/                 React + Vite + TS (Phase 1)
  src/api/           client & hooks TanStack Query (typed dari OpenAPI)
  src/app/           router, shell, auth/permission hooks
  src/components/    UI primitives (shadcn-style) & komponen bersama
  src/features/      halaman per fitur
  src/lib/           katalog Step DSL, validasi, RBAC, format
  src/mocks/         MSW handlers, seed, simulator run (Phase 1)
  e2e/               Playwright journey tests
```
