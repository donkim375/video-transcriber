import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const YOUTUBE_SRC = resolve(__dirname, '../../src/services/youtube.ts')

describe('YouTubeService — no retry guard', () => {
  it('does not import or invoke withRetry', () => {
    const contents = readFileSync(YOUTUBE_SRC, 'utf8')
    expect(contents.includes('withRetry')).toBe(false)
  })

  it('contains the deliberate-non-wrap banner comment pointing at the spec', () => {
    const contents = readFileSync(YOUTUBE_SRC, 'utf8')
    expect(contents).toMatch(/9hour-parse-critical-fixes-design/)
  })
})
