-- Supabase schema for twitter-web-exporter incremental sync (MVP)
-- This setup follows the project decisions:
-- - Browser client with anon key
-- - Upsert-only sync (no delete)
-- - Isolation key: twitter_user_id

create table if not exists public.synced_tweets (
  twitter_user_id text not null,
  rest_id text not null,
  source_updated_at bigint not null,
  payload jsonb not null,
  view_payload jsonb not null default '{}'::jsonb,
  synced_at timestamptz not null default now(),
  primary key (twitter_user_id, rest_id)
);

alter table public.synced_tweets
  add column if not exists view_payload jsonb not null default '{}'::jsonb;

create table if not exists public.synced_users (
  twitter_user_id text not null,
  rest_id text not null,
  source_updated_at bigint not null,
  payload jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (twitter_user_id, rest_id)
);

create table if not exists public.synced_captures (
  twitter_user_id text not null,
  capture_id text not null,
  extension text not null,
  capture_type text not null,
  data_key text not null,
  created_at bigint not null,
  sort_index text,
  payload jsonb not null,
  synced_at timestamptz not null default now(),
  primary key (twitter_user_id, capture_id)
);

create table if not exists public.sync_states (
  twitter_user_id text primary key,
  last_synced_at bigint not null default 0,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now()
);

create index if not exists synced_tweets_source_updated_at_idx
  on public.synced_tweets (twitter_user_id, source_updated_at);

create index if not exists synced_users_source_updated_at_idx
  on public.synced_users (twitter_user_id, source_updated_at);

create index if not exists synced_captures_created_at_idx
  on public.synced_captures (twitter_user_id, created_at);

-- RLS: MVP policy by twitter_user_id constraint only.
-- Note: this is intentionally simple and does not provide strong tenant authentication.
alter table public.synced_tweets enable row level security;
alter table public.synced_users enable row level security;
alter table public.synced_captures enable row level security;
alter table public.sync_states enable row level security;

drop policy if exists synced_tweets_anon_rw on public.synced_tweets;
create policy synced_tweets_anon_rw on public.synced_tweets
for all to anon
using (twitter_user_id <> '')
with check (twitter_user_id <> '');

drop policy if exists synced_users_anon_rw on public.synced_users;
create policy synced_users_anon_rw on public.synced_users
for all to anon
using (twitter_user_id <> '')
with check (twitter_user_id <> '');

drop policy if exists synced_captures_anon_rw on public.synced_captures;
create policy synced_captures_anon_rw on public.synced_captures
for all to anon
using (twitter_user_id <> '')
with check (twitter_user_id <> '');

drop policy if exists sync_states_anon_rw on public.sync_states;
create policy sync_states_anon_rw on public.sync_states
for all to anon
using (twitter_user_id <> '')
with check (twitter_user_id <> '');
