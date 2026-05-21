import { existsSync } from 'node:fs'

const BUNDLED_PATH = '/app/bin/yt-dlp'

export function resolveYtDlpPath(probe: (p: string) => boolean = existsSync): string {
  return probe(BUNDLED_PATH) ? BUNDLED_PATH : 'yt-dlp'
}
