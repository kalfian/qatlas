import { getResponse } from 'msw'
import { setupWorker } from 'msw/browser'
import './history'
import { db } from './db'
import { handlers } from './handlers'
import { startSimulator } from './simulator'

/**
 * Menyalakan mock API.
 * - Secure context (https / localhost): MSW service worker (request terlihat di tab Network).
 * - Non-secure (mis. http://<IP>:5173 untuk review lewat jaringan): service worker tidak tersedia,
 *   jadi `window.fetch` dibungkus dan request /api/* di-resolve langsung oleh handler MSW yang sama.
 */
export async function startMockApi() {
  db() // inisialisasi / seed
  let mode: 'service-worker' | 'fetch-patch' = 'fetch-patch'
  if (window.isSecureContext && 'serviceWorker' in navigator) {
    try {
      await setupWorker(...handlers).start({
        onUnhandledRequest: (req, print) => {
          if (new URL(req.url).pathname.startsWith('/api/')) print.warning()
        },
        quiet: true,
      })
      mode = 'service-worker'
    } catch (err) {
      console.warn('[mock] service worker gagal, fallback ke fetch-patch', err)
    }
  }
  if (mode === 'fetch-patch') installFetchInterceptor()
  console.info(`[mock] API mock aktif (${mode})`)
  startSimulator()
}

function installFetchInterceptor() {
  const original = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const url = new URL(request.url, location.href)
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return original(input, init)
    const response = await getResponse(handlers, request)
    if (response) return response
    return new Response(JSON.stringify({ error: { code: 'not_found', message: `Mock handler tidak ada untuk ${request.method} ${url.pathname}` } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })
  }
}
