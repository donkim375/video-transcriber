import type { Utterance } from '../../src/types/index.js'

// Three sentences across two utterances, each word with a distinct start/end.
// Designed so chunker tests can assert per-sentence spans without ambiguity.
export const utterancesWithWords: Utterance[] = [
  {
    speaker: 'A',
    text: 'Hello world. This is a test.',
    startMs: 0,
    endMs: 4000,
    words: [
      { text: 'Hello',  startMs: 0,    endMs: 500 },
      { text: 'world.', startMs: 500,  endMs: 1000 },
      { text: 'This',   startMs: 1500, endMs: 2000 },
      { text: 'is',     startMs: 2000, endMs: 2300 },
      { text: 'a',      startMs: 2300, endMs: 2500 },
      { text: 'test.',  startMs: 2500, endMs: 4000 },
    ],
  },
  {
    speaker: 'A',
    text: 'Another sentence here.',
    startMs: 5000,
    endMs: 7000,
    words: [
      { text: 'Another',  startMs: 5000, endMs: 5800 },
      { text: 'sentence', startMs: 5800, endMs: 6500 },
      { text: 'here.',    startMs: 6500, endMs: 7000 },
    ],
  },
]
