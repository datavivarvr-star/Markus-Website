import { config } from '../config.js';
import { sessionCount } from '../sessions.js';

export async function healthRoute(app) {
  app.get('/api/health', async () => {
    const services = {
      groq: { configured: !!config.groq.apiKey, model: config.groq.model },
      piper: { url: config.piperUrl, ok: false },
    };

    try {
      const res = await fetch(`${config.piperUrl}/health`, { signal: AbortSignal.timeout(1500) });
      services.piper.ok = res.ok;
      if (res.ok) services.piper.body = await res.json().catch(() => null);
    } catch (e) {
      services.piper.error = e.message;
    }

    return {
      ok: services.groq.configured,
      services,
      sessions: sessionCount(),
      uptime_s: Math.round(process.uptime()),
    };
  });
}
