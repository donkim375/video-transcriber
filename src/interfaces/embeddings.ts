export interface IEmbeddingService {
  embed(texts: string[]): Promise<number[][]>
}
