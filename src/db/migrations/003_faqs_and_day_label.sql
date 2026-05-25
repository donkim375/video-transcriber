-- src/db/migrations/003_faqs_and_day_label.sql
alter table source_videos
  add column if not exists faqs jsonb,
  add column if not exists day_label text;
