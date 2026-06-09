/**
 * Torrent Acquisition Service
 *
 * Backend-only candidate discovery and validation. Provider integrations can
 * return raw candidate data with magnets/info hashes; only resolver services
 * may consume those fields.
 */

export class TorrentAcquisitionService {
  constructor({ providers = [] } = {}) {
    this.providers = providers;
  }

  async findCandidates(content) {
    const queries = buildQueries(content);
    const results = [];

    for (const provider of this.providers) {
      for (const query of queries) {
        const providerResults = await provider.search(query).catch(() => []);
        results.push(...providerResults.map(candidate => normalizeCandidate(candidate, content)));
      }
    }

    return dedupeCandidates(results);
  }
}

export class NoopAcquisitionProvider {
  async search() {
    return [];
  }
}

function buildQueries(content) {
  const title = content.title;
  const base = [`${title} 1080p`, `${title} 720p`];
  if (content.season && content.episode) {
    const code = `S${String(content.season).padStart(2, '0')}E${String(content.episode).padStart(2, '0')}`;
    return [`${title} ${code} 1080p`, `${title} ${code} 720p`];
  }
  return base;
}

function normalizeCandidate(candidate, content) {
  return {
    id: candidate.id,
    contentId: content.id ?? content.contentId,
    title: candidate.title,
    magnet: candidate.magnet,
    infoHash: candidate.infoHash,
    quality: candidate.quality,
    codec: candidate.codec,
    size: candidate.size,
    seeders: candidate.seeders,
    availability: candidate.availability,
    startupSuccessRate: candidate.startupSuccessRate,
    codecCompatibility: candidate.codecCompatibility,
    sizeEfficiency: candidate.sizeEfficiency,
    lastVerifiedAt: candidate.lastVerifiedAt ?? new Date().toISOString()
  };
}

function dedupeCandidates(candidates) {
  const byHash = new Map();
  for (const candidate of candidates) {
    const key = candidate.infoHash ?? candidate.id;
    if (!key || byHash.has(key)) continue;
    byHash.set(key, candidate);
  }
  return Array.from(byHash.values());
}
