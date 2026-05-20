import OpenAI from 'openai'
import type { IEmbeddingService } from '../interfaces/embeddings.js'

type ClientLike = {
  embeddings: {
    create(p: { input: string[]; model: string }): Promise<{ data: { embedding: number[] }[] }>
  }
}

export interface EmbeddingOptions {
  model?: string
  batchSize?: number
}

export class OpenAIEmbeddingService implements IEmbeddingService {
  private model: string
  private batchSize: number

  constructor(private client: ClientLike, opts: EmbeddingOptions = {}) {
    this.model = opts.model ?? 'text-embedding-3-small'
    this.batchSize = opts.batchSize ?? 128
  }

  static fromApiKey(apiKey: string, opts: EmbeddingOptions = {}): OpenAIEmbeddingService {
    return new OpenAIEmbeddingService(new OpenAI({ apiKey }) as unknown as ClientLike, opts)
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize)
      const res = await this.client.embeddings.create({ input: batch, model: this.model })
      for (const item of res.data) out.push(item.embedding)
    }
    return out
  }
}
