import type { Utterance, TalkBoundary } from '../types/index.js'

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
