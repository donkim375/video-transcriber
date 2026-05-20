import { describe, it, expect, beforeEach, afterEach } from 'vitest'

describe('loadConfig', () => {
  const orig = { ...process.env }
  beforeEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, orig)
  })
  afterEach(() => {
    for (const k of Object.keys(process.env)) delete process.env[k]
    Object.assign(process.env, orig)
  })

  it('throws when ASSEMBLYAI_API_KEY missing', async () => {
    delete process.env.ASSEMBLYAI_API_KEY
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/ASSEMBLYAI_API_KEY/)
  })

  it('returns parsed config when all required env present', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.PORT = '3000'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.assemblyaiApiKey).toBe('a')
    expect(cfg.port).toBe(3000)
  })
})
