import { describe, it, expect, vi } from 'vitest'
import { YouTubeService } from '../../src/services/youtube.js'

const okMetadata = JSON.stringify({
  title: 'My Talk',
  channel: 'Channel X',
  duration: 3600,
  thumbnail: 'https://img/thumb.jpg',
  chapters: [
    { title: 'Intro', start_time: 0, end_time: 60 },
    { title: 'Body', start_time: 60, end_time: 3600 },
  ],
})

describe('YouTubeService.getMetadata', () => {
  it('parses yt-dlp JSON into VideoMetadata', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec })
    const meta = await svc.getMetadata('https://www.youtube.com/watch?v=abc')
    expect(meta.title).toBe('My Talk')
    expect(meta.channel).toBe('Channel X')
    expect(meta.durationSeconds).toBe(3600)
    expect(meta.chapters).toEqual([
      { title: 'Intro', startMs: 0, endMs: 60000 },
      { title: 'Body', startMs: 60000, endMs: 3600000 },
    ])
  })

  it('returns empty chapters when yt-dlp omits them', async () => {
    const exec = vi.fn(async () => ({
      stdout: JSON.stringify({ title: 't', channel: 'c', duration: 10, thumbnail: 'x' }),
      stderr: '',
    }))
    const svc = new YouTubeService({ exec })
    const meta = await svc.getMetadata('https://youtu.be/abc')
    expect(meta.chapters).toEqual([])
  })

  it('throws when yt-dlp exits with error', async () => {
    const exec = vi.fn(async () => { throw new Error('yt-dlp failed') })
    const svc = new YouTubeService({ exec })
    await expect(svc.getMetadata('https://youtu.be/abc')).rejects.toThrow(/yt-dlp/)
  })
})

describe('YouTubeService.downloadAudio', () => {
  it('runs yt-dlp with -x and writes to outputPath', async () => {
    const exec = vi.fn(async (_cmd: string) => ({ stdout: '', stderr: '' }))
    const svc = new YouTubeService({ exec })
    await svc.downloadAudio('https://youtu.be/abc', '/tmp/abc.mp3')
    expect(exec).toHaveBeenCalledOnce()
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain('yt-dlp')
    expect(cmd).toContain('-x')
    expect(cmd).toContain('--audio-format mp3')
    expect(cmd).toContain('/tmp/abc.mp3')
    expect(cmd).toContain('https://youtu.be/abc')
  })
})

describe('YouTubeService with cookiesPath', () => {
  it('includes --cookies in getMetadata when cookiesPath is set', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec, cookiesPath: '/tmp/youtube-cookies.txt' })
    await svc.getMetadata('https://youtu.be/abc')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain(`--cookies '/tmp/youtube-cookies.txt'`)
  })

  it('includes --cookies in downloadAudio when cookiesPath is set', async () => {
    const exec = vi.fn(async () => ({ stdout: '', stderr: '' }))
    const svc = new YouTubeService({ exec, cookiesPath: '/tmp/youtube-cookies.txt' })
    await svc.downloadAudio('https://youtu.be/abc', '/tmp/abc.mp3')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).toContain(`--cookies '/tmp/youtube-cookies.txt'`)
  })

  it('omits --cookies when cookiesPath is undefined', async () => {
    const exec = vi.fn(async () => ({ stdout: okMetadata, stderr: '' }))
    const svc = new YouTubeService({ exec })
    await svc.getMetadata('https://youtu.be/abc')
    const cmd = exec.mock.calls[0]![0] as string
    expect(cmd).not.toContain('--cookies')
  })
})
