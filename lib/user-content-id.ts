export type UserContentRef = {
  contentType: "movie" | "show" | "episode" | "anime";
  tmdbId: number;
  seasonNumber: number | null;
  episodeNumber: number | null;
};

export function parseUserContentId(contentId: string): UserContentRef | null {
  let match = /^tmdb_movie_(\d+)$/.exec(contentId);
  if (match) return base("movie", match[1]);

  match = /^tmdb_show_(\d+)$/.exec(contentId);
  if (match) return base("show", match[1]);

  match = /^tmdb_show_(\d+)_s(\d+)e(\d+)$/.exec(contentId);
  if (match) {
    return {
      contentType: "episode",
      tmdbId: Number(match[1]),
      seasonNumber: Number(match[2]),
      episodeNumber: Number(match[3])
    };
  }

  match = /^anilist_anime_(\d+)(?:_e(\d+))?$/.exec(contentId);
  if (match) {
    return {
      contentType: "anime",
      tmdbId: Number(match[1]),
      seasonNumber: match[2] ? 1 : null,
      episodeNumber: match[2] ? Number(match[2]) : null
    };
  }

  return null;
}

function base(contentType: "movie" | "show", tmdbId: string): UserContentRef {
  return {
    contentType,
    tmdbId: Number(tmdbId),
    seasonNumber: null,
    episodeNumber: null
  };
}
