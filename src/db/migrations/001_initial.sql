-- src/db/migrations/001_initial.sql
create extension if not exists vector;

create table if not exists source_videos (
  id              uuid primary key default gen_random_uuid(),
  youtube_url     text not null unique,
  youtube_id      text not null unique,
  title           text,
  channel         text,
  duration_seconds int,
  thumbnail_url   text,
  has_chapters    boolean default false,
  status          text not null default 'pending',
  error_message   text,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table if not exists talks (
  id              uuid primary key default gen_random_uuid(),
  source_video_id uuid not null references source_videos(id) on delete cascade,
  title           text,
  speaker         text,
  conference      text,
  talk_index      int not null,
  start_ms        int not null,
  end_ms          int not null,
  youtube_deep_link text,
  created_at      timestamptz default now()
);

create table if not exists transcripts (
  id              uuid primary key default gen_random_uuid(),
  talk_id         uuid not null references talks(id) on delete cascade,
  assemblyai_id   text unique,
  raw_text        text,
  utterances      jsonb,
  summary         text,
  created_at      timestamptz default now()
);

create table if not exists chunks (
  id              uuid primary key default gen_random_uuid(),
  talk_id         uuid not null references talks(id) on delete cascade,
  transcript_id   uuid not null references transcripts(id) on delete cascade,
  chunk_index     int not null,
  text            text not null,
  start_ms        int,
  end_ms          int,
  token_count     int,
  embedding       vector(1536),
  created_at      timestamptz default now()
);

create index if not exists chunks_fts_idx on chunks using gin(to_tsvector('english', text));
create index if not exists chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64);
create index if not exists talks_source_video_id_idx on talks(source_video_id);
create index if not exists chunks_talk_id_idx on chunks(talk_id);
create index if not exists transcripts_talk_id_idx on transcripts(talk_id);

create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int,
  filter_talk_id uuid default null
)
returns table(id uuid, text text, talk_id uuid, start_ms int, end_ms int, similarity float)
language sql stable
as $$
  select
    chunks.id,
    chunks.text,
    chunks.talk_id,
    chunks.start_ms,
    chunks.end_ms,
    1 - (chunks.embedding <=> query_embedding) as similarity
  from chunks
  where (filter_talk_id is null or chunks.talk_id = filter_talk_id)
  order by chunks.embedding <=> query_embedding
  limit match_count;
$$;
