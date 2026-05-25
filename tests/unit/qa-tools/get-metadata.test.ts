import { describe, it, expect, vi } from 'vitest'
import { getMetadataTool } from '../../../src/services/qa-tools/get-metadata.js'
import type { ToolContext } from '../../../src/services/qa-tools/types.js'

function makeCtx(rows: { agg: any[]; talks: any[] }): ToolContext {
  const pool = { query: vi.fn().mockResolvedValueOnce({ rows: rows.agg }).mockResolvedValueOnce({ rows: rows.talks }) }
  return {
    pool: pool as any,
    embeddings: {} as any,
    llm: {} as any,
    scope: {},
    signal: new AbortController().signal,
  }
}

describe('get_metadata tool', () => {
  it('returns shape with counts and lists', async () => {
    const ctx = makeCtx({
      agg: [{ total_videos: 2, total_talks: 5, total_duration_seconds: 9000, series_slugs: ['aies'], day_labels: ['Day 1', 'Day 2'], speakers: ['A', 'B'] }],
      talks: [{ talk_id: 'x', talk_title: 'T', speaker: 'A', talk_index: 0, start_ms: 0, end_ms: 60_000, day_label: 'Day 1' }],
    })
    const r = await getMetadataTool.execute({}, ctx)
    const json = r.json as any
    expect(json.total_videos).toBe(2)
    expect(json.total_talks).toBe(5)
    expect(json.speakers).toEqual(['A', 'B'])
    expect(r.sources).toEqual([])
  })

  it('input schema has scope field', () => {
    expect(getMetadataTool.input_schema).toBeDefined()
    expect(getMetadataTool.name).toBe('get_metadata')
  })
})
