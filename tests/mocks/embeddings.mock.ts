import type { IEmbeddingService } from '../../src/interfaces/embeddings.js'

export class MockEmbeddingService implements IEmbeddingService {
  public batches: string[][] = []
  constructor(private dimensions = 1536) {}

  async embed(texts: string[]): Promise<number[][]> {
    this.batches.push(texts)
    return texts.map((t) => {
      const seed = t.length || 1
      return Array.from({ length: this.dimensions }, (_, i) => ((seed * (i + 1)) % 1000) / 1000)
    })
  }
}
