-- src/db/migrations/002_content_type.sql
alter table source_videos
  add column if not exists content_type text not null default 'auto';

-- Enforce the allowed values at the DB level; expand here when strategies are added.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'source_videos_content_type_check'
  ) then
    alter table source_videos
      add constraint source_videos_content_type_check
      check (content_type in ('single_speaker', 'conference', 'podcast_interview', 'auto'));
  end if;
end$$;
