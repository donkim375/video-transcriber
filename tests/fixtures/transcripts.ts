export const shortTranscript =
  'Welcome to the conference. Our first talk is by Alice. Thanks. Today I will discuss vectors. Vectors are arrays of numbers.'

export const longTranscript = Array.from({ length: 50 }, (_, i) =>
  `Sentence number ${i} discussing topic ${i % 5}.`
).join(' ')
