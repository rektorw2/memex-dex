/**
 * Клиент OKX Onchain OS для кошельковых разделов.
 *
 * Отдельно от okx-market.ts намеренно. Тот отвечает за токены
 * и живёт своими сроками кеша; здесь другие эндпоинты, другие
 * периоды и другая цена ошибки. Общая у них только подпись,
 * и повторить её здесь дешевле, чем связать два модуля общим
 * состоянием, которое придётся согласовывать при каждой правке.
 *
 * Подпись — самое хрупкое место интеграции, и ломается она молча:
 * неверная строка даёт 401 без объяснения, какая именно часть
 * не сошлась. Поэтому построение строки вынесено в чистую функцию
 * и проверяется тестами по образцу из документации, а не догадками
 * по ответу сервера.
 *
 * Два правила подписи, на которых спотыкаются чаще всего:
 * в строку входит путь ВМЕСТЕ с query string, и тело подписывается
 * ровно в том виде, в котором уходит, — сериализация должна быть
 * одна и та же, иначе подпись верна для другого текста.
 */

import { createHmac } from 'node:crypto';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { cached, withRetry, Concurrency, RateLimit } from '../lib/cache.js';

const DEFAULT_BASE = 'https://web3.okx.com';

/** Ошибка провайдера с разбором причины. */
export class OkxProviderError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate_limit' | 'network' | 'response' | 'not_configured',
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'OkxProviderError';
  }

  /** Повторять имеет смысл только временные отказы. */
  get retryable(): boolean {
    return this.kind === 'rate_limit' || this.kind === 'network';
  }
}

/**
 * Строка, которую подписываем.
 *
 * Чистая функция без обращения к окружению: только так её можно
 * проверить тестом. Ошибка здесь не проявляется никак, кроме
 * отказа авторизации, и отлаживать её по ответу сервера —
 * занятие на часы.
 */
export function buildPreHash(
  timestamp: string,
  method: string,
  requestPathWithQuery: string,
  body = '',
): string {
  return timestamp + method.toUpperCase() + requestPathWithQuery + body;
}

export function signPreHash(preHash: string, secret: string): string {
  return createHmac('sha256', secret).update(preHash).digest('base64');
}

/** Время в формате, который принимает OKX. */
export function okxTimestamp(now = new Date()): string {
  return now.toISOString();
}

export function isOkxWalletConfigured(): boolean {
  return Boolean(
    env.OKX_MARKET_ENABLED !== false &&
      env.OKX_API_KEY &&
      env.OKX_API_SECRET &&
      env.OKX_PASSPHRASE,
  );
}

// ─────────────────────── Ограничения обращений ──────────────────────────────

/**
 * Двадцать запросов в секунду, шесть одновременно.
 *
 * Точный лимит зависит от тарифа и здесь неизвестен, поэтому взято
 * заведомо консервативное значение. Ошибиться в эту сторону дёшево —
 * список обновится позже; в другую — получить блокировку ключа.
 */
const limiter = new RateLimit(20, 1_000);
const pool = new Concurrency(6);

export interface CallOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  timeoutMs?: number;
  /** Для трассировки в журнале. Секретов не содержит. */
  label?: string;
}

/**
 * Один запрос к OKX.
 *
 * В журнал попадают путь, код ответа и задержка. Подпись, ключ
 * и парольная фраза не попадают никогда и ни при каких уровнях
 * логирования: журналы переживают инциденты и читаются людьми,
 * которым доступ к ключам не полагается.
 */
export async function okxCall<T = unknown>(
  pathWithQuery: string,
  opts: CallOptions = {},
): Promise<T> {
  if (!isOkxWalletConfigured()) {
    throw new OkxProviderError('not_configured', 'OKX provider is not configured');
  }

  const method = opts.method ?? 'GET';
  const body = opts.body == null ? '' : JSON.stringify(opts.body);
  const base = env.OKX_API_BASE_URL || DEFAULT_BASE;

  await limiter.take();

  const timestamp = okxTimestamp();
  const preHash = buildPreHash(timestamp, method, pathWithQuery, body);
  const signature = signPreHash(preHash, env.OKX_API_SECRET!);

  const started = Date.now();

  let res: Response;
  try {
    res = await fetch(`${base}${pathWithQuery}`, {
      method,
      headers: {
        'OK-ACCESS-KEY': env.OKX_API_KEY!,
        'OK-ACCESS-SIGN': signature,
        'OK-ACCESS-TIMESTAMP': timestamp,
        'OK-ACCESS-PASSPHRASE': env.OKX_PASSPHRASE!,
        ...(env.OKX_PROJECT_ID ? { 'OK-ACCESS-PROJECT': env.OKX_PROJECT_ID } : {}),
        'content-type': 'application/json',
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 12_000),
    });
  } catch (e: any) {
    throw new OkxProviderError('network', `сеть недоступна: ${e?.message ?? 'без причины'}`);
  }

  const latency = Date.now() - started;

  if (res.status === 429) {
    logger.warn({ path: pathWithQuery, latency }, 'OKX: превышен лимит запросов');
    throw new OkxProviderError('rate_limit', 'превышен лимит запросов', 429);
  }

  if (res.status === 401 || res.status === 403) {
    // Отдельный вид: повторять бессмысленно, а причина почти всегда
    // в расхождении подписи, а не в правах.
    throw new OkxProviderError('auth', 'OKX отклонил подпись или ключ', res.status);
  }

  if (!res.ok) {
    throw new OkxProviderError('response', `OKX ответил ${res.status}`, res.status);
  }

  logger.debug({ path: pathWithQuery, latency, label: opts.label }, 'OKX: ответ получен');

  return (await res.json()) as T;
}

/**
 * Запрос с повторами и кешем.
 *
 * Повторяются только безопасные GET и только временные отказы:
 * неверная подпись не станет верной со второй попытки, а лимит
 * израсходует.
 */
export async function okxCached<T>(
  key: string,
  pathWithQuery: string,
  ttlMs: number,
  opts: CallOptions = {},
): Promise<{ value: T; ageMs: number; isStale: boolean } | null> {
  try {
    return await cached<T>(
      key,
      () =>
        pool.run(() =>
          withRetry(() => okxCall<T>(pathWithQuery, opts), {
            attempts: (opts.method ?? 'GET') === 'GET' ? 3 : 1,
            label: opts.label ?? pathWithQuery,
          }),
        ),
      // Устаревшее значение живёт дольше свежего: отказ провайдера
      // не должен очищать последний удачный ответ.
      { ttlMs, staleMs: Math.max(ttlMs * 10, 10 * 60_000) },
    );
  } catch (e: any) {
    logger.debug({ path: pathWithQuery, err: e?.message }, 'OKX: запрос не удался');
    return null;
  }
}
