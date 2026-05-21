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

  it('accepts an optional YOUTUBE_COOKIES_B64 and exposes it on AppConfig', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.YOUTUBE_COOKIES_B64 = 'eyJjb29raWUiOiAiZGF0YSJ9'
    const { loadConfig } = await import('../../src/config.js')
    const cfg = loadConfig()
    expect(cfg.youtubeCookiesB64).toBe('eyJjb29raWUiOiAiZGF0YSJ9')
  })

  it('scrubs YOUTUBE_COOKIES_B64 from process.env after loading', async () => {
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    process.env.YOUTUBE_COOKIES_B64 = 'secret-cookie-value'
    const { loadConfig } = await import('../../src/config.js')
    loadConfig()
    expect(process.env.YOUTUBE_COOKIES_B64).toBeUndefined()
  })

  it('does not require YOUTUBE_COOKIES_B64 in development', async () => {
    process.env.NODE_ENV = 'development'
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.YOUTUBE_COOKIES_B64
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).not.toThrow()
  })

  it('throws when YOUTUBE_COOKIES_B64 missing in production', async () => {
    process.env.NODE_ENV = 'production'
    process.env.SUPABASE_CONNECTION_STRING = 'postgres://x'
    process.env.ASSEMBLYAI_API_KEY = 'a'
    process.env.OPENAI_API_KEY = 'o'
    process.env.ANTHROPIC_API_KEY = 'an'
    delete process.env.YOUTUBE_COOKIES_B64
    const { loadConfig } = await import('../../src/config.js')
    expect(() => loadConfig()).toThrow(/YOUTUBE_COOKIES_B64.*required.*production/i)
  })
})
