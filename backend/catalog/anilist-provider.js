const ANILIST_URL = 'https://graphql.anilist.co';

export class AniListProvider {
  status() {
    return {
      provider: 'anilist',
      configured: true,
      authMode: 'public_graphql',
    };
  }

  async search(query) {
    if (!query) return [];
    const data = await this._graphql(SEARCH_QUERY, { search: query, sort: 'SEARCH_MATCH' });
    return (data.Page?.media ?? []).map(normalizeAnime);
  }

  async trending() {
    const data = await this._graphql(TRENDING_QUERY, { sort: 'TRENDING_DESC' });
    return (data.Page?.media ?? []).map(normalizeAnime);
  }

  async fetch({ externalId }) {
    const data = await this._graphql(DETAIL_QUERY, { id: Number(externalId) });
    return normalizeAnime(data.Media);
  }

  async _graphql(query, variables) {
    const response = await fetch(ANILIST_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) throw new Error(`AniList request failed: ${response.status}`);
    const payload = await response.json();
    if (payload.errors?.length) throw new Error(payload.errors[0].message ?? 'AniList request failed');
    return payload.data;
  }
}

const MEDIA_FIELDS = `
  id
  title { romaji english native }
  description(asHtml: false)
  startDate { year }
  episodes
  duration
  averageScore
  genres
  format
  status
  coverImage { extraLarge large }
  bannerImage
  studios(isMain: true) { nodes { name } }
  characters(sort: ROLE, perPage: 8) { nodes { name { full } image { medium } } }
`;

const SEARCH_QUERY = `query ($search: String, $sort: MediaSort) {
  Page(page: 1, perPage: 12) {
    media(search: $search, type: ANIME, sort: [$sort]) { ${MEDIA_FIELDS} }
  }
}`;

const TRENDING_QUERY = `query ($sort: MediaSort) {
  Page(page: 1, perPage: 20) {
    media(type: ANIME, sort: [$sort]) { ${MEDIA_FIELDS} }
  }
}`;

const DETAIL_QUERY = `query ($id: Int) {
  Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} }
}`;

function normalizeAnime(media) {
  const title = media.title?.english ?? media.title?.romaji ?? media.title?.native ?? 'Untitled Anime';
  return {
    contentId: `anilist_anime_${media.id}`,
    type: 'anime',
    title,
    description: stripHtml(media.description ?? ''),
    year: media.startDate?.year ?? new Date().getFullYear(),
    rating: media.averageScore ? (media.averageScore / 10).toFixed(1) : 'NR',
    runtime: media.duration ? `${media.duration}m` : '',
    genres: media.genres ?? [],
    maturity: 'NR',
    match: media.averageScore ?? 0,
    seasons: media.episodes ? 1 : undefined,
    episodes: media.episodes ? Array.from({ length: media.episodes }, (_, index) => ({
      contentId: `anilist_anime_${media.id}_e${String(index + 1).padStart(3, '0')}`,
      title: `Episode ${index + 1}`,
      season: 1,
      episode: index + 1,
      runtime: media.duration ? `${media.duration}m` : '',
    })) : undefined,
    artwork: [
      media.coverImage?.extraLarge ? { kind: 'poster', source: 'anilist', url: media.coverImage.extraLarge } : null,
      media.bannerImage ? { kind: 'backdrop', source: 'anilist', url: media.bannerImage } : null,
    ].filter(Boolean),
    cast: (media.characters?.nodes ?? []).map(character => ({
      name: character.name?.full,
      character: 'Character',
      profile: character.image?.medium ?? null,
    })),
    sourceRefs: [{ source: 'anilist', id: String(media.id), mediaType: 'anime' }],
  };
}

function stripHtml(value) {
  return value.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
