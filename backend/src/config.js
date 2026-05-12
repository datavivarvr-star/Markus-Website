const env = process.env;

export const config = {
  port: parseInt(env.PORT ?? '3000', 10),
  host: env.HOST ?? '0.0.0.0',
  allowedOrigin: env.ALLOWED_ORIGIN ?? 'http://localhost:5173',
  logLevel: env.LOG_LEVEL ?? 'info',
  nodeEnv: env.NODE_ENV ?? 'development',
  groq: {
    apiKey: env.GROQ_API_KEY ?? '',
    baseURL: env.GROQ_BASE_URL ?? 'https://api.groq.com/openai/v1',
    model: env.GROQ_MODEL ?? 'openai/gpt-oss-20b',
    temperature: 0.6,
    maxTokens: 120,
  },
  piperUrl: env.PIPER_URL ?? 'http://piper-tts:8001',
  session: {
    maxTurns: 10,
    idleTimeoutMs: 30 * 60 * 1000,
    sweepIntervalMs: 5 * 60 * 1000,
  },
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
  },
  // Phase 13 — per-session hourly cap. Catches a single client behind a
  // shared NAT trying to burn the IP-level allowance from one tab.
  sessionRateLimit: {
    maxTurnsPerHour: 200,
    windowMs: 60 * 60 * 1000,
  },
  // Phase 13 — WS frame cap. Real chat messages are ~600 B; this is plenty
  // and shrinks the abuse surface vs the previous 64 KB default.
  wsMaxPayloadBytes: 10 * 1024,
};
