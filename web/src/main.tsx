import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles/globals.css'
import { i18nReady } from './i18n'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ApiError } from './api/client'
import { IS_MOCK } from './app/config'
import { createAppRouter } from './app/router'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
    },
  },
})

const router = createAppRouter(queryClient)

async function bootstrap() {
  // Bahasa awal non-English (chunk terpisah) dimuat paralel dengan mock API; render setelah keduanya siap.
  const mock = IS_MOCK ? import('./mocks/browser').then(({ startMockApi }) => startMockApi()) : undefined
  await Promise.all([i18nReady, mock])
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </StrictMode>,
  )
}

bootstrap()
