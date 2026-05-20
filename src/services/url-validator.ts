const ID_RE = /^[A-Za-z0-9_-]{11}$/

export function extractYouTubeId(input: string): string | null {
  if (typeof input !== 'string') return null
  try {
    const url = new URL(input)
    const host = url.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') {
      const id = url.pathname.slice(1)
      return ID_RE.test(id) ? id : null
    }
    if (host === 'youtube.com' || host === 'm.youtube.com') {
      const id = url.searchParams.get('v') ?? ''
      return ID_RE.test(id) ? id : null
    }
    return null
  } catch {
    return null
  }
}

export function isValidYouTubeUrl(input: string): boolean {
  return extractYouTubeId(input) !== null
}
