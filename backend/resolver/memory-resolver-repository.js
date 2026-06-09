export class MemoryResolverRepository {
  constructor() {
    this.mappings = new Map();
    this.history = [];
  }

  async storeResolution(resolution) {
    this.mappings.set(resolution.contentId, resolution);
    this.history.push({ ...resolution, createdAt: new Date().toISOString() });
  }

  async getBestMapping(contentId) {
    return this.mappings.get(contentId) ?? null;
  }
}
