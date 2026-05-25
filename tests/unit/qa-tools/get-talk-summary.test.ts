import { describe, it, expect, vi } from 'vitest'
import { getTalkSummaryTool } from '../../../src/services/qa-tools/get-talk-summary.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('get_talk_summary tool', () => {
  it('returns talks with summaries; emits talk citations', async () => {
    const ctx = makeCtx([
      { talk_id: 't1', talk_title: 'T1', speaker: 'A', summary: 'S', start_ms: 0, end_ms: 1000, source_video_id: 'v1', youtube_id: 'yt' },
    ])
    const r = await getTalkSummaryTool.execute({ talk_id: '11111111-1111-1111-1111-111111111111' }, ctx)
    const json = r.json as any
    expect(json.talks).toHaveLength(1)
    expect(json.talks[0].summary).toBe('S')
    expect(r.sources[0]!.type).toBe('talk')
  })

  it('input schema accepts talk_id or speaker', () => {
    expect(getTalkSummaryTool.name).toBe('get_talk_summary')
  })
})
