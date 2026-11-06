import { mkdir, rename, rm, rmdir } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { captureScreenshot, executeStep, screenshotFile, type StepContext } from './actions.js'
import type { BrowserPool } from './browsers.js'
import { Masker, emit } from './emitter.js'
import { CancelledError, InfraError, StepFailure } from './errors.js'
import { interpolateStep, stringifyRecord, waitForFreshTotp, type Scope } from './interpolate.js'
import { log } from './log.js'
import {
  ACTION_KIND,
  DEFAULT_OPTIONS,
  type OutboundEvent,
  type RunOptions,
  type RunStartMessage,
  type RunStatus,
  type StepStatus,
  type WireCase,
  type WireStep,
} from './protocol.js'
import { Session } from './session.js'

const MAX_RETRIES = 5

const isFailure = (s: StepStatus) => s === 'failed' || s === 'error'
const hasUiStep = (c: WireCase) => c.steps.some((s) => s.enabled !== false && ACTION_KIND[s.action] === 'ui')

/** Validate a run.start message. Returns an error message, or null when it can be executed. */
export function validateRunStart(msg: RunStartMessage): string | null {
  if (typeof msg.run_id !== 'string' || !msg.run_id) return 'run.start: "run_id" is required'
  if (typeof msg.artifact_dir !== 'string' || !msg.artifact_dir) return 'run.start: "artifact_dir" is required'
  if (!Array.isArray(msg.cases) || msg.cases.length === 0) return 'run.start: "cases" must be a non-empty array'
  const browser = msg.options?.browser
  if (browser !== undefined && !['chromium', 'firefox', 'webkit'].includes(browser)) {
    return `run.start: unsupported browser "${String(browser)}"`
  }
  const deviceError = validateDevice(msg.options?.device)
  if (deviceError) return deviceError
  for (const [ci, c] of msg.cases.entries()) {
    if (!c || typeof c.case_id !== 'string' || !c.case_id) return `run.start: cases[${ci}].case_id is required`
    if (!Array.isArray(c.steps)) return `run.start: cases[${ci}].steps must be an array`
    for (const [si, s] of c.steps.entries()) {
      if (!s || typeof s.step_id !== 'string' || !s.step_id) return `run.start: cases[${ci}].steps[${si}].step_id is required`
      if (s.action === 'manual') {
        return `run.start: case ${c.case_id} contains a manual step (${s.step_id}); manual cases must never be sent to the runner`
      }
      if (!(s.action in ACTION_KIND)) return `run.start: case ${c.case_id} step ${s.step_id} has unknown action "${String(s.action)}"`
    }
  }
  return null
}

const positiveNumber = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v > 0

/** `options.device` is optional; when present the context is built from it, so its numbers must be sane. */
function validateDevice(device: unknown): string | null {
  if (device === undefined || device === null) return null
  if (typeof device !== 'object' || Array.isArray(device)) return 'run.start: options.device must be an object'
  const d = device as Record<string, unknown>
  for (const key of ['width', 'height'] as const) {
    if (!positiveNumber(d[key]) || !Number.isInteger(d[key])) return `run.start: options.device.${key} must be a positive integer`
  }
  if (!positiveNumber(d.device_scale_factor)) return 'run.start: options.device.device_scale_factor must be a positive number'
  if (d.playwright !== undefined && d.playwright !== null && typeof d.playwright !== 'string') {
    return 'run.start: options.device.playwright must be a string or null'
  }
  return null
}

function mergeOptions(o: Partial<RunOptions> | undefined): RunOptions {
  const opts = { ...DEFAULT_OPTIONS, ...(o ?? {}) }
  const device = o?.device ?? undefined
  // The worker sends the device size as `viewport` too; fall back to the device size if it did not.
  const deviceSize = device ? { width: device.width, height: device.height } : {}
  opts.viewport = { ...DEFAULT_OPTIONS.viewport, ...deviceSize, ...(o?.viewport ?? {}) }
  if (device) {
    opts.device = {
      ...device,
      is_mobile: device.is_mobile === true,
      has_touch: device.has_touch === true,
      playwright: typeof device.playwright === 'string' && device.playwright ? device.playwright : null,
    }
  } else {
    delete opts.device
  }
  opts.step_timeout_ms = Number(opts.step_timeout_ms) > 0 ? Number(opts.step_timeout_ms) : DEFAULT_OPTIONS.step_timeout_ms
  opts.retries = Math.max(0, Math.min(MAX_RETRIES, Math.trunc(Number(opts.retries) || 0)))
  return opts
}

function validBaseUrl(v: string | undefined): string | undefined {
  if (!v) return undefined
  try {
    return new URL(v).href
  } catch {
    return undefined
  }
}

const positive = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)

/** Execution of one run.start message (one segment of a run). */
export class RunExecution {
  readonly runId: string
  private readonly abort = new AbortController()
  private readonly sessions = new Set<Session>()
  private readonly masker: Masker
  private cancelled = false

  constructor(
    private readonly msg: RunStartMessage,
    private readonly pool: BrowserPool,
  ) {
    this.runId = msg.run_id
    this.masker = new Masker(msg.secrets)
  }

  get isCancelled(): boolean {
    return this.cancelled
  }

  /** Abort the current step right away (contexts are closed) and skip everything that remains. */
  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    log.info('cancelling run', { run_id: this.runId })
    this.abort.abort()
    for (const s of this.sessions) void s.close()
  }

  private emit(event: OutboundEvent): void {
    emit(this.masker.deep(event))
  }

  private runnerError(message: string): void {
    this.emit({ type: 'runner.error', run_id: this.runId, message })
  }

  async execute(): Promise<RunStatus> {
    let status: RunStatus
    try {
      status = await this.runCases()
    } catch (err) {
      log.error('run crashed', { run_id: this.runId, error: err instanceof Error ? err.stack : String(err) })
      this.runnerError(`Runner error: ${err instanceof Error ? err.message : String(err)}`)
      status = this.cancelled ? 'cancelled' : 'error'
    } finally {
      await Promise.allSettled([...this.sessions].map((s) => s.close()))
      this.sessions.clear()
    }
    this.emit({ type: 'run.finished', run_id: this.runId, status })
    return status
  }

  private newSession(opts: RunOptions, needsBrowser: boolean, videoDir: string | null, baseURL: string | undefined): Session {
    const s = new Session({
      pool: this.pool,
      options: opts,
      needsBrowser,
      videoDir: needsBrowser ? videoDir : null,
      baseURL,
      signal: this.abort.signal,
    })
    this.sessions.add(s)
    return s
  }

  private async closeSession(s: Session): Promise<string | null> {
    const raw = await s.close()
    this.sessions.delete(s)
    return raw
  }

  /** Keep (rename to dest) or delete a finished recording; returns the kept absolute path. */
  private async finalizeVideo(raw: string | null, dest: string, keep: boolean): Promise<string | null> {
    if (!raw) return null
    try {
      if (keep) {
        await rename(raw, dest)
        return dest
      }
      await rm(raw, { force: true })
      return null
    } catch (err) {
      log.warn('video finalize failed', { run_id: this.runId, error: String(err) })
      return null
    } finally {
      await rmdir(join(raw, '..')).catch(() => {}) // the per-recording temp dir, if now empty
    }
  }

  private async runCases(): Promise<RunStatus> {
    const msg = this.msg
    const opts = mergeOptions(msg.options)
    const env = stringifyRecord(msg.env)
    const secrets = stringifyRecord(msg.secrets)
    const runVars = stringifyRecord(msg.vars)
    const baseURL = validBaseUrl(env.BASE_URL)
    const artifactDir = isAbsolute(msg.artifact_dir) ? msg.artifact_dir : resolve(msg.artifact_dir)
    await mkdir(artifactDir, { recursive: true })

    const cases = msg.cases
    // A one-case segment behaves exactly like an isolated case, so "shared" only matters for 2+ cases.
    const shared = msg.shared_session === true && cases.length > 1
    const stopOnFailure = msg.stop_on_failure !== false
    const videoOn = opts.video !== 'off'
    const caseDirOf = (c: WireCase) => join(artifactDir, c.case_id)

    let runtime: Record<string, string> = {}
    const sharedSession = shared
      ? this.newSession(opts, cases.some(hasUiStep), videoOn ? join(caseDirOf(cases[0]), '.video') : null, baseURL)
      : null

    const results: StepStatus[] = []
    let stop = false

    for (const c of cases) {
      if (this.cancelled || stop) {
        this.emit({ type: 'case.finished', run_id: this.runId, case_id: c.case_id, status: 'skipped', video: null })
        results.push('skipped')
        continue
      }
      const caseDir = caseDirOf(c)
      await mkdir(caseDir, { recursive: true })
      const caseVars = stringifyRecord(c.vars)
      const maxAttempts = 1 + opts.retries
      let status: StepStatus = 'skipped'
      let video: string | null = null

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (!shared) runtime = {} // runtime vars only carry across cases in a shared session
        const session = sharedSession ?? this.newSession(opts, hasUiStep(c), videoOn ? join(caseDir, '.video') : null, baseURL)
        this.emit({ type: 'case.started', run_id: this.runId, case_id: c.case_id })
        status = await this.runSteps(c, session, { env, secrets, runVars, caseVars, runtime }, opts, caseDir, attempt)

        if (!shared) {
          const raw = await this.closeSession(session)
          const keep =
            !this.cancelled && status !== 'skipped' && (opts.video === 'always' || (opts.video === 'on_failure' && isFailure(status)))
          video = await this.finalizeVideo(raw, join(caseDir, 'video.webm'), keep)
        }
        if (status === 'failed' && attempt < maxAttempts && !this.cancelled) {
          log.info('retrying case', { run_id: this.runId, case_id: c.case_id, attempt: attempt + 1 })
          if (video) await rm(video, { force: true })
          video = null
          continue
        }
        break
      }

      this.emit({ type: 'case.finished', run_id: this.runId, case_id: c.case_id, status, video })
      results.push(status)
      if (isFailure(status) && stopOnFailure && c.continue_on_failure !== true) stop = true
    }

    if (sharedSession) {
      // Shared session ⇒ one video for the segment, attached to the first case. The file is only
      // complete once the context is closed (after the last case), so the first case's
      // case.finished is emitted a second time with the video path.
      const raw = await this.closeSession(sharedSession)
      const keep = !this.cancelled && (opts.video === 'always' || (opts.video === 'on_failure' && results.some(isFailure)))
      const first = cases[0]
      const video = await this.finalizeVideo(raw, join(caseDirOf(first), 'video.webm'), keep && results[0] !== 'skipped')
      if (video) this.emit({ type: 'case.finished', run_id: this.runId, case_id: first.case_id, status: results[0], video })
    }

    if (this.cancelled) return 'cancelled'
    if (results.includes('error')) return 'error'
    if (results.includes('failed')) return 'failed'
    return 'passed'
  }

  private async runSteps(
    c: WireCase,
    session: Session,
    vars: { env: Record<string, string>; secrets: Record<string, string>; runVars: Record<string, string>; caseVars: Record<string, string>; runtime: Record<string, string> },
    opts: RunOptions,
    caseDir: string,
    attempt: number,
  ): Promise<StepStatus> {
    const statuses: StepStatus[] = []
    const http: StepContext['http'] = { last: null }
    let halted = false
    let cancelledHere = false

    const finish = (step: WireStep, status: StepStatus, extra?: Partial<Extract<OutboundEvent, { type: 'step.finished' }>>) => {
      statuses.push(status)
      this.emit({
        type: 'step.finished',
        run_id: this.runId,
        case_id: c.case_id,
        step_id: step.step_id,
        status,
        duration_ms: 0,
        error: null,
        screenshot: null,
        details: null,
        ...extra,
      })
    }

    for (const [idx, step] of c.steps.entries()) {
      if (this.cancelled) {
        cancelledHere = true
        finish(step, 'skipped')
        continue
      }
      if (halted || step.enabled === false) {
        finish(step, 'skipped')
        continue
      }

      this.emit({ type: 'step.started', run_id: this.runId, case_id: c.case_id, step_id: step.step_id })
      const started = performance.now()
      const timeoutMs = positive(step.timeout_ms) ?? opts.step_timeout_ms
      let status: StepStatus = 'passed'
      let error: string | null = null
      let details: Record<string, unknown> | null = null
      let shot: string | null = null

      try {
        const scope: Scope = {
          env: vars.env,
          secrets: vars.secrets,
          vars: { ...vars.env, ...vars.runVars, ...vars.caseVars, ...vars.runtime },
          sensitive: (v) => this.masker.add(v),
        }
        await waitForFreshTotp(step, this.abort.signal)
        const resolved = interpolateStep(step, scope)
        const out = await executeStep(
          {
            session,
            signal: this.abort.signal,
            timeoutMs,
            runtime: vars.runtime,
            http,
            screenshotPath: (name) => screenshotFile(caseDir, idx, step.step_id, attempt, name),
          },
          resolved,
        )
        details = out.details
        shot = out.screenshot
      } catch (err) {
        if (err instanceof CancelledError || this.cancelled) {
          status = 'skipped'
          cancelledHere = true
        } else if (err instanceof StepFailure) {
          status = 'failed'
          error = err.message
          details = err.details
        } else if (err instanceof InfraError) {
          status = 'error'
          error = err.message
          this.runnerError(err.message)
        } else {
          status = 'error'
          error = `Runner error: ${err instanceof Error ? err.message : String(err)}`
          log.error('unexpected step error', { run_id: this.runId, step_id: step.step_id, error: err instanceof Error ? err.stack : String(err) })
          this.runnerError(error)
        }
      }

      // Screenshots: UI steps only (HTTP/common steps never), after the step, per run options.
      if (!this.cancelled && status !== 'skipped' && !shot && ACTION_KIND[step.action] === 'ui') {
        const want =
          step.screenshot === true || opts.screenshot === 'every_step' || (opts.screenshot === 'on_failure' && isFailure(status))
        if (want) shot = await captureScreenshot(session, screenshotFile(caseDir, idx, step.step_id, attempt))
      }

      finish(step, status, { duration_ms: Math.round(performance.now() - started), error, screenshot: shot, details })
      if (isFailure(status) && step.continue_on_failure !== true) halted = true
    }

    if (cancelledHere || this.cancelled) return 'skipped'
    if (statuses.includes('error')) return 'error'
    if (statuses.includes('failed')) return 'failed'
    if (statuses.length > 0 && statuses.every((s) => s === 'skipped')) return 'skipped'
    return 'passed'
  }
}
