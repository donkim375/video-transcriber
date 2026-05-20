export interface RankedItem {
  id: string
  [k: string]: unknown
}

export function reciprocalRankFusion<T extends RankedItem>(
  lists: T[][],
  opts: { k: number }
): T[] {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    list.forEach((item, idx) => {
      const score = 1 / (opts.k + idx + 1)
      const existing = scores.get(item.id)
      if (existing) existing.score += score
      else scores.set(item.id, { item, score })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item)
}

export interface ChunkForContext {
  id: string
  text: string
  talkTitle: string
  speaker: string
  startMs: number
}

export function buildRagContext(chunks: ChunkForContext[]): string {
  return chunks
    .map((c) => {
      const ts = `${Math.floor(c.startMs / 1000)}s`
      return `[chunk:${c.id}] (Talk: "${c.talkTitle}" by ${c.speaker} @ ${ts})\n${c.text}`
    })
    .join('\n\n')
}
