import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  // Ключи, которые нельзя писать в логи ни при каких условиях.
  redact: {
    paths: [
      'password', 'passwordHash', 'totpSecret', 'privateKey', 'encryptedKey',
      'wrappedDek', 'req.headers.authorization', 'req.headers.cookie', 'secret',
    ],
    censor: '[REDACTED]',
  },
  transport: env.NODE_ENV === 'development' ? { target: 'pino-pretty' } : undefined,
});
