export type ContentType = "movie" | "series" | "anime";

export type Episode = {
  id: string;
  title: string;
  season: number;
  episode: number;
  runtime: string;
  progress?: number;
};

export type ContentItem = {
  id: string;
  type: ContentType;
  title: string;
  description: string;
  year: number;
  rating: string;
  runtime: string;
  genres: string[];
  poster: string;
  backdrop: string;
  maturity: string;
  match: number;
  seasons?: number;
  episodes?: Episode[];
  progress?: number;
  addedAt: string;
};

const poster = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=720&q=80`;

const backdrop = (id: string) =>
  `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1800&q=80`;

export const catalog: ContentItem[] = [
  {
    id: "iron-skies",
    type: "movie",
    title: "Iron Skies",
    description: "A rescue pilot crosses a collapsing orbital shipyard to recover the only witness to a corporate cover-up.",
    year: 2026,
    rating: "8.2",
    runtime: "2h 08m",
    genres: ["Sci-Fi", "Action", "Thriller"],
    poster: poster("photo-1534447677768-be436bb09401"),
    backdrop: backdrop("photo-1446776811953-b23d57bd21aa"),
    maturity: "PG-13",
    match: 98,
    addedAt: "2026-05-21"
  },
  {
    id: "night-runner",
    type: "series",
    title: "Night Runner",
    description: "A courier with a stolen identity navigates neon backchannels, black-market data brokers, and a city that never powers down.",
    year: 2025,
    rating: "8.8",
    runtime: "48m",
    genres: ["Crime", "Cyberpunk", "Drama"],
    poster: poster("photo-1519608487953-e999c86e7455"),
    backdrop: backdrop("photo-1519608487953-e999c86e7455"),
    maturity: "TV-MA",
    match: 96,
    seasons: 2,
    episodes: [
      { id: "night-runner-s1e1", title: "Dead Drop", season: 1, episode: 1, runtime: "49m", progress: 67 },
      { id: "night-runner-s1e2", title: "False Light", season: 1, episode: 2, runtime: "46m" },
      { id: "night-runner-s1e3", title: "Black Glass", season: 1, episode: 3, runtime: "51m" }
    ],
    progress: 67,
    addedAt: "2026-04-18"
  },
  {
    id: "glass-tide",
    type: "movie",
    title: "Glass Tide",
    description: "A marine biologist and a salvage crew find an impossible city beneath a storm wall in the Atlantic.",
    year: 2024,
    rating: "7.9",
    runtime: "1h 55m",
    genres: ["Adventure", "Mystery"],
    poster: poster("photo-1500530855697-b586d89ba3ee"),
    backdrop: backdrop("photo-1507525428034-b723cf961d3e"),
    maturity: "PG-13",
    match: 93,
    progress: 41,
    addedAt: "2026-06-01"
  },
  {
    id: "redline",
    type: "series",
    title: "Redline",
    description: "Elite drivers, private security teams, and federal investigators collide across an underground racing circuit.",
    year: 2026,
    rating: "8.1",
    runtime: "52m",
    genres: ["Action", "Drama"],
    poster: poster("photo-1503376780353-7e6692767b70"),
    backdrop: backdrop("photo-1492144534655-ae79c964c9d7"),
    maturity: "TV-14",
    match: 91,
    seasons: 1,
    episodes: [
      { id: "redline-s1e1", title: "Launch Control", season: 1, episode: 1, runtime: "52m" },
      { id: "redline-s1e2", title: "Apex", season: 1, episode: 2, runtime: "50m" }
    ],
    addedAt: "2026-05-29"
  },
  {
    id: "quiet-signal",
    type: "movie",
    title: "Quiet Signal",
    description: "An isolated radio astronomer receives a repeating message that predicts events minutes before they happen.",
    year: 2023,
    rating: "7.7",
    runtime: "1h 43m",
    genres: ["Mystery", "Sci-Fi"],
    poster: poster("photo-1500534314209-a25ddb2bd429"),
    backdrop: backdrop("photo-1451187580459-43490279c0fa"),
    maturity: "PG",
    match: 89,
    addedAt: "2026-03-08"
  },
  {
    id: "northstar",
    type: "series",
    title: "Northstar",
    description: "A remote Arctic research team uncovers a buried signal station and a conspiracy that reaches home.",
    year: 2024,
    rating: "8.4",
    runtime: "57m",
    genres: ["Drama", "Thriller"],
    poster: poster("photo-1483728642387-6c3bdd6c93e5"),
    backdrop: backdrop("photo-1483728642387-6c3bdd6c93e5"),
    maturity: "TV-MA",
    match: 94,
    seasons: 3,
    episodes: [
      { id: "northstar-s1e1", title: "Whiteout", season: 1, episode: 1, runtime: "58m", progress: 22 },
      { id: "northstar-s1e2", title: "The Core", season: 1, episode: 2, runtime: "55m" }
    ],
    progress: 22,
    addedAt: "2026-02-12"
  }
];

export function getContent(id: string) {
  return catalog.find((item) => item.id === id || item.episodes?.some((episode) => episode.id === id));
}

export function getPlaybackContent(contentId: string) {
  return catalog.find((item) => item.id === contentId || item.episodes?.some((episode) => episode.id === contentId));
}

export function catalogSections() {
  return {
    continueWatching: catalog.filter((item) => item.progress),
    trendingMovies: catalog.filter((item) => item.type === "movie").sort((a, b) => b.match - a.match),
    trendingShows: catalog.filter((item) => item.type === "series").sort((a, b) => b.match - a.match),
    popular: [...catalog].sort((a, b) => Number(b.rating) - Number(a.rating)),
    recentlyAdded: [...catalog].sort((a, b) => b.addedAt.localeCompare(a.addedAt))
  };
}
