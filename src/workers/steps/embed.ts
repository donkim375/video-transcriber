import type { StepContext } from '../types.js'
import type { Utterance } from '../../types/index.js'
import { updateSourceVideoStatus, insertChunk } from '../../db/queries.js'
import { chunkUtterances } from '../../services/chunker.js'

export interface EmbedInput {
  talks: { talkId: string; transcriptId: string; utterances: Utterance[] }[]
}

export async function runEmbed(ctx: StepContext, input: EmbedInput): Promise<void> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'embedding')

  for (const talk of input.talks) {
    const chunks = chunkUtterances(talk.utterances, { targetTokens: 400, overlapTokens: 50 })
    if (chunks.length === 0) continue
    const embeddings = await ctx.embeddings.embed(chunks.map((c) => c.text))
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i]!
      const e = embeddings[i]
      if (!e) throw new Error(`Missing embedding for chunk ${i}`)
      await insertChunk(ctx.pool, {
        talkId: talk.talkId,
        transcriptId: talk.transcriptId,
        chunkIndex: c.chunkIndex,
        text: c.text,
        startMs: c.startMs,
        endMs: c.endMs,
        tokenCount: c.tokenCount,
        embedding: e,
      })
    }
  }
}
