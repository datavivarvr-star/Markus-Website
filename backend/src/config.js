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
};
