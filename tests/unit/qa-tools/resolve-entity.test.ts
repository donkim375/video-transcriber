import { describe, it, expect, vi } from 'vitest'
import { resolveEntityTool } from '../../../src/services/qa-tools/resolve-entity.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('resolve_entity tool', () => {
  it('returns candidates with confidence', async () => {
    const ctx = makeCtx([
      { talk_id: 't1', talk_title: 'Daytona Sandboxes', speaker: 'A', talk_index: 0, source_video_id: 'v1', confidence: 0.8 },
    ])
    const r = await resolveEntityTool.execute({ query: 'daytona' }, ctx)
    const json = r.json as any
    expect(json.candidates).toHaveLength(1)
    expect(json.candidates[0].confidence).toBeCloseTo(0.8)
    expect(r.sources).toEqual([])    // resolver itself doesn't emit citations
  })

  it('returns empty candidates on no match', async () => {
    const ctx = makeCtx([])
    const r = await resolveEntityTool.execute({ query: 'nothing' }, ctx)
    expect((r.json as any).candidates).toEqual([])
  })
})
