import { describe, it, expect, vi } from 'vitest'
import { synthesizeAcrossTalksTool } from '../../../src/services/qa-tools/synthesize-across-talks.js'
import { MockLLMService } from '../../mocks/llm.mock.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[], llm: MockLLMService): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  const embeddings = { embed: vi.fn().mockResolvedValue([[0.1]]) }
  return { pool: pool as any, embeddings: embeddings as any, llm: llm as any, scope: {}, signal: new AbortController().signal }
}

describe('synthesize_across_talks tool', () => {
  it('groups chunks by talk and calls mini-summary per talk', async () => {
    const llm = new MockLLMService()
    const ctx = makeCtx(
      [
        { chunk_id: 'c1', text: 'one', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 0.9 },
        { chunk_id: 'c2', text: 'two', talk_id: 't1', talk_title: 'T1', speaker: 'A', source_video_id: 'v', youtube_id: 'y', start_ms: 2, end_ms: 3, rrf_score: 0.8 },
        { chunk_id: 'c3', text: 'three', talk_id: 't2', talk_title: 'T2', speaker: 'B', source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 0.7 },
      ],
      llm
    )
    const r = await synthesizeAcrossTalksTool.execute({ idea: 'X' }, ctx)
    const json = r.json as any
    expect(json.per_talk_evidence).toHaveLength(2)
    expect(json.per_talk_evidence[0].talk_id).toBe('t1')
    expect(json.per_talk_evidence[0].evidence_chunks.length).toBeGreaterThan(0)
    expect(json.per_talk_evidence[0].mini_summary).toContain('Synth')
    expect(llm.synthCalls).toHaveLength(2)
    expect(r.sources.length).toBeGreaterThan(0)
  })

  it('caps at 8 talks', async () => {
    const llm = new MockLLMService()
    const rows = Array.from({ length: 12 }, (_, i) => ({
      chunk_id: `c${i}`, text: 'x', talk_id: `t${i}`, talk_title: `T${i}`, speaker: 'A',
      source_video_id: 'v', youtube_id: 'y', start_ms: 0, end_ms: 1, rrf_score: 1 - i * 0.01,
    }))
    const ctx = makeCtx(rows, llm)
    const r = await synthesizeAcrossTalksTool.execute({ idea: 'X' }, ctx)
    expect((r.json as any).per_talk_evidence).toHaveLength(8)
    expect((r.json as any).talks_returned).toBe(8)
    expect((r.json as any).talks_considered).toBe(12)
  })
})
