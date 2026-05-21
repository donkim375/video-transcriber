import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
  YOUTUBE_COOKIES_B64: z.string().optional(),
  PORT: z.coerce.number().int().positive().default(3000),
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
  port: number
  nodeEnv: string
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
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
  }

  if (config.nodeEnv === 'production' && !config.youtubeCookiesB64) {
    throw new Error(
      'Invalid config: YOUTUBE_COOKIES_B64 is required in production ' +
      '(see docs/cloud-setup-tutorial.md Step 1.7)'
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
