import { describe, it, expect, vi } from 'vitest'
import { searchChunksTool } from '../../../src/services/qa-tools/search-chunks.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const embeddings = { embed: vi.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) }
  return { pool: pool as any, embeddings: embeddings as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('search_chunks tool', () => {
  it('returns chunks with metadata and emits chunk citations', async () => {
    const ctx = makeCtx([
      { chunk_id: 'c1', text: 'about evals', talk_id: 't1', talk_title: 'T1', speaker: 'A',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 1000, end_ms: 2000, rrf_score: 0.5 },
      { chunk_id: 'c2', text: 'evals again', talk_id: 't1', talk_title: 'T1', speaker: 'A',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 3000, end_ms: 4000, rrf_score: 0.4 },
      { chunk_id: 'c3', text: 'evals elsewhere', talk_id: 't2', talk_title: 'T2', speaker: 'B',
        source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1000, rrf_score: 0.3 },
    ])
    const r = await searchChunksTool.execute({ query: 'evals' }, ctx)
    const json = r.json as any
    expect(json.chunks).toHaveLength(3)
    expect(r.sources[0]!.type).toBe('chunk')
    expect(r.sources[0]!.chunk_id).toBe('c1')
  })

  it('diversify:per_talk keeps highest-scoring chunk per talk', async () => {
    const ctx = makeCtx([
      { chunk_id: 'c1', text: 'a', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1, rrf_score: 0.9 },
      { chunk_id: 'c2', text: 'b', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v1', youtube_id: 'yt', start_ms: 2, end_ms: 3, rrf_score: 0.5 },
      { chunk_id: 'c3', text: 'c', talk_id: 't2', talk_title: 'T2', speaker: 'B', source_video_id: 'v1', youtube_id: 'yt', start_ms: 0, end_ms: 1, rrf_score: 0.7 },
    ])
    const r = await searchChunksTool.execute({ query: 'x', diversify: 'per_talk' }, ctx)
    const json = r.json as any
    expect(json.chunks).toHaveLength(2)
    expect(json.chunks.map((c: any) => c.chunk_id).sort()).toEqual(['c1', 'c3'])
  })

  it('k defaults to 8 and clamps to max 30', async () => {
    const ctx = makeCtx([])
    await searchChunksTool.execute({ query: 'x', k: 999 }, ctx)
    const call = (ctx.pool as any).query.mock.calls[0]
    expect(call[1][2]).toBe(30)   // match_count param
  })
})
