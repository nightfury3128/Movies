create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  avatar_url text,
  is_child boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, name)
);

create table if not exists public.playback_state (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  content_type text not null check (content_type in ('movie', 'show', 'episode', 'anime')),
  tmdb_id bigint not null,
  season_number integer,
  episode_number integer,
  current_time_seconds integer not null default 0 check (current_time_seconds >= 0),
  duration_seconds integer not null default 0 check (duration_seconds >= 0),
  percent_complete numeric not null default 0 check (percent_complete >= 0 and percent_complete <= 100),
  last_watched_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, content_type, tmdb_id, season_number, episode_number)
);

create table if not exists public.watch_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  content_type text not null check (content_type in ('movie', 'show', 'episode', 'anime')),
  tmdb_id bigint not null,
  season_number integer,
  episode_number integer,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  watch_time_seconds integer not null default 0 check (watch_time_seconds >= 0),
  completion_percentage numeric not null default 0 check (completion_percentage >= 0 and completion_percentage <= 100),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  tmdb_id bigint not null,
  content_type text not null check (content_type in ('movie', 'show', 'episode', 'anime')),
  added_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, tmdb_id, content_type)
);

create table if not exists public.favorites (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  tmdb_id bigint not null,
  content_type text not null check (content_type in ('movie', 'show', 'episode', 'anime')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, tmdb_id, content_type)
);

create table if not exists public.user_settings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade unique,
  theme text not null default 'dark',
  autoplay boolean not null default true,
  default_quality text not null default 'Optimized',
  subtitles_enabled boolean not null default false,
  preferred_language text not null default 'en',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.watch_sessions (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  tmdb_id bigint not null,
  content_type text not null check (content_type in ('movie', 'show', 'episode', 'anime')),
  session_start timestamptz not null default now(),
  session_end timestamptz,
  watch_time_seconds integer not null default 0 check (watch_time_seconds >= 0),
  average_quality text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.search_history (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade,
  query text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profile_preferences (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.user_profiles(id) on delete cascade unique,
  favorite_genres jsonb not null default '[]'::jsonb,
  favorite_languages jsonb not null default '[]'::jsonb,
  favorite_categories jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists playback_state_profile_last_watched_idx on public.playback_state(profile_id, last_watched_at desc);
create index if not exists watch_history_profile_created_idx on public.watch_history(profile_id, created_at desc);
create index if not exists watch_sessions_profile_created_idx on public.watch_sessions(profile_id, created_at desc);
create index if not exists search_history_profile_created_idx on public.search_history(profile_id, created_at desc);

drop trigger if exists user_profiles_updated_at on public.user_profiles;
create trigger user_profiles_updated_at before update on public.user_profiles for each row execute function public.set_updated_at();

drop trigger if exists playback_state_updated_at on public.playback_state;
create trigger playback_state_updated_at before update on public.playback_state for each row execute function public.set_updated_at();

drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at before update on public.user_settings for each row execute function public.set_updated_at();

drop trigger if exists profile_preferences_updated_at on public.profile_preferences;
create trigger profile_preferences_updated_at before update on public.profile_preferences for each row execute function public.set_updated_at();

drop trigger if exists watch_history_updated_at on public.watch_history;
create trigger watch_history_updated_at before update on public.watch_history for each row execute function public.set_updated_at();

drop trigger if exists watchlists_updated_at on public.watchlists;
create trigger watchlists_updated_at before update on public.watchlists for each row execute function public.set_updated_at();

drop trigger if exists favorites_updated_at on public.favorites;
create trigger favorites_updated_at before update on public.favorites for each row execute function public.set_updated_at();

drop trigger if exists watch_sessions_updated_at on public.watch_sessions;
create trigger watch_sessions_updated_at before update on public.watch_sessions for each row execute function public.set_updated_at();

drop trigger if exists search_history_updated_at on public.search_history;
create trigger search_history_updated_at before update on public.search_history for each row execute function public.set_updated_at();

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  default_name text;
  created_profile_id uuid;
begin
  default_name := coalesce(new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1), 'Viewer');

  insert into public.user_profiles (user_id, name)
  values (new.id, default_name)
  returning id into created_profile_id;

  insert into public.user_settings (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  insert into public.profile_preferences (profile_id)
  values (created_profile_id)
  on conflict (profile_id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.owns_profile(target_profile_id uuid)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.user_profiles
    where id = target_profile_id
      and user_id = auth.uid()
  );
$$;

create or replace function public.trim_search_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.search_history
  where profile_id = new.profile_id
    and id not in (
      select id
      from public.search_history
      where profile_id = new.profile_id
      order by created_at desc
      limit 100
    );
  return new;
end;
$$;

drop trigger if exists search_history_limit on public.search_history;
create trigger search_history_limit
  after insert on public.search_history
  for each row execute function public.trim_search_history();

alter table public.user_profiles enable row level security;
alter table public.playback_state enable row level security;
alter table public.watch_history enable row level security;
alter table public.watchlists enable row level security;
alter table public.favorites enable row level security;
alter table public.user_settings enable row level security;
alter table public.watch_sessions enable row level security;
alter table public.search_history enable row level security;
alter table public.profile_preferences enable row level security;

drop policy if exists "Users manage own profiles" on public.user_profiles;
create policy "Users manage own profiles" on public.user_profiles
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users manage own settings" on public.user_settings;
create policy "Users manage own settings" on public.user_settings
  for all using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "Users manage own playback state" on public.playback_state;
create policy "Users manage own playback state" on public.playback_state
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own watch history" on public.watch_history;
create policy "Users manage own watch history" on public.watch_history
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own watchlists" on public.watchlists;
create policy "Users manage own watchlists" on public.watchlists
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own favorites" on public.favorites;
create policy "Users manage own favorites" on public.favorites
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own watch sessions" on public.watch_sessions;
create policy "Users manage own watch sessions" on public.watch_sessions
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own search history" on public.search_history;
create policy "Users manage own search history" on public.search_history
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));

drop policy if exists "Users manage own profile preferences" on public.profile_preferences;
create policy "Users manage own profile preferences" on public.profile_preferences
  for all using (public.owns_profile(profile_id))
  with check (public.owns_profile(profile_id));
