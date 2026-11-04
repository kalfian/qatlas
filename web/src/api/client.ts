import createClient from 'openapi-fetch'
import type { paths } from './schema'
import type { ApiErrorBody, FieldError } from './types'

export const API_BASE = '/api/v1'

// `fetch` di-resolve saat dipanggil (bukan saat modul dimuat) agar mock fetch-patch ikut terpakai
export const api = createClient<paths>({ baseUrl: API_BASE, fetch: (request) => globalThis.fetch(request) })

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: FieldError[]

  constructor(status: number, body: Partial<ApiErrorBody> | undefined) {
    super(body?.error?.message ?? `Request gagal (${status})`)
    this.name = 'ApiError'
    this.status = status
    this.code = body?.error?.code ?? 'unknown'
    this.details = body?.error?.details ?? []
  }
}

interface FetchResult<T> {
  data?: T
  error?: unknown
  response: Response
}

/** Mengembalikan `data` atau melempar ApiError. Untuk 204, mengembalikan undefined as T. */
export async function unwrap<T>(promise: Promise<FetchResult<T>>): Promise<T> {
  const { data, error, response } = await promise
  if (error !== undefined || !response.ok) {
    throw new ApiError(response.status, error as Partial<ApiErrorBody> | undefined)
  }
  return data as T
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Terjadi kesalahan yang tidak diketahui'
}
