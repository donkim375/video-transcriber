import type { Utterance } from '../../src/types/index.js'

export const sampleUtterances: Utterance[] = [
  { speaker: 'A', text: 'Welcome to the conference.', startMs: 0, endMs: 2000 },
  { speaker: 'A', text: 'Our first talk is by Alice.', startMs: 2000, endMs: 5000 },
  { speaker: 'B', text: 'Thanks. Today I will discuss vectors.', startMs: 5000, endMs: 9000 },
  { speaker: 'B', text: 'Vectors are arrays of numbers.', startMs: 9000, endMs: 13000 },
  { speaker: 'A', text: 'Next up, Bob on databases.', startMs: 13000, endMs: 16000 },
  { speaker: 'C', text: 'Databases store data persistently.', startMs: 16000, endMs: 20000 },
  { speaker: 'C', text: 'Indexes make queries fast.', startMs: 20000, endMs: 24000 },
]
