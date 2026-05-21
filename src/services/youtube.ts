import { exec as nodeExec } from 'node:child_process'
import { promisify } from 'node:util'
import type { IYouTubeService } from '../interfaces/youtube.js'
import type { VideoMetadata } from '../types/index.js'

const execAsync = promisify(nodeExec)

export type ExecFn = (cmd: string) => Promise<{ stdout: string; stderr: string }>

export class YouTubeService implements IYouTubeService {
  private exec: ExecFn
  private cookiesPath?: string
  private ytDlpPath: string
  constructor(opts: { exec?: ExecFn; cookiesPath?: string; ytDlpPath?: string } = {}) {
    this.exec = opts.exec ?? ((cmd) => execAsync(cmd, { maxBuffer: 20 * 1024 * 1024 }))
    this.cookiesPath = opts.cookiesPath
    this.ytDlpPath = opts.ytDlpPath && opts.ytDlpPath.length > 0 ? opts.ytDlpPath : 'yt-dlp'
  }

  private cookiesFlag(): string {
    return this.cookiesPath ? ` --cookies ${shellQuote(this.cookiesPath)}` : ''
  }

  async getMetadata(url: string): Promise<VideoMetadata> {
    const safe = shellQuote(url)
    const { stdout } = await this.exec(
      `${this.ytDlpPath} --no-warnings${this.cookiesFlag()} --dump-json --skip-download ${safe}`
    )
    const parsed = JSON.parse(stdout)
    const chapters = Array.isArray(parsed.chapters)
      ? parsed.chapters.map((c: any) => ({
          title: String(c.title ?? ''),
          startMs: Math.round(Number(c.start_time ?? 0) * 1000),
          endMs: Math.round(Number(c.end_time ?? 0) * 1000),
        }))
      : []
    return {
      title: String(parsed.title ?? ''),
      channel: String(parsed.channel ?? parsed.uploader ?? ''),
      durationSeconds: Number(parsed.duration ?? 0),
      thumbnailUrl: String(parsed.thumbnail ?? ''),
      chapters,
    }
  }

  async downloadAudio(url: string, outputPath: string): Promise<void> {
    const safeUrl = shellQuote(url)
    const safeOut = shellQuote(outputPath)
    await this.exec(
      `${this.ytDlpPath} --no-warnings${this.cookiesFlag()} -x --audio-format mp3 -o ${safeOut} ${safeUrl}`
    )
  }
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`
}
