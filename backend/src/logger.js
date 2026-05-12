import pino from 'pino';
import { config } from './config.js';

const isDev = config.nodeEnv !== 'production';

export const logger = pino({
  level: config.logLevel,
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { translateTime: 'HH:MM:ss.l', singleLine: true, ignore: 'pid,hostname' },
      }
    : undefined,
  redact: {
    paths: ['req.headers.authorization', '*.apiKey', '*.api_key'],
    censor: '[redacted]',
  },
});
