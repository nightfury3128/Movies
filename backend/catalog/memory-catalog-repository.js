/**
 * Temporary catalog repository.
 *
 * PostgreSQL is the target persistence layer. This in-memory repository keeps
 * the route contract usable until the SQL migrations are applied and a pg-backed
 * repository replaces it.
 */

const poster = id => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=720&q=80`;
const backdrop = id => `https://images.unsplash.com/${id}?auto=format&fit=crop&w=1800&q=80`;

const seedCatalog = [
  {
    contentId: 'movie_iron-skies',
    type: 'movie',
    title: 'Iron Skies',
    description: 'A rescue pilot crosses a collapsing orbital shipyard to recover the only witness to a corporate cover-up.',
    year: 2026,
    rating: '8.2',
    runtime: '2h 08m',
    genres: ['Sci-Fi', 'Action', 'Thriller'],
    maturity: 'PG-13',
    match: 98,
    artwork: [
      { kind: 'poster', url: poster('photo-1534447677768-be436bb09401') },
      { kind: 'backdrop', url: backdrop('photo-1446776811953-b23d57bd21aa') }
    ],
    addedAt: '2026-05-21'
  },
  {
    contentId: 'series_night-runner',
    type: 'series',
    title: 'Night Runner',
    description: 'A courier with a stolen identity navigates data brokers, private networks, and a city that never powers down.',
    year: 2025,
    rating: '8.8',
    runtime: '48m',
    genres: ['Crime', 'Drama'],
    maturity: 'TV-MA',
    match: 96,
    seasons: 2,
    episodes: [
      { contentId: 'episode_night-runner_s01e01', title: 'Dead Drop', season: 1, episode: 1, runtime: '49m', progress: 67 },
      { contentId: 'episode_night-runner_s01e02', title: 'False Light', season: 1, episode: 2, runtime: '46m' },
      { contentId: 'episode_night-runner_s01e03', title: 'Black Glass', season: 1, episode: 3, runtime: '51m' }
    ],
    progress: 67,
    artwork: [
      { kind: 'poster', url: poster('photo-1519608487953-e999c86e7455') },
      { kind: 'backdrop', url: backdrop('photo-1519608487953-e999c86e7455') }
    ],
    addedAt: '2026-04-18'
  }
];

export class MemoryCatalogRepository {
  constructor(initial = seedCatalog) {
    this.items = new Map(initial.map(item => [item.contentId, item]));
  }

  async getContent(contentId) {
    for (const item of this.items.values()) {
      if (item.contentId === contentId) return toFrontendContent(item);
      const episode = item.episodes?.find(entry => entry.contentId === contentId);
      if (episode) return toFrontendContent(item);
    }
    return null;
  }

  async search(query) {
    const q = query.toLowerCase();
    return Array.from(this.items.values())
      .filter(item => [item.title, item.description, item.type, ...(item.genres ?? [])].join(' ').toLowerCase().includes(q))
      .map(toFrontendContent);
  }

  async trending(kind) {
    return Array.from(this.items.values())
      .filter(item => kind === 'all' || item.type === kind)
      .sort((a, b) => (b.match ?? 0) - (a.match ?? 0))
      .map(toFrontendContent);
  }

  async upsertContent(content) {
    this.items.set(content.contentId, content);
  }
}

export function toFrontendContent(item) {
  const posterArt = item.artwork?.find(art => art.kind === 'poster');
  const backdropArt = item.artwork?.find(art => art.kind === 'backdrop');
  return {
    id: item.contentId,
    type: item.type,
    title: item.title,
    description: item.description,
    year: item.year,
    rating: item.rating,
    runtime: item.runtime,
    genres: item.genres ?? [],
    poster: posterArt?.url ?? '',
    backdrop: backdropArt?.url ?? posterArt?.url ?? '',
    maturity: item.maturity,
    match: item.match ?? 0,
    seasons: item.seasons,
    episodes: item.episodes?.map(episode => ({ ...episode, id: episode.contentId })),
    progress: item.progress,
    addedAt: item.addedAt
  };
}
