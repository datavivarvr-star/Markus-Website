import { config } from '../config.js';

export async function ttsRoute(app) {
  app.post(
    '/api/tts',
    {
      schema: {
        body: {
          type: 'object',
          required: ['text'],
          additionalProperties: false,
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 2000 },
          },
        },
      },
    },
    async (req, reply) => {
      const t0 = performance.now();
      try {
        const res = await fetch(`${config.piperUrl}/synthesize`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: req.body.text }),
          signal: AbortSignal.timeout(45000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => '');
          req.log.error({ status: res.status, body: body.slice(0, 200) }, 'tts.upstream_error');
          return reply.code(502).send({ error: 'tts_upstream_error' });
        }

        const data = await res.json();
        req.log.info(
          { tts_ms: Math.round(performance.now() - t0), chars: req.body.text.length },
          'tts.ok',
        );
        return data;
      } catch (err) {
        req.log.error({ err: err?.message }, 'tts.unreachable');
        return reply.code(503).send({ error: 'tts_unavailable' });
      }
    },
  );
}
