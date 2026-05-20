import pg from 'pg'

const { Pool } = pg

let pool: pg.Pool | null = null

export function getPool(connectionString?: string): pg.Pool {
  if (pool) return pool
  const cs = connectionString ?? process.env.DATABASE_URL ?? process.env.SUPABASE_CONNECTION_STRING
  if (!cs) throw new Error('No database connection string configured')
  pool = new Pool({ connectionString: cs, max: 10 })
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}
