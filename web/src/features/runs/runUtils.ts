import type { Artifact, Run, RunCase, RunKind, RunOptions, RunStatus, RunStep, RunTrigger, StepStatus } from '@/api/types'

/* ------------------------------------------------------------------ label */

export const TRIGGER_LABEL: Record<RunTrigger, string> = {
  manual: 'Manual',
  mcp: 'via MCP',
  api: 'via API',
  schedule: 'Terjadwal',
}

export const KIND_LABEL: Record<RunKind, string> = { test_case: 'Test case', flow: 'Flow' }

export const BROWSER_LABEL: Record<RunOptions['browser'], string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' }
export const SCREENSHOT_LABEL: Record<RunOptions['screenshot'], string> = { off: 'Off', on_failure: 'Saat gagal', every_step: 'Tiap step' }
export const VIDEO_LABEL: Record<RunOptions['video'], string> = { off: 'Off', on_failure: 'Saat gagal', always: 'Selalu' }

export const RUN_STATUS_ORDER: RunStatus[] = ['queued', 'running', 'awaiting_manual', 'passed', 'failed', 'blocked', 'error', 'cancelled']

/* ------------------------------------------------------------------ status */

export const isLive = (s: RunStatus) => s === 'queued' || s === 'running'
export const isActive = (s: RunStatus) => isLive(s) || s === 'awaiting_manual'
export const isFinalStep = (s: StepStatus) => s !== 'pending' && s !== 'running'
export const isFailStep = (s: StepStatus) => s === 'failed' || s === 'error'

/** Case manual yang sedang menunggu tester (null jika tidak ada). */
export function manualCaseOf(run: Run): RunCase | null {
  if (run.status !== 'awaiting_manual' || run.resume_position == null) return null
  return run.cases.find((c) => c.position === run.resume_position && c.execution === 'manual') ?? null
}

export interface StepTally {
  total: number
  done: number
  passed: number
  failed: number
  error: number
  blocked: number
  skipped: number
  running: number
}

export function tallySteps(run: Run): StepTally {
  const t: StepTally = { total: 0, done: 0, passed: 0, failed: 0, error: 0, blocked: 0, skipped: 0, running: 0 }
  for (const c of run.cases)
    for (const s of c.steps) {
      t.total += 1
      if (s.status === 'running') t.running += 1
      else if (s.status !== 'pending') {
        t.done += 1
        t[s.status] += 1
      }
    }
  return t
}

/** Step gagal pertama; case manual yang sedang dikerjakan diabaikan (tester sudah melihatnya). */
export function firstFailedStep(run: Run, skipCaseId?: string): { caseId: string; stepId: string } | null {
  for (const c of run.cases) {
    if (c.id === skipCaseId) continue
    for (const s of c.steps) if (isFailStep(s.status)) return { caseId: c.id, stepId: s.id }
  }
  return null
}

export function failedStepCount(run: Run, skipCaseId?: string): number {
  let n = 0
  for (const c of run.cases) if (c.id !== skipCaseId) for (const s of c.steps) if (isFailStep(s.status)) n += 1
  return n
}

/* ------------------------------------------------------------------ waktu */

/** 00:42 / 1:02:03 — untuk durasi yang berjalan. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/* ------------------------------------------------------------------ media */

export interface MediaItem {
  id: string
  url: string
  name: string
  mime: string
  expired: boolean
  caption: string
  alt: string
  status?: StepStatus
}

export function isImage(a: Pick<Artifact, 'mime'>) {
  return a.mime.startsWith('image/')
}

export function stepCaption(c: RunCase, s: RunStep) {
  return `Case ${c.position} · Step ${s.position} · ${s.action}`
}

/** Semua screenshot run, urut case → step (dipakai galeri & lightbox ←/→). */
export function collectScreenshots(run: Run): MediaItem[] {
  const out: MediaItem[] = []
  for (const c of run.cases)
    for (const s of c.steps)
      if (s.screenshot)
        out.push({
          id: s.screenshot.id,
          url: s.screenshot.url,
          name: s.screenshot.name,
          mime: s.screenshot.mime,
          expired: s.screenshot.expired,
          caption: stepCaption(c, s),
          alt: `Screenshot step ${s.position} (${s.action}) pada ${c.test_case_key}`,
          status: s.status,
        })
  return out
}

export function attachmentItems(c: RunCase, list: Artifact[]): MediaItem[] {
  return list.filter(isImage).map((a) => {
    const step = a.run_step_id ? c.steps.find((s) => s.id === a.run_step_id) : undefined
    return {
      id: a.id,
      url: a.url,
      name: a.name,
      mime: a.mime,
      expired: a.expired,
      caption: step ? `${c.test_case_key} · Step ${step.position} · lampiran ${a.name}` : `${c.test_case_key} · lampiran ${a.name}`,
      alt: `Lampiran ${a.name}${step ? ` untuk step ${step.position}` : ''} pada ${c.test_case_key}`,
    }
  })
}

/* ------------------------------------------------------------------ export */

export function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Status final case manual seperti dihitung server: failed > blocked > passed. */
export function projectedManualStatus(statuses: StepStatus[]): StepStatus {
  if (statuses.includes('failed')) return 'failed'
  if (statuses.includes('blocked')) return 'blocked'
  if (statuses.length > 0 && statuses.every((s) => s === 'skipped')) return 'skipped'
  return 'passed'
}
