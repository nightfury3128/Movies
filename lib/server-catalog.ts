import { catalogSections, getContent, getPlaybackContent, type ContentItem } from "@/lib/catalog";
import { getCurrentUser } from "@/lib/profiles";

const CATALOG_URL = process.env.ATHERA_CATALOG_URL ?? process.env.ATHERA_ENGINE_URL ?? "http://localhost:3000";

export async function getServerContent(id: string): Promise<ContentItem | null> {
  if (CATALOG_URL) {
    const response = await fetch(`${CATALOG_URL}/content/${id}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return response.json() as Promise<ContentItem>;
  }
  return getContent(id) ?? null;
}

export async function getServerPlaybackContent(contentId: string): Promise<ContentItem | null> {
  const direct = await getServerContent(contentId);
  if (direct) return direct;

  const parentId = parentContentId(contentId);
  if (parentId) return getServerContent(parentId);

  return getPlaybackContent(contentId) ?? null;
}

export async function getServerTrending(kind: "movie" | "series" | "anime"): Promise<ContentItem[]> {
  if (CATALOG_URL) {
    const path = kind === "movie" ? "/movies/trending" : kind === "series" ? "/shows/trending" : "/anime/trending";
    const response = await fetch(`${CATALOG_URL}${path}`, { cache: "no-store" }).catch(() => null);
    if (response?.ok) return response.json() as Promise<ContentItem[]>;
  }

  const sections = catalogSections();
  if (kind === "movie") return sections.trendingMovies;
  if (kind === "series") return sections.trendingShows;
  return [];
}

export async function getServerHomeSections() {
  const local = catalogSections();
  const [continueWatching, trendingMovies, trendingShows, trendingAnime] = await Promise.all([
    getContinueWatching(),
    getServerTrending("movie"),
    getServerTrending("series"),
    getServerTrending("anime"),
  ]);

  return {
    continueWatching,
    trendingMovies: trendingMovies.length ? trendingMovies : local.trendingMovies,
    trendingShows: trendingShows.length ? trendingShows : local.trendingShows,
    recommended: [...trendingAnime, ...local.popular].slice(0, 12),
    myList: local.recentlyAdded.slice(0, 4),
  };
}

export async function getContinueWatching(): Promise<ContentItem[]> {
  try {
    const { supabase, user } = await getCurrentUser();
    if (!user) return [];

    const { data: profiles } = await supabase
      .from("user_profiles")
      .select("id")
      .eq("user_id", user.id)
      .order("created_at", { ascending: true })
      .limit(1);

    const profileId = profiles?.[0]?.id;
    if (!profileId) return [];

    const { data, error } = await supabase
      .from("playback_state")
      .select("*")
      .eq("profile_id", profileId)
      .lt("percent_complete", 95)
      .order("last_watched_at", { ascending: false })
      .limit(20);

    if (error || !data?.length) return [];

    const hydrated = await Promise.all(
      data.map(async (row) => {
        const contentId = playbackRowToContentId(row);
        const content = await getServerPlaybackContent(contentId);
        if (!content) return null;
        const episode = content.episodes?.find((entry) => entry.id === contentId);
        return {
          ...content,
          id: contentId,
          title: episode ? `${content.title}: ${episode.title}` : content.title,
          runtime: episode?.runtime ?? content.runtime,
          progress: Math.round(Number(row.percent_complete ?? 0))
        };
      })
    );

    return hydrated.filter((item): item is NonNullable<typeof item> => item !== null);
  } catch {
    return [];
  }
}

function playbackRowToContentId(row: {
  content_type: string;
  tmdb_id: number;
  season_number: number | null;
  episode_number: number | null;
}) {
  if (row.content_type === "movie") return `tmdb_movie_${row.tmdb_id}`;
  if (row.content_type === "show") return `tmdb_show_${row.tmdb_id}`;
  if (row.content_type === "episode") {
    return `tmdb_show_${row.tmdb_id}_s${String(row.season_number ?? 1).padStart(2, "0")}e${String(row.episode_number ?? 1).padStart(2, "0")}`;
  }
  if (row.content_type === "anime" && row.episode_number) {
    return `anilist_anime_${row.tmdb_id}_e${String(row.episode_number).padStart(3, "0")}`;
  }
  return `anilist_anime_${row.tmdb_id}`;
}

function parentContentId(contentId: string) {
  const tmdbShow = /^(tmdb_show_\d+)_s\d+e\d+$/.exec(contentId);
  if (tmdbShow) return tmdbShow[1];
  const anime = /^(anilist_anime_\d+)_e\d+$/.exec(contentId);
  if (anime) return anime[1];
  return null;
}
