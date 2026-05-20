import { z } from 'zod'

const Schema = z.object({
  SUPABASE_URL: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_CONNECTION_STRING: z.string().min(1),
  ASSEMBLYAI_API_KEY: z.string().min(1),
  OPENAI_API_KEY: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1),
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
  port: number
  nodeEnv: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = Schema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new Error(`Invalid config: ${issues}`)
  }
  return {
    supabaseUrl: parsed.data.SUPABASE_URL,
    supabaseServiceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    databaseUrl: parsed.data.SUPABASE_CONNECTION_STRING,
    assemblyaiApiKey: parsed.data.ASSEMBLYAI_API_KEY,
    openaiApiKey: parsed.data.OPENAI_API_KEY,
    anthropicApiKey: parsed.data.ANTHROPIC_API_KEY,
    port: parsed.data.PORT,
    nodeEnv: parsed.data.NODE_ENV,
  }
}
