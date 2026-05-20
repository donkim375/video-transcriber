export interface VideoMetadata {
  title: string
  channel: string
  durationSeconds: number
  thumbnailUrl: string
  chapters: { title: string; startMs: number; endMs: number }[]
}

export interface Word {
  text: string
  startMs: number
  endMs: number
}

export interface Utterance {
  speaker: string
  text: string
  startMs: number
  endMs: number
  words?: Word[]
}

export interface TranscriptionResult {
  assemblyaiId: string
  rawText: string
  utterances: Utterance[]
}

export type TranscriptionStatusValue = 'queued' | 'processing' | 'completed' | 'error'

export interface TranscriptionStatus {
  id: string
  status: TranscriptionStatusValue
  errorMessage?: string
}

export interface TalkBoundary {
  title: string
  speaker: string
  startMs: number
  endMs: number
}

export type ContentType = 'single_speaker' | 'conference' | 'podcast_interview' | 'auto'

export const CONTENT_TYPES: ContentType[] = ['single_speaker', 'conference', 'podcast_interview', 'auto']
