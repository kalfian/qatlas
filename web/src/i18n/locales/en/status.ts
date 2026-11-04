/**
 * Namespace `status` (English — source of truth for keys). Run/step status labels.
 * Status labels stay English in every language so they match MCP/API output.
 */
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
} as const
