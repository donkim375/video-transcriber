import type { StepContext } from '../types.js'
import { updateSourceVideoStatus, updateTranscriptSummary } from '../../db/queries.js'

export interface SummarizeInput {
  talks: { talkId: string; transcriptId: string; text: string }[]
}

export async function runSummarize(ctx: StepContext, input: SummarizeInput): Promise<void> {
  for (const t of input.talks) {
    const summary = await ctx.llm.summarizeTalk(t.text)
    await updateTranscriptSummary(ctx.pool, t.transcriptId, summary)
  }
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'ready')
}
