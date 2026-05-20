import type { StepContext } from '../types.js'
import type { TranscriptionResult, TalkBoundary, ContentType, Utterance } from '../../types/index.js'
import {
  updateSourceVideoStatus, insertTalk, insertTranscript,
} from '../../db/queries.js'
import { resolveSegmentationStrategy, sliceUtterancesByBoundary } from '../../services/segmentation.js'

export interface SegmentInput {
  transcription: TranscriptionResult
  chapters: { title: string; startMs: number; endMs: number }[]
  contentType?: ContentType
  videoTitle?: string
}

export interface SegmentResult {
  talkIds: { talkId: string; transcriptId: string; boundary: TalkBoundary; text: string; utterances: Utterance[] }[]
}

function buildDeepLink(url: string, startMs: number): string {
  const sec = Math.floor(startMs / 1000)
  const u = new URL(url)
  u.searchParams.set('t', `${sec}s`)
  return u.toString()
}

export async function runSegment(ctx: StepContext, input: SegmentInput): Promise<SegmentResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'segmenting')

  const strategy = resolveSegmentationStrategy(input.contentType ?? 'auto')
  const boundaries: TalkBoundary[] = await strategy.segment({
    chapters: input.chapters,
    transcription: input.transcription,
    videoTitle: input.videoTitle,
    llm: ctx.llm,
  })

  const out: SegmentResult['talkIds'] = []
  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    const slice = sliceUtterancesByBoundary(input.transcription.utterances, b)
    const text = slice.map((u) => u.text).join(' ')
    const talk = await insertTalk(ctx.pool, {
      sourceVideoId: ctx.sourceVideoId,
      title: b.title,
      speaker: b.speaker,
      talkIndex: i,
      startMs: b.startMs,
      endMs: b.endMs,
      youtubeDeepLink: buildDeepLink(ctx.youtubeUrl, b.startMs),
    })
    const transcript = await insertTranscript(ctx.pool, {
      talkId: talk.id,
      assemblyaiId: `${input.transcription.assemblyaiId}#${i}`,
      rawText: text,
      utterances: slice,
    })
    out.push({ talkId: talk.id, transcriptId: transcript.id, boundary: b, text, utterances: slice })
  }

  return { talkIds: out }
}
