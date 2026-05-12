import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import rateLimit from '@fastify/rate-limit';
import { config } from './config.js';
import { logger } from './logger.js';
import { startSessionSweeper } from './sessions.js';
import { healthRoute } from './routes/health.js';
import { chatRoute } from './routes/chat.js';
import { ttsRoute } from './routes/tts.js';
import { warmupRoute } from './routes/warmup.js';
import { warmupAll } from './warmup.js';

const app = Fastify({
  logger,
  bodyLimit: 64 * 1024,
  trustProxy: true,
});

await app.register(cors, {
  origin: config.allowedOrigin === '*' ? true : config.allowedOrigin.split(',').map((s) => s.trim()),
  credentials: false,
});

await app.register(rateLimit, {
  max: config.rateLimit.max,
  timeWindow: config.rateLimit.timeWindow,
  allowList: (req) => req.url === '/api/health' || req.url === '/api/warmup',
});

await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

await app.register(healthRoute);
await app.register(chatRoute);
await app.register(ttsRoute);
await app.register(warmupRoute);

startSessionSweeper(logger);

if (!config.groq.apiKey) {
  logger.warn('GROQ_API_KEY is not set — /api/chat will reject requests until it is configured');
}

const shutdown = async (signal) => {
  logger.info({ signal }, 'shutting down');
  try {
    await app.close();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'shutdown error');
    process.exit(1);
  }
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: config.port, host: config.host });
  // Kick off warmup in the background — fire-and-forget. First user turn
  // should hit warm Groq + Piper paths.
  warmupAll(logger).catch((err) => logger.warn({ err: err?.message }, 'warmup.failed'));
} catch (err) {
  logger.error({ err }, 'startup failed');
  process.exit(1);
}
