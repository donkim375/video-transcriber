/**
 * scripts/backfill-faqs.ts
 *
 * One-off script to populate source_videos.faqs for videos that reached
 * 'ready' before the FAQ pipeline step existed.
 *
 * Usage:
 *   npm run build && node dist/scripts/backfill-faqs.js
 *
 * Side effects:
 *   - Calls Anthropic Claude for each ready video missing faqs
 *   - Updates source_videos.faqs in Postgres
 *
 * Run twice safely — videos with non-null faqs are skipped.
 */
import { Pool } from 'pg'
import { loadConfig } from '../src/config.js'
import { ClaudeLLMService } from '../src/services/llm.js'
import { generateFaqsForVideo } from '../src/workers/steps/generate-faqs.js'
import {
  listTalksForVideo,
  getTranscriptByTalkId,
  setSourceVideoFaqs,
} from '../src/db/queries.js'

async function main(): Promise<void> {
  const cfg = loadConfig()
  const pool = new Pool({ connectionString: cfg.databaseUrl })
  const llm = ClaudeLLMService.fromApiKey(cfg.anthropicApiKey)

  const { rows } = await pool.query(
    `select id, title from source_videos where status = 'ready' and faqs is null`
  )
  if (rows.length === 0) {
    console.log('No videos require FAQ backfill.')
    await pool.end()
    return
  }

  for (const v of rows) {
    console.log(`Generating FAQs for ${v.id} (${v.title})...`)
    const talks = await listTalksForVideo(pool, v.id)
    const summaries: Array<{ title: string; summary: string }> = []
    for (const t of talks) {
      const tr = await getTranscriptByTalkId(pool, t.id)
      summaries.push({ title: t.title ?? '', summary: tr?.summary ?? '' })
    }
    const faqs = await generateFaqsForVideo({
      llm,
      videoTitle: v.title ?? 'Untitled',
      talks: summaries,
    })
    if (faqs.length > 0) {
      await setSourceVideoFaqs(pool, v.id, faqs)
      console.log(`  → wrote ${faqs.length} FAQs`)
    } else {
      console.log('  → skipped (no talks)')
    }
  }

  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
