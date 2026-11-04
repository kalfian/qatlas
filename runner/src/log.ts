// Logs go to stderr only: stdout is reserved for protocol events.

type Level = 'debug' | 'info' | 'warn' | 'error'

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 }
const threshold = ORDER[(process.env.QATLAS_RUNNER_LOG_LEVEL as Level) ?? 'info'] ?? ORDER.info

function write(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold) return
  const extra = fields ? ' ' + JSON.stringify(fields) : ''
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} [runner] ${msg}${extra}\n`)
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => write('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => write('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => write('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => write('error', msg, fields),
}
