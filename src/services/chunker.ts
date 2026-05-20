import { encoding_for_model } from 'tiktoken'
import type { Utterance, Word } from '../types/index.js'

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

function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

interface AlignResult {
  startMs: number
  endMs: number
  nextCursor: number
}

function alignSentenceToWords(
  sentence: string,
  words: Word[],
  cursor: number,
): AlignResult | null {
  const sentenceTokens = sentence.split(/\s+/).map(normalize).filter(Boolean)
  if (sentenceTokens.length === 0 || cursor >= words.length) return null

  let startMs: number | null = null
  let endMs: number | null = null
  let matched = 0
  let i = cursor

  while (i < words.length && matched < sentenceTokens.length) {
    const w = normalize(words[i]!.text)
    if (w && w === sentenceTokens[matched]) {
      if (startMs === null) startMs = words[i]!.startMs
      endMs = words[i]!.endMs
      matched++
    }
    i++
  }

  if (startMs === null || endMs === null) return null
  // Require at least 50% of sentence tokens to have matched. Anything less is
  // likely a desync between utterance.text and utterance.words — fall back.
  if (matched * 2 < sentenceTokens.length) return null

  return { startMs, endMs, nextCursor: i }
}

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
      if (carryTokens + s.tokens > opts.overlapTokens) break
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
      let cursor = 0
      for (const s of sentences) {
        let startMs: number | null = u.startMs
        let endMs: number | null = u.endMs
        if (u.words && u.words.length > 0) {
          const aligned = alignSentenceToWords(s, u.words, cursor)
          if (aligned) {
            startMs = aligned.startMs
            endMs = aligned.endMs
            cursor = aligned.nextCursor
          }
        }
        items.push({ text: s, tokens: countTokens(s), startMs, endMs })
      }
    }
    return accumulate(items, opts)
  } finally {
    enc.free()
  }
}
