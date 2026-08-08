import pino from 'pino';
import { createRequire } from 'node:module';
import { env } from './env.js';

const require = createRequire(import.meta.url);

/** Установлен ли pino-pretty. Пакет опциональный и нужен только в разработке. */
function hasPinoPretty(): boolean {
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

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
  // Читаемый вывод только в разработке и только если pino-pretty установлен.
  // Пакет опциональный: указывать несуществующий transport — значит уронить
  // процесс на старте вместо того, чтобы просто писать логи в JSON.
  transport: env.NODE_ENV === 'development' && hasPinoPretty() ? { target: 'pino-pretty' } : undefined,
});
