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

  it('throws when batchSize is < 1', () => {
    const client = fakeOpenAI([[0.1]])
    expect(() => new OpenAIEmbeddingService(client as any, { batchSize: 0 })).toThrow(/batchSize/)
  })
})

describe('OpenAIEmbeddingService retry behavior', () => {
  it('retries embeddings.create on transient 5xx, then succeeds', async () => {
    let n = 0
    const client = {
      embeddings: {
        create: vi.fn(async ({ input }: { input: string[] }) => {
          n += 1
          if (n === 1) {
            const err = new Error('transient') as Error & { status?: number }
            err.status = 503
            throw err
          }
          return { data: input.map(() => ({ embedding: [0.1] })) }
        }),
      },
    }
    const svc = new OpenAIEmbeddingService(client as any, { batchSize: 10 })
    const result = await svc.embed(['a', 'b'])
    expect(result).toEqual([[0.1], [0.1]])
    expect(client.embeddings.create).toHaveBeenCalledTimes(2)
  })

  it('does NOT retry embeddings.create on 400', async () => {
    const err = new Error('invalid input') as Error & { status?: number }
    err.status = 400
    const client = { embeddings: { create: vi.fn(async () => { throw err }) } }
    const svc = new OpenAIEmbeddingService(client as any)
    await expect(svc.embed(['a'])).rejects.toThrow('invalid input')
    expect(client.embeddings.create).toHaveBeenCalledTimes(1)
  })
})
