import { warmupAll, getWarmupStatus } from '../warmup.js';

// GET /api/warmup — triggers warmup if cold and returns current status.
// Fire-and-forget from the client; safe to call repeatedly.
export async function warmupRoute(app) {
  app.get('/api/warmup', async (req) => {
    // Kick off in the background; do not await — the route returns
    // immediately with the current status so the client doesn't block on it.
    warmupAll(req.log).catch(() => {});
    return { ok: true, ...getWarmupStatus() };
  });
}
