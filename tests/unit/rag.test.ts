import { describe, it, expect } from 'vitest'
import { reciprocalRankFusion, buildRagContext } from '../../src/services/rag.js'

describe('reciprocalRankFusion', () => {
  it('merges keyword and vector results with RRF', () => {
    const keyword = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const vector = [{ id: 'b' }, { id: 'd' }, { id: 'a' }]
    const merged = reciprocalRankFusion([keyword, vector], { k: 60 })
    expect(merged[0]!.id).toBe('b')
    expect(merged.map((r) => r.id)).toContain('a')
    expect(merged.map((r) => r.id)).toContain('d')
  })

  it('deduplicates by id', () => {
    const merged = reciprocalRankFusion([[{ id: 'x' }], [{ id: 'x' }]], { k: 60 })
    expect(merged).toHaveLength(1)
  })

  it('returns empty list for empty inputs', () => {
    expect(reciprocalRankFusion([], { k: 60 })).toEqual([])
    expect(reciprocalRankFusion([[]], { k: 60 })).toEqual([])
  })
})

describe('buildRagContext', () => {
  it('formats chunks with talk metadata and chunk ids', () => {
    const ctx = buildRagContext([
      { id: 'c1', text: 'First chunk.', talkTitle: 'Alice', speaker: 'A', startMs: 1000 },
      { id: 'c2', text: 'Second chunk.', talkTitle: 'Bob', speaker: 'B', startMs: 5000 },
    ])
    expect(ctx).toContain('[chunk:c1]')
    expect(ctx).toContain('Alice')
    expect(ctx).toContain('First chunk.')
    expect(ctx).toContain('[chunk:c2]')
  })
})
