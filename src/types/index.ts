export interface Utterance {
  speaker: string
  text: string
  startMs: number
  endMs: number
}

export interface TalkBoundary {
  title: string
  speaker: string
  startMs: number
  endMs: number
}
