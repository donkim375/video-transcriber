import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/routes/**/*.test.ts', 'tests/smoke/**/*.test.ts'],
    exclude: ['tests/integration/**'],
    environment: 'node',
    testTimeout: 10_000,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
