export default async function resolverRoutes(fastify, opts) {
  const { catalogService, resolverService } = opts;

  fastify.post('/warm', async (req, reply) => {
    const contentId = req.body?.contentId;
    if (!contentId) return reply.code(400).send({ error: 'contentId is required' });

    const content = await catalogService.getContent(contentId);
    if (!content) return reply.code(404).send({ error: 'Content not found' });
    return resolverService.warm(content);
  });

  fastify.post('/start', async (req, reply) => {
    const contentId = req.body?.contentId;
    if (!contentId) return reply.code(400).send({ error: 'contentId is required' });

    const content = await catalogService.getContent(contentId);
    if (!content) return reply.code(404).send({ error: 'Content not found' });
    return resolverService.start(content);
  });
}
