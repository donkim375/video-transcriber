import { encoding_for_model } from 'tiktoken'
import type { Utterance } from '../types/index.js'

export interface Chunk {
  chunkIndex: number
  text: string
  tokenCount: number
}

export interface TimedChunk extends Chunk {
  startMs: number | null
  endMs: number | null
}

export interface ChunkOptions {
  targetTokens: number
  overlapTokens: number
}

const SENTENCE_RE = /[^.!?]+[.!?]+(?:\s+|$)/g

function splitSentences(text: string): string[] {
  const matches = text.match(SENTENCE_RE)
  if (matches && matches.length > 0) return matches.map((s) => s.trim()).filter(Boolean)
  return [text.trim()].filter(Boolean)
}

interface TimedSentence {
  text: string
  tokens: number
  startMs: number | null
  endMs: number | null
}

function accumulate(
  items: TimedSentence[],
  opts: ChunkOptions
): TimedChunk[] {
  const chunks: TimedChunk[] = []
  let buffer: TimedSentence[] = []
  let bufferTokens = 0

  const chunkTimespan = (b: TimedSentence[]): { startMs: number | null; endMs: number | null } => {
    let minStart: number | null = null
    let maxEnd: number | null = null
    for (const s of b) {
      if (s.startMs !== null && (minStart === null || s.startMs < minStart)) minStart = s.startMs
      if (s.endMs !== null && (maxEnd === null || s.endMs > maxEnd)) maxEnd = s.endMs
    }
    return { startMs: minStart, endMs: maxEnd }
  }

  const flush = () => {
    if (buffer.length === 0) return
    const text = buffer.map((s) => s.text).join(' ')
    const { startMs, endMs } = chunkTimespan(buffer)
    chunks.push({ chunkIndex: chunks.length, text, tokenCount: bufferTokens, startMs, endMs })
  }

  const carryOverlap = () => {
    const carry: TimedSentence[] = []
    let carryTokens = 0
    for (let i = buffer.length - 1; i >= 0; i--) {
      const s = buffer[i]!
      if (carryTokens + s.tokens > opts.overlapTokens && carry.length > 0) break
      carry.unshift(s)
      carryTokens += s.tokens
    }
    buffer = carry
    bufferTokens = carryTokens
  }

  for (const s of items) {
    if (bufferTokens + s.tokens > opts.targetTokens && buffer.length > 0) {
      flush()
      carryOverlap()
    }
    buffer.push(s)
    bufferTokens += s.tokens
  }
  flush()

  return chunks
}

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const enc = encoding_for_model('text-embedding-3-small')
  const countTokens = (s: string) => enc.encode(s).length
  try {
    const items: TimedSentence[] = splitSentences(text).map((s) => ({
      text: s,
      tokens: countTokens(s),
      startMs: null,
      endMs: null,
    }))
    return accumulate(items, opts).map(({ chunkIndex, text, tokenCount }) => ({
      chunkIndex,
      text,
      tokenCount,
    }))
  } finally {
    enc.free()
  }
}

// Utterance-aware variant: each sentence inherits the timestamps of the utterance
// it came from. Chunk timestamps are min(startMs) and max(endMs) over the chunk's sentences.
export function chunkUtterances(utterances: Utterance[], opts: ChunkOptions): TimedChunk[] {
  const enc = encoding_for_model('text-embedding-3-small')
  const countTokens = (s: string) => enc.encode(s).length
  try {
    const items: TimedSentence[] = []
    for (const u of utterances) {
      const sentences = splitSentences(u.text)
      for (const s of sentences) {
        items.push({ text: s, tokens: countTokens(s), startMs: u.startMs, endMs: u.endMs })
      }
    }
    return accumulate(items, opts)
  } finally {
    enc.free()
  }
}
