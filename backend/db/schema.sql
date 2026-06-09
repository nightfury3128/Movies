CREATE SCHEMA IF NOT EXISTS users;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS playback;
CREATE SCHEMA IF NOT EXISTS collections;
CREATE SCHEMA IF NOT EXISTS resolver;

CREATE TABLE IF NOT EXISTS users.users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users.users(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users.user_settings (
  user_id uuid PRIMARY KEY REFERENCES users.users(id) ON DELETE CASCADE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.genres (
  id bigserial PRIMARY KEY,
  name text NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS catalog.movies (
  content_id text PRIMARY KEY,
  tmdb_id text UNIQUE,
  title text NOT NULL,
  description text,
  release_year int,
  runtime_minutes int,
  rating numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.shows (
  content_id text PRIMARY KEY,
  tmdb_id text UNIQUE,
  title text NOT NULL,
  description text,
  first_air_year int,
  rating numeric,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.episodes (
  content_id text PRIMARY KEY,
  show_content_id text NOT NULL REFERENCES catalog.shows(content_id) ON DELETE CASCADE,
  season_number int NOT NULL,
  episode_number int NOT NULL,
  title text NOT NULL,
  description text,
  runtime_minutes int,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (show_content_id, season_number, episode_number)
);

CREATE TABLE IF NOT EXISTS catalog.anime (
  content_id text PRIMARY KEY,
  anilist_id text UNIQUE,
  mal_id text,
  title text NOT NULL,
  description text,
  format text,
  episodes int,
  airing_status text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.artwork (
  id bigserial PRIMARY KEY,
  content_id text NOT NULL,
  kind text NOT NULL,
  source text NOT NULL,
  url text NOT NULL,
  width int,
  height int,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS catalog.metadata_cache (
  cache_key text PRIMARY KEY,
  source text NOT NULL,
  payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playback.playback_state (
  profile_id uuid NOT NULL REFERENCES users.profiles(id) ON DELETE CASCADE,
  content_id text NOT NULL,
  position_seconds numeric NOT NULL DEFAULT 0,
  duration_seconds numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE TABLE IF NOT EXISTS playback.watch_history (
  id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES users.profiles(id) ON DELETE CASCADE,
  content_id text NOT NULL,
  watched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS playback.watch_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid REFERENCES users.profiles(id) ON DELETE SET NULL,
  content_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE TABLE IF NOT EXISTS collections.watchlists (
  profile_id uuid NOT NULL REFERENCES users.profiles(id) ON DELETE CASCADE,
  content_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE TABLE IF NOT EXISTS collections.favorites (
  profile_id uuid NOT NULL REFERENCES users.profiles(id) ON DELETE CASCADE,
  content_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (profile_id, content_id)
);

CREATE TABLE IF NOT EXISTS collections.collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id uuid NOT NULL REFERENCES users.profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resolver.torrent_candidates (
  id text PRIMARY KEY,
  content_id text NOT NULL,
  title text NOT NULL,
  magnet text NOT NULL,
  info_hash text NOT NULL,
  quality text,
  codec text,
  size_bytes bigint,
  seeders int,
  health_score int,
  last_verified_at timestamptz
);

CREATE TABLE IF NOT EXISTS resolver.resolver_history (
  id bigserial PRIMARY KEY,
  resolver_id text NOT NULL,
  content_id text NOT NULL,
  selected_candidate_id text,
  startup_ms int,
  success boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resolver.torrent_health (
  info_hash text PRIMARY KEY,
  seeders int,
  availability numeric,
  startup_success_rate numeric,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS resolver.content_mappings (
  content_id text PRIMARY KEY,
  torrent_id text REFERENCES resolver.torrent_candidates(id),
  resolver_id text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
