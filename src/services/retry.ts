// withRetry — transparent retry wrapper for external API calls.
//
// Used by AssemblyAIService, OpenAIEmbeddingService, and ClaudeLLMService only.
// Deliberately NOT used by YouTubeService — see docs/superpowers/specs/
// 2026-05-25-9hour-parse-critical-fixes-design.md, Component 2.

export interface RetryOptions {
  attempts?: number
  baseDelayMs?: number
  maxDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  onAttempt?: (attempt: number, err: unknown) => void
  opName?: string
}

const NETWORK_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'])
const TRANSIENT_MSG = /fetch failed|socket hang up|timeout/i

export function defaultIsRetryable(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  if (err instanceof TypeError) return false
  if (Array.isArray((err as { issues?: unknown[] }).issues)) return false

  const status = (err as { status?: number }).status
  if (typeof status === 'number') {
    if (status === 429) return true
    if (status >= 500 && status < 600) return true
    return false
  }

  const code = (err as { code?: string }).code
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true

  return TRANSIENT_MSG.test(err.message)
}

function defaultLog(opName: string | undefined, attempt: number, max: number, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err)
  console.warn(`[retry] op=${opName ?? 'anon'} attempt=${attempt}/${max} err=${msg}`)
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = opts.attempts ?? 3
  const baseDelayMs = opts.baseDelayMs ?? 500
  const maxDelayMs = opts.maxDelayMs ?? 10_000
  const isRetryable = opts.isRetryable ?? defaultIsRetryable

  let lastErr: unknown
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt >= attempts || !isRetryable(err)) throw err

      if (opts.onAttempt) opts.onAttempt(attempt, err)
      else defaultLog(opts.opName, attempt, attempts, err)

      const cap = Math.min(maxDelayMs, baseDelayMs * Math.pow(2, attempt - 1))
      const delay = Math.floor(Math.random() * cap)
      await new Promise((r) => setTimeout(r, delay))
    }
  }
  throw lastErr
}
