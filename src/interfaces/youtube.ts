import type { VideoMetadata } from '../types/index.js'

export interface IYouTubeService {
  getMetadata(url: string): Promise<VideoMetadata>
  downloadAudio(url: string, outputPath: string): Promise<void>
}
