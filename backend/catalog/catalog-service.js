/**
 * Catalog Service
 *
 * Frontend-facing metadata boundary. This service owns normalized content IDs,
 * source aggregation, cached metadata, artwork references, and resolver mapping
 * attachment. UI clients should never call TMDB, AniList, or resolver internals.
 */

const now = () => new Date().toISOString();

export class CatalogService {
  constructor({ metadataAggregator, catalogRepository, resolverService }) {
    this.metadataAggregator = metadataAggregator;
    this.catalogRepository = catalogRepository;
    this.resolverService = resolverService;
  }

  async getContent(contentId) {
    const cached = await this.catalogRepository.getContent(contentId);
    if (cached) return cached;
    const external = parseExternalContentId(contentId);
    if (!external) return null;
    await this.hydrateExternalContent(external.source, external.externalId, external.mediaType);
    return this.catalogRepository.getContent(contentId);
  }

  async search(query) {
    const normalized = query?.trim();
    if (!normalized) return [];
    const local = await this.catalogRepository.search(normalized);
    const external = await this.metadataAggregator.search(normalized);
    const hydrated = await this._storeAll(external);
    return mergeById([...local, ...hydrated]);
  }

  async trending(kind) {
    const local = await this.catalogRepository.trending(kind);
    const external = await this.metadataAggregator.trending(kind);
    const hydrated = await this._storeAll(external);
    return mergeById([...hydrated, ...local]);
  }

  async hydrateExternalContent(source, externalId, mediaType) {
    const metadata = await this.metadataAggregator.fetch({ source, externalId, mediaType });
    const content = normalizeContent(metadata);
    await this.catalogRepository.upsertContent(content);
    return content;
  }

  async _storeAll(items) {
    const stored = [];
    for (const item of items) {
      const content = normalizeContent(item);
      await this.catalogRepository.upsertContent(content);
      const frontendContent = await this.catalogRepository.getContent(content.contentId);
      if (frontendContent) stored.push(frontendContent);
    }
    return stored;
  }

  async warmPlayback(contentId) {
    const content = await this.getContent(contentId);
    if (!content) return null;
    return this.resolverService.warm(content);
  }

  status() {
    return {
      providers: this.metadataAggregator.status(),
    };
  }
}

function parseExternalContentId(contentId) {
  let match = /^tmdb_movie_(\d+)$/.exec(contentId);
  if (match) return { source: 'tmdb', externalId: match[1], mediaType: 'movie' };
  match = /^tmdb_show_(\d+)$/.exec(contentId);
  if (match) return { source: 'tmdb', externalId: match[1], mediaType: 'series' };
  match = /^tmdb_show_(\d+)_s\d+e\d+$/.exec(contentId);
  if (match) return { source: 'tmdb', externalId: match[1], mediaType: 'series' };
  match = /^anilist_anime_(\d+)$/.exec(contentId);
  if (match) return { source: 'anilist', externalId: match[1], mediaType: 'anime' };
  match = /^anilist_anime_(\d+)_e\d+$/.exec(contentId);
  if (match) return { source: 'anilist', externalId: match[1], mediaType: 'anime' };
  return null;
}

function mergeById(items) {
  const byId = new Map();
  for (const item of items) byId.set(item.id ?? item.contentId, item);
  return Array.from(byId.values());
}

function normalizeContent(metadata) {
  return {
    contentId: metadata.contentId,
    type: metadata.type,
    title: metadata.title,
    description: metadata.description,
    year: metadata.year,
    runtime: metadata.runtime,
    rating: metadata.rating,
    maturity: metadata.maturity,
    genres: metadata.genres ?? [],
    cast: metadata.cast ?? [],
    artwork: metadata.artwork ?? [],
    seasons: metadata.seasons ?? [],
    episodes: metadata.episodes ?? [],
    match: metadata.match ?? 0,
    addedAt: metadata.addedAt ?? now().slice(0, 10),
    sourceRefs: metadata.sourceRefs ?? [],
    updatedAt: now()
  };
}
