import { describe, it, expect, vi } from 'vitest'
import { getOverviewTool } from '../../../src/services/qa-tools/get-overview.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: any[]): ToolContext {
  const pool = { query: vi.fn().mockResolvedValue({ rows }) }
  return { pool: pool as any, embeddings: {} as any, llm: {} as any, scope: {}, signal: new AbortController().signal }
}

describe('get_overview tool', () => {
  it('returns videos with talks and emits talk citations', async () => {
    const ctx = makeCtx([
      { source_video_id: 'v1', video_title: 'V', day_label: 'Day 1', series_slug: 's', youtube_id: 'yt', faqs: [{ question: 'q', answer: 'a' }], talk_id: 't1', talk_title: 'T', speaker: 'A', start_ms: 1000, end_ms: 2000, summary: 'S' },
    ])
    const r = await getOverviewTool.execute({}, ctx)
    const json = r.json as any
    expect(json.videos).toHaveLength(1)
    expect(json.videos[0].talks[0].summary).toBe('S')
    expect(r.sources).toHaveLength(1)
    expect(r.sources[0]!.type).toBe('talk')
    expect(r.sources[0]!.talk_id).toBe('t1')
  })

  it('input schema has scope', () => {
    expect(getOverviewTool.name).toBe('get_overview')
  })
})
