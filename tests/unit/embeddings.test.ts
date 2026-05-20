import { describe, it, expect, vi } from 'vitest'
import { OpenAIEmbeddingService } from '../../src/services/embeddings.js'

function fakeOpenAI(vectors: number[][]) {
  return {
    embeddings: {
      create: vi.fn(async ({ input }: { input: string[] }) => ({
        data: input.map((_, i) => ({ embedding: vectors[i] ?? vectors[0]! })),
      })),
    },
  }
}

describe('OpenAIEmbeddingService.embed', () => {
  it('returns embeddings in input order', async () => {
    const client = fakeOpenAI([[1, 2, 3], [4, 5, 6]])
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 100 })
    const result = await svc.embed(['a', 'b'])
    expect(result).toEqual([[1, 2, 3], [4, 5, 6]])
  })

  it('batches large inputs', async () => {
    const client = fakeOpenAI([[0.1]])
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 2 })
    await svc.embed(['a', 'b', 'c', 'd', 'e'])
    expect(client.embeddings.create).toHaveBeenCalledTimes(3)
  })

  it('returns empty array for empty input', async () => {
    const client = fakeOpenAI([[0.1]])
    const svc = new OpenAIEmbeddingService(client as any)
    await expect(svc.embed([])).resolves.toEqual([])
    expect(client.embeddings.create).not.toHaveBeenCalled()
  })
})
