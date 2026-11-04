import type en from '../en/status'
import type { Translation } from '../../types'

/** Namespace `status` (Bahasa Indonesia). Label status sengaja tetap Inggris (sama dengan output MCP/API). */
export default {
  passed: 'Passed',
  failed: 'Failed',
  error: 'Error',
  blocked: 'Blocked',
  running: 'Running',
  queued: 'Queued',
  pending: 'Pending',
  awaiting_manual: 'Awaiting manual',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
} satisfies Translation<typeof en>
