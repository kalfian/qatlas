import { chromium, firefox, webkit, type Browser, type BrowserType } from 'playwright'
import { InfraError, cleanPlaywrightMessage } from './errors.js'
import { log } from './log.js'
import type { BrowserName } from './protocol.js'

const TYPES: Record<BrowserName, BrowserType> = { chromium, firefox, webkit }

/**
 * One shared Browser per (type, headless) pair, launched lazily on first use and re-used across
 * runs. Every case (or shared-session segment) gets its own BrowserContext, so runs stay isolated.
 * A crashed/disconnected browser is forgotten and relaunched on the next request.
 */
export class BrowserPool {
  private readonly browsers = new Map<string, Promise<Browser>>()
  private closing = false

  /** Number of browser launches performed (exposed for diagnostics/tests). */
  launches = 0

  async get(name: BrowserName, headless: boolean): Promise<Browser> {
    if (this.closing) throw new InfraError('Runner is shutting down')
    const type = TYPES[name]
    if (!type) throw new InfraError(`Unsupported browser "${String(name)}" (expected chromium, firefox or webkit)`)
    const key = `${name}:${headless ? 'headless' : 'headed'}`
    let pending = this.browsers.get(key)
    if (!pending) {
      this.launches += 1
      log.info('launching browser', { browser: name, headless })
      pending = type.launch({ headless, timeout: 60_000 }).then(
        (browser) => {
          browser.on('disconnected', () => {
            if (this.browsers.get(key) === pending) this.browsers.delete(key)
            if (!this.closing) log.warn('browser disconnected', { browser: name })
          })
          log.info('browser ready', { browser: name, version: browser.version() })
          return browser
        },
        (err: unknown) => {
          this.browsers.delete(key)
          throw new InfraError(`Browser ${name} failed to launch: ${cleanPlaywrightMessage(err)}`, { cause: err })
        },
      )
      this.browsers.set(key, pending)
    }
    return pending
  }

  async closeAll(): Promise<void> {
    this.closing = true
    const all = [...this.browsers.values()]
    this.browsers.clear()
    await Promise.allSettled(all.map(async (p) => (await p).close()))
  }
}
