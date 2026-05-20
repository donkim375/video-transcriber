import type { ContentType } from '../types/index.js'

export const QUEUE_PIPELINE = 'video.pipeline'

export interface PipelineJobData {
  sourceVideoId: string
  youtubeUrl: string
  contentType: ContentType
}
