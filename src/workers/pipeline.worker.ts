import type PgBoss from 'pg-boss'
import { runDownload } from './steps/download.js'
import { runTranscribe } from './steps/transcribe.js'
import { runSegment } from './steps/segment.js'
import { runEmbed } from './steps/embed.js'
import { runSummarize } from './steps/summarize.js'
import { updateSourceVideoStatus } from '../db/queries.js'
import { QUEUE_PIPELINE, type PipelineJobData } from '../queues/jobs.js'
import type { PipelineDeps } from './types.js'

export async function registerPipelineWorker(
  boss: PgBoss,
  deps: PipelineDeps
): Promise<void> {
  await boss.work<PipelineJobData>(
    QUEUE_PIPELINE,
    { batchSize: 1 },
    async ([job]) => {
      if (!job) return
      const ctx = { ...deps, sourceVideoId: job.data.sourceVideoId, youtubeUrl: job.data.youtubeUrl }
      try {
        const dl = await runDownload(ctx)
        const meta = await deps.youtube.getMetadata(job.data.youtubeUrl)
        const transcription = await runTranscribe(ctx, { audioPath: dl.audioPath })
        const seg = await runSegment(ctx, { transcription, chapters: meta.chapters })
        const talks = seg.talkIds.map((t) => ({ talkId: t.talkId, transcriptId: t.transcriptId, text: t.text }))
        await runEmbed(ctx, { talks })
        await runSummarize(ctx, { talks })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await updateSourceVideoStatus(deps.pool, job.data.sourceVideoId, 'error', msg)
        throw err
      }
    }
  )
}
