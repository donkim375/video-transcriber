import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

const VALID_HEADERS = ['# Netscape HTTP Cookie File', '# HTTP Cookie File']

export function writeCookiesFile(b64: string, dir = '/tmp'): string {
  const decoded = Buffer.from(b64, 'base64').toString('utf8')
  const firstLine = decoded.split('\n', 1)[0] ?? ''
  if (!VALID_HEADERS.includes(firstLine)) {
    throw new Error(
      'Invalid YOUTUBE_COOKIES_B64: decoded content is not a Netscape cookies.txt file ' +
      '(expected first line to be "# Netscape HTTP Cookie File")'
    )
  }
  const path = join(dir, 'youtube-cookies.txt')
  writeFileSync(path, decoded, { mode: 0o600 })
  return path
}
