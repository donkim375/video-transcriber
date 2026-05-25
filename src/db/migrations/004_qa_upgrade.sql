-- Extensions
create extension if not exists pg_trgm;

-- Series grouping
alter table source_videos add column series_slug text;
create index if not exists source_videos_series_slug_idx on source_videos(series_slug);

-- Resolver indexes
create index if not exists talks_title_trgm_idx on talks using gin(title gin_trgm_ops);
create index if not exists talks_speaker_lower_idx on talks(lower(speaker));
create index if not exists talks_speaker_trgm_idx on talks using gin(speaker gin_trgm_ops);

-- Replace match_chunks (no backward-compat shim)
drop function if exists match_chunks(vector, int, uuid);
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int,
  filter_talk_id uuid,
  filter_source_video_ids uuid[],
  filter_series_slug text,
  filter_speaker text
)
returns table(
  chunk_id uuid, text text, talk_id uuid, talk_title text, speaker text,
  source_video_id uuid, youtube_id text, start_ms int, end_ms int, similarity float
)
language sql stable
as $$
  select c.id, c.text, c.talk_id, t.title, t.speaker,
         sv.id, sv.youtube_id, c.start_ms, c.end_ms,
         1 - (c.embedding <=> query_embedding) as similarity
    from chunks c
    join talks t on t.id = c.talk_id
    join source_videos sv on sv.id = t.source_video_id
   where (filter_talk_id is null or c.talk_id = filter_talk_id)
     and (filter_source_video_ids is null or sv.id = any(filter_source_video_ids))
     and (filter_series_slug is null or sv.series_slug = filter_series_slug)
     and (filter_speaker is null or t.speaker ilike '%' || filter_speaker || '%')
   order by c.embedding <=> query_embedding
   limit match_count;
$$;

-- Hybrid search with scope filters
create or replace function search_chunks_hybrid(
  query_text text,
  query_embedding vector(1536),
  match_count int,
  filter_talk_id uuid,
  filter_source_video_ids uuid[],
  filter_series_slug text,
  filter_speaker text
)
returns table(
  chunk_id uuid, text text, talk_id uuid, talk_title text, speaker text,
  source_video_id uuid, youtube_id text, start_ms int, end_ms int, rrf_score float
)
language sql stable
as $$
  with scope as (
    select c.id, c.text, c.talk_id, c.start_ms, c.end_ms, c.embedding,
           t.title as talk_title, t.speaker, sv.id as source_video_id, sv.youtube_id
      from chunks c
      join talks t on t.id = c.talk_id
      join source_videos sv on sv.id = t.source_video_id
     where (filter_talk_id is null or c.talk_id = filter_talk_id)
       and (filter_source_video_ids is null or sv.id = any(filter_source_video_ids))
       and (filter_series_slug is null or sv.series_slug = filter_series_slug)
       and (filter_speaker is null or t.speaker ilike '%' || filter_speaker || '%')
  ),
  dense as (
    select id, row_number() over (order by embedding <=> query_embedding) as r
      from scope order by embedding <=> query_embedding
      limit least(match_count * 3, 90)
  ),
  kw as (
    select id, row_number() over (
             order by ts_rank(to_tsvector('english', text), plainto_tsquery('english', query_text)) desc
           ) as r
      from scope
     where to_tsvector('english', text) @@ plainto_tsquery('english', query_text)
     limit least(match_count * 3, 90)
  ),
  fused as (
    select id, sum(1.0 / (60 + r)) as rrf
      from (select id, r from dense union all select id, r from kw) u
     group by id
  )
  select s.id, s.text, s.talk_id, s.talk_title, s.speaker,
         s.source_video_id, s.youtube_id, s.start_ms, s.end_ms, f.rrf
    from fused f join scope s on s.id = f.id
   order by f.rrf desc
   limit match_count;
$$;
