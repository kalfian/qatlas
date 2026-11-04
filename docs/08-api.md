# 08 — REST API (outline)

Contract-first: definisi lengkap ditulis di `api/openapi.yaml` pada **Phase 1** (dipakai MSW), diimplementasi BE di Phase 2–4. Dokumen ini hanya outline.

## Konvensi

- Base path: `/api/v1`. JSON. Waktu ISO-8601 UTC.
- Project dirujuk dengan `key` (`SHOP`), test case/flow/run dengan key tampil (`SHOP-T12`, `SHOP-F3`, `SHOP-R105`) atau UUID.
- Pagination cursor: `?limit=50&cursor=...` → `{ "data": [...], "next_cursor": "..." }`.
- Error: `{ "error": { "code": "validation_failed", "message": "...", "details": [{ "path": "steps[3].selector", "message": "required" }] } }`.
- Optimistic concurrency untuk update test case/flow: kirim `revision`; konflik → `409`.
- Aksi non-CRUD memakai sub-path (`/runs/{key}/cancel`), **bukan** gaya `:cancel` — tanda titik dua bentrok dengan pola parameter path di router Go (chi) dan MSW.
- Spesifikasi lengkap: [`api/openapi.yaml`](../api/openapi.yaml) (v0, dipakai mock Phase 1).
- Auth: cookie session (web) atau `Authorization: Bearer` (token).

## Endpoint

### Auth
| Method | Path | Ket |
|--------|------|-----|
| POST | `/auth/login` | email + password |
| POST | `/auth/logout` | |
| GET | `/auth/google/start` | redirect ke Google |
| GET | `/auth/google/callback` | |
| GET | `/auth/invites/{token}` | info invite (email, nama) |
| POST | `/auth/invites/{token}/accept` | set password |
| GET | `/me` | user + system role + daftar project & role |
| PATCH | `/me` | nama, ganti password |

### Admin
| Method | Path |
|--------|------|
| GET / POST | `/admin/users` |
| PATCH | `/admin/users/{id}` (role, status) |
| POST | `/admin/users/{id}/invite-link` (generate ulang / reset password link) |
| POST | `/admin/users/{id}/revoke-sessions` |

### API tokens
| Method | Path |
|--------|------|
| GET / POST | `/me/tokens` |
| DELETE | `/me/tokens/{id}` |

### Projects, member, environment
| Method | Path |
|--------|------|
| GET / POST | `/projects` |
| GET / PATCH | `/projects/{key}` ; POST `/projects/{key}/archive` |
| GET / POST | `/projects/{key}/members` ; PATCH / DELETE `/projects/{key}/members/{userId}` |
| GET | `/projects/{key}/assignable-users` (calon member) |
| GET / POST | `/projects/{key}/environments` ; PATCH / DELETE `/projects/{key}/environments/{id}` |
| PUT | `/projects/{key}/environments/{id}/secrets/{name}` (write-only) ; DELETE idem |

### Folder & test case
| Method | Path |
|--------|------|
| GET / POST | `/projects/{key}/folders` ; PATCH / DELETE `/projects/{key}/folders/{id}` |
| GET | `/projects/{key}/test-cases?folder=&tags=&status=&q=&last_run_status=` |
| POST | `/projects/{key}/test-cases` |
| POST | `/projects/{key}/test-cases/validate` |
| GET / PATCH / DELETE | `/test-cases/{caseKey}` |
| POST | `/test-cases/{caseKey}/duplicate` |
| GET | `/test-cases/{caseKey}/revisions` ; GET `/test-cases/{caseKey}/revisions/{rev}` |
| POST | `/projects/{key}/test-cases/bulk` (pindah folder, ubah tag/status, hapus massal) |
| GET | `/projects/{key}/tags` |

### Flow
| Method | Path |
|--------|------|
| GET / POST | `/projects/{key}/flows` |
| GET / PATCH / DELETE | `/flows/{flowKey}` |

### Run
| Method | Path | Ket |
|--------|------|-----|
| POST | `/projects/{key}/runs` | `{ "test_case": "SHOP-T12" \| "flow": "SHOP-F3", "environment_id": "…", "options": {...}, "assignee_id"?: "…" }` → `202` |
| GET | `/projects/{key}/runs?status=&target=&trigger=&from=&to=` | |
| GET | `/runs/{runKey}` | detail + case + step |
| GET | `/runs/{runKey}/events` | SSE |
| POST | `/runs/{runKey}/cancel` | |
| POST | `/runs/{runKey}/rerun` | `{ "only_failed": bool }` |
| PATCH | `/runs/{runKey}/assignee` | ganti tester (maintainer) |
| PUT | `/runs/{runKey}/cases/{caseId}/steps/{stepId}/manual-result` | `{ status, actual_result }` — hanya assignee, hanya case manual |
| POST | `/runs/{runKey}/cases/{caseId}/attachments` | upload file (multipart), batas ukuran per file |
| POST | `/runs/{runKey}/cases/{caseId}/complete-manual` | hitung status case → lanjutkan flow bila ada |
| GET | `/me/manual-runs` | daftar run manual yang ditugaskan ke saya |
| GET | `/artifacts/{id}` | file (Range) / redirect presigned |

### Dashboard
| Method | Path |
|--------|------|
| GET | `/projects/{key}/stats?range=7d` (pass rate, jumlah run, test paling sering gagal, durasi rata-rata) |

### Lainnya
- `GET /healthz`, `GET /readyz`, (phase 5) `GET /metrics`.
- `GET /api/v1/schema/steps` — JSON Schema step DSL.
