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

export interface BoundaryValidationOptions {
  audioDurationMs: number
  minCoverageRatio?: number
  maxGapMs?: number
  introMaxStartMs?: number
}

export function validateBoundaries(
  boundaries: TalkBoundary[],
  opts: BoundaryValidationOptions,
): void {
  if (boundaries.length === 0) {
    throw new Error('validateBoundaries: boundary array is empty')
  }

  const minCoverageRatio = opts.minCoverageRatio ?? 0.95
  const maxGapMs = opts.maxGapMs ?? 120_000
  const introMaxStartMs = opts.introMaxStartMs ?? 60_000

  for (let i = 0; i < boundaries.length; i++) {
    const b = boundaries[i]!
    if (b.endMs <= b.startMs) {
      throw new Error(
        `validateBoundaries: boundary ${i} has non-positive duration ` +
        `(startMs=${b.startMs}, endMs=${b.endMs})`
      )
    }
  }

  for (let i = 0; i < boundaries.length - 1; i++) {
    const cur = boundaries[i]!
    const next = boundaries[i + 1]!
    if (next.startMs < cur.endMs) {
      throw new Error(
        `validateBoundaries: overlap between boundary ${i} (endMs=${cur.endMs}) ` +
        `and boundary ${i + 1} (startMs=${next.startMs})`
      )
    }
    const gap = next.startMs - cur.endMs
    if (gap > maxGapMs) {
      throw new Error(
        `validateBoundaries: gap of ${gap}ms between boundary ${i} and ${i + 1} ` +
        `exceeds maxGapMs=${maxGapMs}`
      )
    }
  }

  if (boundaries[0]!.startMs > introMaxStartMs) {
    throw new Error(
      `validateBoundaries: intro (boundary 0) starts at ${boundaries[0]!.startMs}ms, ` +
      `which exceeds introMaxStartMs=${introMaxStartMs}`
    )
  }

  const last = boundaries[boundaries.length - 1]!
  const required = opts.audioDurationMs * minCoverageRatio
  if (last.endMs < required) {
    throw new Error(
      `validateBoundaries: insufficient coverage — last boundary endMs=${last.endMs} ` +
      `covers less than ${(minCoverageRatio * 100).toFixed(0)}% of audio duration ${opts.audioDurationMs}ms`
    )
  }
}
