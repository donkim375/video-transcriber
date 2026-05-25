import { describe, it, expect, vi } from 'vitest'
import { withRetry } from '../../src/services/retry.js'

describe('withRetry', () => {
  it('returns success on first attempt without retrying', async () => {
    const fn = vi.fn(async () => 'ok')
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('retries on HTTP 429 and returns success on second attempt', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n += 1
      if (n === 1) {
        const err = new Error('rate limited') as Error & { status?: number }
        err.status = 429
        throw err
      }
      return 'ok'
    })
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('retries on ECONNRESET (Node error code)', async () => {
    let n = 0
    const fn = vi.fn(async () => {
      n += 1
      if (n < 3) {
        const err = new Error('connection reset') as Error & { code?: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return 'ok'
    })
    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })
    expect(result).toBe('ok')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('does NOT retry on HTTP 400', async () => {
    const err = new Error('bad request') as Error & { status?: number }
    err.status = 400
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow('bad request')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('does NOT retry on TypeError', async () => {
    const fn = vi.fn(async () => { throw new TypeError('nope') })
    await expect(withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow(TypeError)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('throws the last error after exhausting attempts', async () => {
    const err = new Error('always fails') as Error & { status?: number }
    err.status = 503
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, opName: 'test' })).rejects.toThrow('always fails')
    expect(fn).toHaveBeenCalledTimes(3)
  })

  it('calls onAttempt for each retry with attempt number and error', async () => {
    const onAttempt = vi.fn()
    const err = new Error('boom') as Error & { status?: number }
    err.status = 500
    const fn = vi.fn(async () => { throw err })
    await expect(withRetry(fn, { attempts: 3, baseDelayMs: 1, maxDelayMs: 1, onAttempt })).rejects.toThrow()
    expect(onAttempt).toHaveBeenCalledTimes(2)
    expect(onAttempt).toHaveBeenNthCalledWith(1, 1, err)
    expect(onAttempt).toHaveBeenNthCalledWith(2, 2, err)
  })

  it('honors custom isRetryable predicate', async () => {
    const err = new Error('weird') as Error & { code?: string }
    err.code = 'CUSTOM'
    const fn = vi.fn(async () => { throw err })
    const isRetryable = (e: unknown): boolean =>
      e instanceof Error && (e as Error & { code?: string }).code === 'CUSTOM'
    await expect(
      withRetry(fn, { attempts: 2, baseDelayMs: 1, maxDelayMs: 1, isRetryable })
    ).rejects.toThrow('weird')
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
