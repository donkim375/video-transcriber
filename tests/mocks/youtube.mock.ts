import type { IYouTubeService } from '../../src/interfaces/youtube.js'
import type { VideoMetadata } from '../../src/types/index.js'

export class MockYouTubeService implements IYouTubeService {
  public downloads: { url: string; outputPath: string }[] = []
  constructor(private metadata: VideoMetadata) {}

  async getMetadata(_url: string): Promise<VideoMetadata> {
    return this.metadata
  }

  async downloadAudio(url: string, outputPath: string): Promise<void> {
    this.downloads.push({ url, outputPath })
  }
}
