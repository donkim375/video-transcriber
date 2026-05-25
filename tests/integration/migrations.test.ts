import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import {
  startContainer,
  waitForPostgres,
  makeTestPool,
  applyMigrations,
} from './db-setup.js'

const pool = makeTestPool()

beforeAll(async () => {
  startContainer()
  await waitForPostgres()
  await pool.query('drop schema public cascade; create schema public;')
  await applyMigrations(pool)
}, 90_000)

afterAll(async () => {
  await pool.end()
})

describe('migrations', () => {
  it('creates all expected tables', async () => {
    const { rows } = await pool.query(
      `select table_name from information_schema.tables where table_schema='public' order by table_name`
    )
    const names = rows.map((r) => r.table_name)
    expect(names).toContain('source_videos')
    expect(names).toContain('talks')
    expect(names).toContain('transcripts')
    expect(names).toContain('chunks')
  })

  it('creates the match_chunks function', async () => {
    const { rows } = await pool.query(
      `select proname from pg_proc where proname='match_chunks'`
    )
    expect(rows).toHaveLength(1)
  })

  it('creates hnsw index on chunks.embedding', async () => {
    const { rows } = await pool.query(
      `select indexname from pg_indexes where tablename='chunks' and indexname='chunks_embedding_idx'`
    )
    expect(rows).toHaveLength(1)
  })

  it('enables pgvector extension', async () => {
    const { rows } = await pool.query(`select extname from pg_extension where extname='vector'`)
    expect(rows).toHaveLength(1)
  })

  it('enables pg_trgm extension', async () => {
    const { rows } = await pool.query(`select extname from pg_extension where extname='pg_trgm'`)
    expect(rows).toHaveLength(1)
  })

  it('adds series_slug column to source_videos', async () => {
    const { rows } = await pool.query(
      `select column_name from information_schema.columns where table_name='source_videos' and column_name='series_slug'`
    )
    expect(rows).toHaveLength(1)
  })

  it('replaces match_chunks with new 6-arg signature', async () => {
    const { rows } = await pool.query(
      `select to_regprocedure('match_chunks(vector,int,uuid,uuid[],text,text)') as sig`
    )
    expect(rows[0]?.sig).not.toBeNull()
  })

  it('creates search_chunks_hybrid function', async () => {
    const { rows } = await pool.query(
      `select to_regprocedure('search_chunks_hybrid(text,vector,int,uuid,uuid[],text,text)') as sig`
    )
    expect(rows[0]?.sig).not.toBeNull()
  })
})
