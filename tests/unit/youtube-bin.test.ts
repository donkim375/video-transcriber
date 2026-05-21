import { describe, it, expect } from 'vitest'
import { resolveYtDlpPath } from '../../src/services/youtube-bin.js'

describe('resolveYtDlpPath', () => {
  it('returns /app/bin/yt-dlp when the bundled binary exists', () => {
    const probe = (p: string) => p === '/app/bin/yt-dlp'
    expect(resolveYtDlpPath(probe)).toBe('/app/bin/yt-dlp')
  })

  it('falls back to bare "yt-dlp" when the bundled binary is absent', () => {
    const probe = (_p: string) => false
    expect(resolveYtDlpPath(probe)).toBe('yt-dlp')
  })
})
