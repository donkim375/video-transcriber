import type { ILLMService, FaqItem } from '../../interfaces/llm.js'

export interface GenerateFaqsInput {
  llm: ILLMService
  videoTitle: string
  talks: Array<{ title: string; summary: string }>
}

export async function generateFaqsForVideo(input: GenerateFaqsInput): Promise<FaqItem[]> {
  if (input.talks.length === 0) return []
  return input.llm.generateFaqs({
    videoTitle: input.videoTitle,
    talks: input.talks,
  })
}
