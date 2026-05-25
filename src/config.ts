import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  YOUTUBE_COOKIES_B64: z.string().optional(),
  CORS_ALLOWED_ORIGIN: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
  TRANSCRIPTION_POLL_TIMEOUT_MS: z.coerce.number().int().positive().default(7_200_000),
  NODE_ENV: z.string().default('development'),
})

export interface AppConfig {
  supabaseUrl?: string
  supabaseServiceRoleKey?: string
  databaseUrl: string
  assemblyaiApiKey: string
  openaiApiKey: string
  anthropicApiKey: string
  youtubeCookiesB64?: string
  corsAllowedOrigin: string
  port: number
  nodeEnv: string
  transcriptionPollTimeoutMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid config: ${issues}`)
  }
  const config: AppConfig = {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: parsed.data.SUPABASE_CONNECTION_STRING,
    assemblyaiApiKey: parsed.data.ASSEMBLYAI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    youtubeCookiesB64: parsed.data.YOUTUBE_COOKIES_B64,
    corsAllowedOrigin: parsed.data.CORS_ALLOWED_ORIGIN ?? 'http://localhost:3001',
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
    transcriptionPollTimeoutMs: parsed.data.TRANSCRIPTION_POLL_TIMEOUT_MS,
  }

  if (config.nodeEnv === 'production' && !config.youtubeCookiesB64) {
    throw new Error(
      'Invalid config: YOUTUBE_COOKIES_B64 is required in production ' +
      '(see docs/cloud-setup-tutorial.md Step 1.7)'
    )
  }
  if (config.nodeEnv === 'production' && !parsed.data.CORS_ALLOWED_ORIGIN) {
    throw new Error(
      'Invalid config: CORS_ALLOWED_ORIGIN is required in production ' +
      '(set it to the deployed frontend origin, e.g. https://your-app.vercel.app)'
    )
  }

  // Scrub secrets from process.env so npm packages loaded after this point cannot read them
  for (const key of [
    'ASSEMBLYAI_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY',
    'SUPABASE_CONNECTION_STRING', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY',
    'YOUTUBE_COOKIES_B64',
  ]) {
    delete process.env[key]
  }

  return config
}
