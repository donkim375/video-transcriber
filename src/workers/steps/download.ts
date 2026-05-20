import { join } from 'node:path'
import type { StepContext } from '../types.js'
import { updateSourceVideoStatus, updateSourceVideoMetadata } from '../../db/queries.js'

export interface DownloadResult {
  audioPath: string
}

export async function runDownload(ctx: StepContext): Promise<DownloadResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'downloading')
  const meta = await ctx.youtube.getMetadata(ctx.youtubeUrl)
  await updateSourceVideoMetadata(ctx.pool, ctx.sourceVideoId, {
    title: meta.title,
    channel: meta.channel,
    durationSeconds: meta.durationSeconds,
    thumbnailUrl: meta.thumbnailUrl,
    hasChapters: meta.chapters.length > 0,
  })
  const audioPath = join(ctx.tmpDir, `${ctx.sourceVideoId}.mp3`)
  await ctx.youtube.downloadAudio(ctx.youtubeUrl, audioPath)
  return { audioPath }
}
