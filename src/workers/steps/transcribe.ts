import { unlinkSync, existsSync } from 'node:fs'
import type { StepContext } from '../types.js'
import type { TranscriptionResult } from '../../types/index.js'
import { updateSourceVideoStatus } from '../../db/queries.js'

export interface TranscribeInput {
  audioPath: string
}

export async function runTranscribe(
  ctx: StepContext,
  input: TranscribeInput
): Promise<TranscriptionResult> {
  await updateSourceVideoStatus(ctx.pool, ctx.sourceVideoId, 'transcribing')
  const { assemblyaiId } = await ctx.transcription.submit(input.audioPath)
  await ctx.pool.query(
    `update source_videos set updated_at = now() where id = $1`,
    [ctx.sourceVideoId]
  )

  const interval = ctx.pollIntervalMs ?? 2000
  const timeout = ctx.pollTimeoutMs ?? 30 * 60 * 1000
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const status = await ctx.transcription.getStatus(assemblyaiId)
    if (status.status === 'completed') break
    if (status.status === 'error') {
      throw new Error(`Transcription failed: ${status.errorMessage ?? 'unknown'}`)
    }
    await new Promise((r) => setTimeout(r, interval))
  }

  const result = await ctx.transcription.getResult(assemblyaiId)
  if (existsSync(input.audioPath)) {
    try { unlinkSync(input.audioPath) } catch { /* fine */ }
  }
  return result
}
