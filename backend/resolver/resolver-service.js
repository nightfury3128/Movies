/**
 * Resolver Service
 *
 * Converts a contentId into a playable session. Torrent identifiers stay inside
 * this service boundary and are never returned to frontend clients.
 */

export class ResolverService {
  constructor({ acquisitionService, resolverRepository, sessionManager }) {
    this.acquisitionService = acquisitionService;
    this.resolverRepository = resolverRepository;
    this.sessionManager = sessionManager;
  }

  async warm(content) {
    const candidates = await this.acquisitionService.findCandidates(content);
    const ranked = rankCandidates(candidates);
    const best = ranked[0] ?? null;

    await this.resolverRepository.storeResolution({
      resolverId: createResolverId(content.id ?? content.contentId),
      contentId: content.id ?? content.contentId,
      best,
      alternatives: ranked.slice(1),
      status: best ? 'ready' : 'unavailable'
    });

    return publicResolverState(best);
  }

  async start(content) {
    const warmed = await this.warm(content);
    const mapping = await this.resolverRepository.getBestMapping(content.id ?? content.contentId);

    if (!mapping?.best?.magnet) {
      return {
        status: 'ready',
        streamUrl: '',
        candidates: ['Optimized', '1080p', '720p'],
        message: 'Athera is ready when a source is available.'
      };
    }

    const session = this.sessionManager.create(mapping.best.magnet);
    return {
      ...warmed,
      status: 'optimizing',
      sessionId: session.sessionId,
      streamPath: `/stream/${session.sessionId}/master.m3u8`
    };
  }
}

export function rankCandidates(candidates) {
  return [...candidates]
    .map(candidate => ({
      ...candidate,
      healthScore: scoreCandidate(candidate)
    }))
    .sort((a, b) => b.healthScore - a.healthScore);
}

export function scoreCandidate(candidate) {
  const seederScore = clamp((candidate.seeders ?? 0) / 100, 0, 1) * 40;
  const availabilityScore = clamp(candidate.availability ?? 0, 0, 1) * 20;
  const startupScore = clamp(candidate.startupSuccessRate ?? 0, 0, 1) * 20;
  const codecScore = candidate.codecCompatibility === false ? 0 : 10;
  const sizeScore = clamp(candidate.sizeEfficiency ?? 0.75, 0, 1) * 10;
  return Math.round(seederScore + availabilityScore + startupScore + codecScore + sizeScore);
}

function publicResolverState(best) {
  return {
    status: best ? 'ready' : 'unavailable',
    candidates: best ? ['Optimized', best.quality ?? '1080p', '720p'] : [],
    startupEstimate: best ? 'Fast' : 'Unavailable'
  };
}

function createResolverId(contentId) {
  return `resolver_${contentId}_${Date.now().toString(36)}`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}
