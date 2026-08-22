import crypto from 'node:crypto';

/**
 * Проверка подписи вебхука Coinbase.
 *
 * Формат Hook0: `t=<секунды>,v0=<hmac>,h=<имена заголовков>,v1=<hmac>`.
 *
 * Проверяется `v1` — та подпись, которая связывает не только время
 * и тело, но и перечисленные заголовки. Документация называет её
 * избыточной для большинства случаев и предлагает `v0`; здесь она
 * не избыточна. В заголовках приезжает `x-event-type`, а от вида
 * события зависит, выдавать ли доступ. Оставить его неподписанным
 * значит позволить переставить `updated` на `success` в запросе,
 * тело которого при этом остаётся подлинным.
 *
 * Остальные правила те же, что у любой подписи: байты, а не
 * разобранный JSON; разбор после проверки; сравнение без утечки
 * времени; окно по времени с обеих сторон.
 */

export const COINBASE_WEBHOOK_REJECT = {
  missingHeader: 'MISSING_SIGNATURE',
  malformedHeader: 'MALFORMED_SIGNATURE',
  missingSignedHeader: 'MISSING_SIGNED_HEADER',
  duplicateComponent: 'DUPLICATE_COMPONENT',
  tooOld: 'TIMESTAMP_TOO_OLD',
  tooNew: 'TIMESTAMP_IN_FUTURE',
  badSignature: 'BAD_SIGNATURE',
  malformedBody: 'MALFORMED_BODY',
} as const;

export type CoinbaseRejectCode =
  (typeof COINBASE_WEBHOOK_REJECT)[keyof typeof COINBASE_WEBHOOK_REJECT];

export interface CoinbaseEvent {
  /** Идентификатор доставки. Ключ идемпотентности. */
  eventId: string;
  eventType: string;
  body: Record<string, unknown>;
}

export type CoinbaseVerifyOutcome =
  | { ok: true; event: CoinbaseEvent }
  | { ok: false; reason: CoinbaseRejectCode };

interface Parsed {
  timestamp: number;
  headerNames: string;
  v1: string;
}

/**
 * Разбор заголовка подписи.
 *
 * Повторяющиеся части отвергаются: `t=1,t=2,v1=…` даёт две разные
 * трактовки одного запроса, и выбор любой из них — это выбор
 * за отправителя. Такой заголовок собирают не по ошибке.
 */
function parseHeader(header: string): Parsed | null {
  const seen = new Map<string, string>();

  for (const raw of header.split(',')) {
    const part = raw.trim();
    const eq = part.indexOf('=');
    if (eq <= 0) return null;

    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);

    if (seen.has(key)) return null;
    seen.set(key, value);
  }

  const t = seen.get('t');
  const h = seen.get('h');
  const v1 = seen.get('v1');

  if (!t || h == null || !v1) return null;
  if (!/^\d{1,15}$/.test(t)) return null;
  if (!/^[0-9a-f]+$/i.test(v1) || v1.length % 2 !== 0) return null;

  const seconds = Number(t);
  if (!Number.isSafeInteger(seconds)) return null;

  return { timestamp: seconds, headerNames: h, v1 };
}

/** Сравнение без утечки времени. Длина проверяется заранее. */
function sameSignature(expectedHex: string, providedHex: string): boolean {
  if (expectedHex.length !== providedHex.length) return false;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expectedHex, 'hex'),
      Buffer.from(providedHex, 'hex'),
    );
  } catch {
    return false;
  }
}

export interface CoinbaseVerifyInput {
  rawBody: Buffer;
  signatureHeader: string | undefined;
  /** Заголовки запроса в нижнем регистре. */
  headers: Record<string, string | string[] | undefined>;
  secret: string;
  nowMs: number;
  maxAgeSeconds: number;
  maxSkewSeconds?: number;
}

export function verifyCoinbaseWebhook(input: CoinbaseVerifyInput): CoinbaseVerifyOutcome {
  if (!input.signatureHeader) {
    return { ok: false, reason: COINBASE_WEBHOOK_REJECT.missingHeader };
  }

  const parsed = parseHeader(input.signatureHeader);
  if (!parsed) return { ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedHeader };

  const ageMs = input.nowMs - parsed.timestamp * 1000;

  if (ageMs > input.maxAgeSeconds * 1000) {
    return { ok: false, reason: COINBASE_WEBHOOK_REJECT.tooOld };
  }

  const skewMs = (input.maxSkewSeconds ?? 60) * 1000;
  if (ageMs < -skewMs) return { ok: false, reason: COINBASE_WEBHOOK_REJECT.tooNew };

  // Значения подписанных заголовков берутся из запроса. Отсутствие
  // любого из перечисленных — отказ, а не пустая строка: пустая
  // строка сделала бы подпись сходящейся для запроса, в котором
  // заголовок просто убрали.
  const names = parsed.headerNames.split(' ').filter((n) => n.length > 0);
  const values: string[] = [];

  for (const name of names) {
    const raw = input.headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;

    if (value == null) return { ok: false, reason: COINBASE_WEBHOOK_REJECT.missingSignedHeader };
    values.push(value);
  }

  const signed = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.${parsed.headerNames}.${values.join('.')}.`, 'utf8'),
    input.rawBody,
  ]);

  const expected = crypto.createHmac('sha256', input.secret).update(signed).digest('hex');

  if (!sameSignature(expected, parsed.v1.toLowerCase())) {
    return { ok: false, reason: COINBASE_WEBHOOK_REJECT.badSignature };
  }

  // Только теперь тело можно разбирать.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input.rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedBody };
  }

  const headerEventId = input.headers['x-event-id'];
  const headerEventType = input.headers['x-event-type'];

  const eventId =
    (Array.isArray(headerEventId) ? headerEventId[0] : headerEventId) ??
    (typeof body.id === 'string' ? body.id : null);

  const eventType =
    (Array.isArray(headerEventType) ? headerEventType[0] : headerEventType) ??
    (typeof body.eventType === 'string' ? body.eventType : null) ??
    (typeof body.type === 'string' ? body.type : null);

  if (!eventId || !eventType) {
    return { ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedBody };
  }

  return { ok: true, event: { eventId, eventType, body } };
}
