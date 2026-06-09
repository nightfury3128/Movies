export default async function contentRoutes(fastify, opts) {
  const { catalogService } = opts;

  fastify.get('/catalog/status', async () => catalogService.status());

  fastify.get('/content/:contentId', async (req, reply) => {
    const content = await catalogService.getContent(req.params.contentId);
    if (!content) return reply.code(404).send({ error: 'Content not found' });
    return content;
  });

  fastify.get('/movies/trending', async () => catalogService.trending('movie'));
  fastify.get('/shows/trending', async () => catalogService.trending('series'));
  fastify.get('/anime/trending', async () => catalogService.trending('anime'));

  fastify.get('/search', async req => catalogService.search(req.query?.q ?? ''));
}
