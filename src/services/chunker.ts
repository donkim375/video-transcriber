import { encoding_for_model } from 'tiktoken'

export interface Chunk {
  chunkIndex: number
  text: string
  tokenCount: number
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

export function chunkText(text: string, opts: ChunkOptions): Chunk[] {
  const enc = encoding_for_model('text-embedding-3-small')
  const countTokens = (s: string) => enc.encode(s).length

  try {
    const sentences = splitSentences(text)
    const sentencesWithTokens = sentences.map((s) => ({ text: s, tokens: countTokens(s) }))

    const chunks: Chunk[] = []
    let buffer: typeof sentencesWithTokens = []
    let bufferTokens = 0

    const flush = () => {
      if (buffer.length === 0) return
      const chunkText = buffer.map((s) => s.text).join(' ')
      chunks.push({
        chunkIndex: chunks.length,
        text: chunkText,
        tokenCount: bufferTokens,
      })
    }

    const carryOverlap = () => {
      const carry: typeof sentencesWithTokens = []
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

    for (const s of sentencesWithTokens) {
      if (bufferTokens + s.tokens > opts.targetTokens && buffer.length > 0) {
        flush()
        carryOverlap()
      }
      buffer.push(s)
      bufferTokens += s.tokens
    }
    flush()

    return chunks
  } finally {
    enc.free()
  }
}
