// NDJSON protocol between the Go worker and the runner (docs/13 "Runs, worker and runner protocol").

export type BrowserName = 'chromium' | 'firefox' | 'webkit'
export type ScreenshotMode = 'off' | 'on_failure' | 'every_step'
export type VideoMode = 'off' | 'on_failure' | 'always'
export type StepStatus = 'passed' | 'failed' | 'error' | 'skipped'
export type RunStatus = 'passed' | 'failed' | 'error' | 'cancelled'
export type DeviceCategory = 'mobile' | 'tablet' | 'desktop'

/** Emulated device of a run segment (docs/14; catalog: api/devices.json). */
export interface RunDevice {
  id: string
  label: string
  category: DeviceCategory
  width: number
  height: number
  device_scale_factor: number
  is_mobile: boolean
  has_touch: boolean
  /** Playwright descriptor name (devices[...]) supplying the user agent; null → no UA override. */
  playwright: string | null
}

export interface RunOptions {
  browser: BrowserName
  headless: boolean
  /** Always the device size when `device` is set (the worker sends both). */
  viewport: { width: number; height: number }
  /** Absent → plain desktop context of `viewport` size, exactly as before devices existed. */
  device?: RunDevice
  screenshot: ScreenshotMode
  video: VideoMode
  step_timeout_ms: number
  retries: number
}

/** A Step DSL step as sent by the worker (DSL params are flat on the object). */
export interface WireStep {
  step_id: string
  action: string
  timeout_ms?: number | null
  continue_on_failure?: boolean
  enabled?: boolean
  screenshot?: boolean
  [param: string]: unknown
}

export interface WireCase {
  case_id: string
  continue_on_failure?: boolean
  vars?: Record<string, unknown>
  steps: WireStep[]
}

export interface RunStartMessage {
  type: 'run.start'
  run_id: string
  artifact_dir: string
  options?: Partial<RunOptions>
  shared_session?: boolean
  stop_on_failure?: boolean
  env?: Record<string, unknown>
  secrets?: Record<string, unknown>
  vars?: Record<string, unknown>
  cases: WireCase[]
}

export interface RunCancelMessage {
  type: 'run.cancel'
  run_id: string
}

export type InboundMessage = RunStartMessage | RunCancelMessage

export type OutboundEvent =
  | { type: 'ready'; playwright: string }
  | { type: 'case.started'; run_id: string; case_id: string }
  | { type: 'step.started'; run_id: string; case_id: string; step_id: string }
  | {
      type: 'step.finished'
      run_id: string
      case_id: string
      step_id: string
      status: StepStatus
      duration_ms: number
      error: string | null
      screenshot: string | null
      details: Record<string, unknown> | null
    }
  | { type: 'case.finished'; run_id: string; case_id: string; status: StepStatus; video: string | null }
  | { type: 'run.finished'; run_id: string; status: RunStatus }
  | { type: 'runner.error'; run_id: string | null; message: string }

export const DEFAULT_OPTIONS: RunOptions = {
  browser: 'chromium',
  headless: true,
  viewport: { width: 1280, height: 720 },
  screenshot: 'on_failure',
  video: 'off',
  step_timeout_ms: 10000,
  retries: 0,
}

/** Action catalog (web/src/lib/steps.ts) — kind decides whether a browser context is needed. */
export const ACTION_KIND: Record<string, 'ui' | 'http' | 'common' | 'manual'> = {
  goto: 'ui',
  click: 'ui',
  dblclick: 'ui',
  hover: 'ui',
  fill: 'ui',
  type: 'ui',
  press: 'ui',
  select_option: 'ui',
  check: 'ui',
  uncheck: 'ui',
  wait_for: 'ui',
  wait: 'common',
  screenshot: 'ui',
  extract_text: 'ui',
  set_variable: 'common',
  expect_visible: 'ui',
  expect_hidden: 'ui',
  expect_text: 'ui',
  expect_value: 'ui',
  expect_url: 'ui',
  expect_title: 'ui',
  expect_count: 'ui',
  set_viewport: 'ui',
  expect_no_horizontal_scroll: 'ui',
  http_request: 'http',
  expect_status: 'http',
  expect_json: 'http',
  expect_header: 'http',
  expect_response_time: 'http',
  manual: 'manual',
}
