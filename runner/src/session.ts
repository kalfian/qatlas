import { devices, request, type APIRequestContext, type BrowserContext, type BrowserContextOptions, type Page } from 'playwright'
import type { BrowserPool } from './browsers.js'
import { CancelledError, InfraError, cleanPlaywrightMessage } from './errors.js'
import { log } from './log.js'
import type { RunOptions } from './protocol.js'

export interface SessionInit {
  pool: BrowserPool
  options: RunOptions
  /** True when the case/segment has at least one UI step: the browser context is created up front
   *  (on the first step) so HTTP steps share its cookies via context.request. */
  needsBrowser: boolean
  /** Directory for Playwright's recordVideo, or null when video is off. */
  videoDir: string | null
  baseURL?: string
  signal: AbortSignal
}

/**
 * BrowserContext options for a run segment. With `options.device` the context emulates the device
 * (docs/14): DPR, touch, isMobile (not on Firefox, which Playwright does not support there) and the
 * user agent of the installed Playwright descriptor when it exists (otherwise no UA override).
 * Without a device the options are exactly the pre-device ones. The video size is the viewport.
 */
export function contextOptions(options: RunOptions, baseURL: string | undefined, videoDir: string | null): BrowserContextOptions {
  const base: BrowserContextOptions = {
    viewport: options.viewport,
    baseURL,
    acceptDownloads: false,
    ...(videoDir ? { recordVideo: { dir: videoDir, size: options.viewport } } : {}),
  }
  const device = options.device
  if (!device) return base
  const userAgent = device.playwright ? devices[device.playwright]?.userAgent : undefined
  return {
    ...base,
    deviceScaleFactor: device.device_scale_factor,
    hasTouch: device.has_touch,
    ...(options.browser === 'firefox' ? {} : { isMobile: device.is_mobile }),
    ...(userAgent ? { userAgent } : {}),
  }
}

/**
 * Execution resources of one case (or one shared-session segment): at most one BrowserContext with
 * one Page, and/or a standalone APIRequestContext when no browser is needed.
 */
export class Session {
  private context: BrowserContext | null = null
  private pageRef: Page | null = null
  private ownApi: APIRequestContext | null = null
  private creating: Promise<void> | null = null
  private closed = false
  private closing: Promise<string | null> | null = null
  private videoPath: string | null = null

  constructor(private readonly init: SessionInit) {}

  get hasPage(): boolean {
    return this.pageRef !== null && !this.pageRef.isClosed()
  }

  /** Create the browser context if this session needs one. Errors → InfraError (status "error"). */
  async ensure(): Promise<void> {
    if (!this.init.needsBrowser || this.context || this.closed) return
    this.creating ??= this.createContext()
    await this.creating
  }

  private async createContext(): Promise<void> {
    const { pool, options, videoDir, baseURL, signal } = this.init
    if (signal.aborted) throw new CancelledError()
    const browser = await pool.get(options.browser, options.headless)
    if (signal.aborted) throw new CancelledError()
    let context: BrowserContext | null = null
    try {
      context = await browser.newContext(contextOptions(options, baseURL, videoDir))
      context.setDefaultTimeout(options.step_timeout_ms)
      context.setDefaultNavigationTimeout(options.step_timeout_ms)
      const page = await context.newPage()
      this.videoPath = videoDir ? ((await page.video()?.path()) ?? null) : null
      this.context = context
      this.pageRef = page
    } catch (err) {
      await context?.close().catch(() => {})
      if (signal.aborted) throw new CancelledError()
      throw new InfraError(`Could not create browser context: ${cleanPlaywrightMessage(err)}`, { cause: err })
    }
    if (signal.aborted || this.closed) {
      await this.context?.close().catch(() => {})
      throw new CancelledError()
    }
  }

  async page(): Promise<Page> {
    if (this.init.signal.aborted || this.closed) throw new CancelledError()
    await this.ensure()
    if (!this.pageRef) throw new InfraError('No browser page available for a UI step')
    if (this.pageRef.isClosed()) {
      if (this.init.signal.aborted) throw new CancelledError()
      throw new InfraError('The browser page was closed unexpectedly (crash or window.close())')
    }
    return this.pageRef
  }

  /** APIRequestContext for HTTP steps: the browser context's (shared cookies) or a standalone one. */
  async api(): Promise<APIRequestContext> {
    await this.ensure()
    if (this.context) return this.context.request
    if (this.closed || this.init.signal.aborted) throw new CancelledError()
    this.ownApi ??= await request.newContext({ baseURL: this.init.baseURL })
    return this.ownApi
  }

  /**
   * Close everything; returns the recorded video's path (the file is complete once this resolves).
   * Idempotent: later calls await the same close (cancel closes first, the case loop closes again).
   */
  close(): Promise<string | null> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<string | null> {
    this.closed = true
    // A context still being created is closed by createContext() itself once it exists, so a
    // cancel never waits for a slow browser launch.
    if (this.creating && !this.context) return null
    const tasks: Promise<unknown>[] = []
    if (this.context) tasks.push(this.context.close())
    if (this.ownApi) tasks.push(this.ownApi.dispose())
    const results = await Promise.allSettled(tasks)
    for (const r of results) if (r.status === 'rejected') log.warn('session close failed', { error: String(r.reason) })
    return this.context ? this.videoPath : null
  }
}
