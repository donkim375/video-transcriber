import type PgBoss from 'pg-boss'
import { runDownload } from './steps/download.js'
import { runTranscribe } from './steps/transcribe.js'
import { runSegment } from './steps/segment.js'
import { runEmbed } from './steps/embed.js'
import { runSummarize } from './steps/summarize.js'
import { generateFaqsForVideo } from './steps/generate-faqs.js'
import {
  updateSourceVideoStatus,
  getSourceVideoById,
  listTalksForVideo,
  getTranscriptByTalkId,
  setSourceVideoFaqs,
} from '../db/queries.js'
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
        const seg = await runSegment(ctx, {
          transcription,
          chapters: meta.chapters,
          contentType: job.data.contentType,
          videoTitle: meta.title,
        })
        const embedTalks = seg.talkIds.map((t) => ({
          talkId: t.talkId, transcriptId: t.transcriptId, utterances: t.utterances,
        }))
        const summarizeTalks = seg.talkIds.map((t) => ({
          talkId: t.talkId, transcriptId: t.transcriptId, text: t.text,
        }))
        await runEmbed(ctx, { talks: embedTalks })
        await runSummarize(ctx, { talks: summarizeTalks })

        // FAQ generation step — idempotent, non-fatal
        try {
          const existing = await getSourceVideoById(deps.pool, job.data.sourceVideoId)
          if (existing && existing.faqs == null) {
            const talks = await listTalksForVideo(deps.pool, job.data.sourceVideoId)
            const summaries: Array<{ title: string; summary: string }> = []
            for (const t of talks) {
              const tr = await getTranscriptByTalkId(deps.pool, t.id)
              summaries.push({ title: t.title ?? '', summary: tr?.summary ?? '' })
            }
            const faqs = await generateFaqsForVideo({
              llm: deps.llm,
              videoTitle: meta.title,
              talks: summaries,
            })
            if (faqs.length > 0) {
              await setSourceVideoFaqs(deps.pool, job.data.sourceVideoId, faqs)
            }
          }
        } catch (faqErr) {
          console.error('[pipeline] FAQ generation failed (non-fatal):', faqErr)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        await updateSourceVideoStatus(deps.pool, job.data.sourceVideoId, 'error', msg)
        throw err
      }
    }
  )
}
