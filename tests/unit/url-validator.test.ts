import { describe, it, expect } from 'vitest'
import { extractYouTubeId, isValidYouTubeUrl } from '../../src/services/url-validator.js'

describe('extractYouTubeId', () => {
  it('extracts id from standard watch URL', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts id from short youtu.be URL', () => {
    expect(extractYouTubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })
  it('extracts id with extra query params', () => {
    expect(extractYouTubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=42s')).toBe('dQw4w9WgXcQ')
  })
  it('returns null for non-YouTube URL', () => {
    expect(extractYouTubeId('https://vimeo.com/12345')).toBeNull()
  })
  it('returns null for malformed input', () => {
    expect(extractYouTubeId('not a url')).toBeNull()
  })
})

describe('isValidYouTubeUrl', () => {
  it('accepts watch URL', () => {
    expect(isValidYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true)
  })
  it('rejects invalid URL', () => {
    expect(isValidYouTubeUrl('https://example.com')).toBe(false)
  })
})
