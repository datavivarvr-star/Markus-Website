import { config } from '../config.js';
import { sessionCount } from '../sessions.js';

export async function healthRoute(app) {
  app.get('/api/health', async () => {
    const services = {
      groq: { configured: !!config.groq.apiKey, model: config.groq.model },
      piper: { ok: false },
    };

    try {
      const res = await fetch(`${config.piperUrl}/health`, { signal: AbortSignal.timeout(1500) });
      services.piper.ok = res.ok;
    } catch {
      services.piper.ok = false;
    }

    return {
      ok: services.groq.configured,
      services,
      sessions: sessionCount(),
      uptime_s: Math.round(process.uptime()),
    };
  });
}
