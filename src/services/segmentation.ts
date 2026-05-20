import type { Utterance, TalkBoundary, TranscriptionResult, ContentType } from '../types/index.js'
import type { ILLMService } from '../interfaces/llm.js'

export interface Chapter {
  title: string
  startMs: number
  endMs: number
}

const BY_RE = /^(.*?)\s+by\s+(.+)$/i

export function boundariesFromChapters(chapters: Chapter[]): TalkBoundary[] {
  return chapters.map((c) => {
    const match = c.title.match(BY_RE)
    if (match) {
      return { title: match[1]!.trim(), speaker: match[2]!.trim(), startMs: c.startMs, endMs: c.endMs }
    }
    return { title: c.title, speaker: '', startMs: c.startMs, endMs: c.endMs }
  })
}

export function sliceUtterancesByBoundary(utterances: Utterance[], boundary: TalkBoundary): Utterance[] {
  return utterances.filter((u) => u.startMs >= boundary.startMs && u.startMs < boundary.endMs)
}

export interface SegmentationContext {
  chapters: Chapter[]
  transcription: TranscriptionResult
  videoTitle?: string
  llm: ILLMService
}

export interface SegmentationStrategy {
  readonly name: ContentType
  segment(ctx: SegmentationContext): Promise<TalkBoundary[]>
}

function endMsFromUtterances(utterances: Utterance[]): number {
  let max = 0
  for (const u of utterances) if (u.endMs > max) max = u.endMs
  return max
}

class SingleSpeakerStrategy implements SegmentationStrategy {
  readonly name = 'single_speaker' as const
  async segment(ctx: SegmentationContext): Promise<TalkBoundary[]> {
    const endMs = endMsFromUtterances(ctx.transcription.utterances)
    return [{ title: ctx.videoTitle ?? 'Full Talk', speaker: '', startMs: 0, endMs }]
  }
}

class ConferenceStrategy implements SegmentationStrategy {
  readonly name = 'conference' as const
  async segment(ctx: SegmentationContext): Promise<TalkBoundary[]> {
    if (ctx.chapters.length > 0) return boundariesFromChapters(ctx.chapters)
    return ctx.llm.segmentTranscript(ctx.transcription.rawText)
  }
}

class PodcastInterviewStrategy implements SegmentationStrategy {
  readonly name = 'podcast_interview' as const
  async segment(ctx: SegmentationContext): Promise<TalkBoundary[]> {
    // Podcasts/interviews are one continuous dialogue. Keep as a single talk;
    // downstream chunking can become speaker-turn-aware later (see Issue 2 in docs).
    const endMs = endMsFromUtterances(ctx.transcription.utterances)
    return [{ title: ctx.videoTitle ?? 'Episode', speaker: '', startMs: 0, endMs }]
  }
}

// Placeholder for a future classifier. Heuristic: if YouTube provided
// chapters, prefer chapter-based segmentation (conference); otherwise
// fall back to single-speaker, which is safer than asking the LLM to
// invent boundaries.
class AutoStrategy implements SegmentationStrategy {
  readonly name = 'auto' as const
  async segment(ctx: SegmentationContext): Promise<TalkBoundary[]> {
    const target = ctx.chapters.length > 0 ? 'conference' : 'single_speaker'
    return STRATEGIES[target].segment(ctx)
  }
}

const STRATEGIES: Record<ContentType, SegmentationStrategy> = {
  single_speaker: new SingleSpeakerStrategy(),
  conference: new ConferenceStrategy(),
  podcast_interview: new PodcastInterviewStrategy(),
  auto: new AutoStrategy(),
}

export function resolveSegmentationStrategy(contentType: ContentType): SegmentationStrategy {
  return STRATEGIES[contentType]
}
