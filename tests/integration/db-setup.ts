import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const { Pool } = pg

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://test:test@localhost:54329/test'

export async function waitForPostgres(timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastErr: unknown
  while (Date.now() < deadline) {
    const probe = new Pool({ connectionString: TEST_DATABASE_URL, max: 1 })
    try {
      await probe.query('select 1')
      await probe.end()
      return
    } catch (e) {
      lastErr = e
      await probe.end().catch(() => {})
      await new Promise((r) => setTimeout(r, 500))
    }
  }
  throw new Error(`Postgres not ready after ${timeoutMs}ms: ${String(lastErr)}`)
}

export function startContainer(): void {
  execSync('docker compose -f docker-compose.test.yml up -d', { stdio: 'inherit' })
}

export async function applyMigrations(pool: pg.Pool): Promise<void> {
  for (const file of ['001_initial.sql', '002_content_type.sql']) {
    const sql = readFileSync(resolve(`src/db/migrations/${file}`), 'utf8')
    await pool.query(sql)
  }
}

export async function truncateAll(pool: pg.Pool): Promise<void> {
  await pool.query('truncate table chunks, transcripts, talks, source_videos restart identity cascade')
}

export function makeTestPool(): pg.Pool {
  return new Pool({ connectionString: TEST_DATABASE_URL, max: 5 })
}
