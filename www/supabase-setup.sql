-- =========================================================
-- WAVELENGTH — Supabase database setup
-- Paste this entire file into: Supabase Dashboard →
-- SQL Editor → New query → Run.
-- =========================================================

-- ---------------------------------------------------------
-- 1. SONGS  (the cloud music library)
-- ---------------------------------------------------------
create table if not exists public.songs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  youtube_id   text not null,
  youtube_url  text not null,
  title        text not null,
  artist       text not null default 'Unknown Artist',
  thumbnail    text,
  created_at   timestamptz not null default now(),

  -- prevents the same video being added twice by the same user
  constraint songs_user_youtube_unique unique (user_id, youtube_id)
);

alter table public.songs enable row level security;

create policy "Users can view their own songs"
  on public.songs for select
  using (auth.uid() = user_id);

create policy "Users can insert their own songs"
  on public.songs for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own songs"
  on public.songs for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own songs"
  on public.songs for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- 2. FAVORITES
-- ---------------------------------------------------------
create table if not exists public.favorites (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  song_id     uuid not null references public.songs(id) on delete cascade,
  created_at  timestamptz not null default now(),

  constraint favorites_user_song_unique unique (user_id, song_id)
);

alter table public.favorites enable row level security;

create policy "Users can view their own favorites"
  on public.favorites for select
  using (auth.uid() = user_id);

create policy "Users can insert their own favorites"
  on public.favorites for insert
  with check (auth.uid() = user_id);

create policy "Users can delete their own favorites"
  on public.favorites for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- 3. RECENTLY PLAYED
-- ---------------------------------------------------------
create table if not exists public.recently_played (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  song_id     uuid not null references public.songs(id) on delete cascade,
  played_at   timestamptz not null default now(),

  -- one row per (user, song); re-playing a song updates played_at
  -- via upsert instead of creating duplicate rows
  constraint recently_played_user_song_unique unique (user_id, song_id)
);

alter table public.recently_played enable row level security;

create policy "Users can view their own recently played"
  on public.recently_played for select
  using (auth.uid() = user_id);

create policy "Users can insert their own recently played"
  on public.recently_played for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own recently played"
  on public.recently_played for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "Users can delete their own recently played"
  on public.recently_played for delete
  using (auth.uid() = user_id);

-- ---------------------------------------------------------
-- 4. REALTIME (so a song added on one device appears on
--    another without a page refresh)
-- ---------------------------------------------------------
alter publication supabase_realtime add table public.songs;
alter publication supabase_realtime add table public.favorites;
alter publication supabase_realtime add table public.recently_played;

-- =========================================================
-- Done. Your database now has three tables — songs,
-- favorites, recently_played — each locked down so a user
-- can only see and change their own rows (auth.uid() = user_id).
-- =========================================================
