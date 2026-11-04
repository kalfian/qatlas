/// <reference types="vitest/config" />
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin } from 'vite'

/**
 * Vendor chunk yang stabil antar-deploy (kode app berubah, hash vendor tidak). Hanya library yang SELALU
 * dimuat di awal; library khusus halaman (CodeMirror, dnd-kit, date-fns, cmdk) tetap ikut chunk lazy-nya.
 * Radix sengaja tidak digabung: satu chunk `radix` (143 kB) ikut dimuat di awal karena TooltipProvider ada di
 * root, menambah +17 kB gzip di login dan +5 kB di dashboard (diukur 2026-11-04). Rollup sudah memecahnya per
 * fitur. `experimentalMinChunkSize` menggabung chunk kecil (ikon, util) bila tidak menambah kode yang dieksekusi
 * entry mana pun: dashboard 42 → 36 request.
 */
const VENDOR_CHUNKS: [chunk: string, packages: RegExp][] = [
  ['react', /^(react|react-dom|scheduler)$/],
  ['router', /^@tanstack\/(react-router|router-core|history|store|react-store)$|^(tiny-invariant|tiny-warning|cookie-es|seroval.*)$/],
  ['query', /^@tanstack\/(query-core|react-query)$/],
  ['i18n', /^(i18next|react-i18next|html-parse-stringify|void-elements)$/],
]

function vendorChunk(id: string): string | undefined {
  const at = id.lastIndexOf('/node_modules/')
  if (at === -1) return undefined
  const [scope, name] = id.slice(at + '/node_modules/'.length).split('/')
  const pkg = scope.startsWith('@') ? `${scope}/${name}` : scope
  return VENDOR_CHUNKS.find(([, re]) => re.test(pkg))?.[0]
}

/** Build real mode: buang aset public khusus MSW (service worker + screenshot mock) dari output. */
function stripMockPublicAssets(enabled: boolean): Plugin {
  let outDir = ''
  return {
    name: 'qatlas:strip-mock-public-assets',
    apply: 'build',
    configResolved(c) {
      outDir = resolve(c.root, c.build.outDir)
    },
    closeBundle() {
      if (!enabled) return
      for (const f of ['mockServiceWorker.js', 'mock-artifacts']) rmSync(resolve(outDir, f), { recursive: true, force: true })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  // Mode real (VITE_API_MODE=real): semua /api diteruskan ke backend Go, cookie tetap same-origin.
  const apiTarget = env.QATLAS_API_URL || 'http://127.0.0.1:8090'
  const proxy = env.VITE_API_MODE === 'real' ? { '/api': { target: apiTarget, changeOrigin: false } } : undefined

  return {
    plugins: [react(), tailwindcss(), stripMockPublicAssets(env.VITE_API_MODE === 'real')],
    build: {
      rollupOptions: { output: { manualChunks: vendorChunk, experimentalMinChunkSize: 10_000 } },
    },
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { port: 5173, host: true, proxy },
    preview: { port: 4173, proxy },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./src/test/setup.ts'],
      include: ['src/**/*.test.{ts,tsx}'],
    },
  }
})
