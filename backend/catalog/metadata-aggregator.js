/**
 * Metadata Aggregator
 *
 * Normalizes external metadata providers behind one backend-only service.
 * TMDB and AniList implementations should be added as provider adapters here;
 * browser clients must never talk to those providers directly.
 */

export class MetadataAggregator {
  constructor({ tmdbProvider, anilistProvider }) {
    this.tmdbProvider = tmdbProvider;
    this.anilistProvider = anilistProvider;
  }

  async fetch({ source, externalId, mediaType }) {
    if (source === 'tmdb') {
      return this.tmdbProvider.fetch({ externalId, mediaType });
    }
    if (source === 'anilist') {
      return this.anilistProvider.fetch({ externalId, mediaType });
    }
    throw new Error(`Unsupported metadata source: ${source}`);
  }

  async search(query) {
    const results = [];
    results.push(...await this.tmdbProvider.search(query).catch(() => []));
    results.push(...await this.anilistProvider.search(query).catch(() => []));
    return results;
  }

  async trending(kind) {
    if (kind === 'movie') return this.tmdbProvider.trending('movie').catch(() => []);
    if (kind === 'series') return this.tmdbProvider.trending('series').catch(() => []);
    if (kind === 'anime') return this.anilistProvider.trending().catch(() => []);
    return [];
  }

  status() {
    return {
      tmdb: this.tmdbProvider.status?.() ?? { provider: 'tmdb', configured: false },
      anilist: this.anilistProvider.status?.() ?? { provider: 'anilist', configured: false },
    };
  }
}

export class ProviderNotConfigured {
  constructor(name) {
    this.name = name;
  }

  async fetch() {
    throw new Error(`${this.name} provider is not configured`);
  }

  async search() {
    return [];
  }

  async trending() {
    return [];
  }
}
