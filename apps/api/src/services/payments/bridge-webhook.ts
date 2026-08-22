import crypto from 'node:crypto';

/**
 * Проверка подписи вебхука Bridge.
 *
 * Единственное, что стоит между чужим запросом и выдачей платной
 * подписки. Всё остальное — сверка сумм, адресов, состояний — имеет
 * смысл только после того, как доказано: событие прислал провайдер.
 *
 * Поэтому здесь три правила, каждое из которых нарушается легко
 * и незаметно.
 *
 * **Проверяется байт в байт то, что пришло.** Не разобранный JSON
 * и не пересобранная строка: `JSON.parse` с последующим
 * `JSON.stringify` меняет порядок ключей, пробелы и представление
 * чисел, и подпись перестаёт сходиться — либо, что хуже, сходится
 * для тела, отличного от подписанного.
 *
 * **Разбор тела происходит после проверки.** Разобрать чужой JSON
 * до проверки подписи значит выполнить чужой ввод раньше, чем
 * доказано, что он не чужой.
 *
 * **Время проверяется с обеих сторон.** Старое событие — это
 * повтор записанного запроса; событие из будущего — либо расхождение
 * часов, либо попытка положить в базу запись, которая переживёт
 * окно проверки.
 */

export const WEBHOOK_REJECT = {
  missingHeader: 'MISSING_SIGNATURE',
  malformedHeader: 'MALFORMED_SIGNATURE',
  tooOld: 'TIMESTAMP_TOO_OLD',
  tooNew: 'TIMESTAMP_IN_FUTURE',
  badSignature: 'BAD_SIGNATURE',
  badKey: 'BAD_PUBLIC_KEY',
  malformedBody: 'MALFORMED_BODY',
} as const;

export type WebhookRejectCode = (typeof WEBHOOK_REJECT)[keyof typeof WEBHOOK_REJECT];

export interface VerifiedEvent {
  eventId: string;
  eventType: string;
  eventCategory: string;
  eventCreatedAt: Date;
  /** Объект события. Разобран только после успешной проверки. */
  object: Record<string, unknown>;
}

export type VerifyOutcome =
  | { ok: true; event: VerifiedEvent }
  | { ok: false; reason: WebhookRejectCode };

/**
 * Разбор заголовка `t=<миллисекунды>,v0=<подпись в base64>`.
 *
 * Части ищутся по имени, а не по месту: порядок в заголовке
 * провайдер не обещает, и разбор по индексу сломался бы молча.
 */
function parseHeader(header: string): { timestamp: number; signature: string } | null {
  let timestamp: string | null = null;
  let signature: string | null = null;

  for (const part of header.split(',')) {
    const trimmed = part.trim();
    if (trimmed.startsWith('t=')) timestamp = trimmed.slice(2);
    else if (trimmed.startsWith('v0=')) signature = trimmed.slice(3);
  }

  if (!timestamp || !signature) return null;
  if (!/^\d{1,20}$/.test(timestamp)) return null;

  const ms = Number(timestamp);
  if (!Number.isSafeInteger(ms)) return null;

  return { timestamp: ms, signature };
}

/**
 * Строгое декодирование base64.
 *
 * `Buffer.from(s, 'base64')` молча пропускает мусор и обрезает всё,
 * что не разобралось. Подпись, отличающаяся от настоящей лишним
 * символом, не должна превращаться в укороченную настоящую.
 */
function strictBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  if (value.length % 4 !== 0) return null;

  const decoded = Buffer.from(value, 'base64');
  // Обратная сборка обязана совпасть с исходной строкой. Это и есть
  // строгость: любое послабление означает, что мы приняли не то,
  // что прислали.
  if (decoded.toString('base64') !== value) return null;

  return decoded;
}

/**
 * Проверка одной из двух форм подписи.
 *
 * В документации провайдера примеры расходятся: текст спецификации
 * и три примера из четырёх подписывают SHA-256 *дайджест* строки
 * `timestamp.body`, четвёртый — саму строку. Обе формы одинаково
 * стойки: каждая требует закрытого ключа провайдера и жёстко
 * привязана к тем же телу и времени. Принимаются обе, потому что
 * отвергать настоящие события из-за противоречия в чужой
 * документации — худший исход, чем проверить два варианта.
 */
function verifyRsa(key: crypto.KeyObject, data: Buffer, signature: Buffer): boolean {
  const digest = crypto.createHash('sha256').update(data).digest();

  const overDigest = crypto.verify('sha256', digest, key, signature);
  if (overDigest) return true;

  return crypto.verify('sha256', data, key, signature);
}

export interface VerifyInput {
  /** Тело запроса в исходных байтах. Не строка и не разобранный JSON. */
  rawBody: Buffer;
  signatureHeader: string | undefined;
  publicKeyPem: string;
  nowMs: number;
  maxAgeSeconds: number;
  /** Насколько событие может опережать наши часы. */
  maxSkewSeconds?: number;
}

export function verifyBridgeWebhook(input: VerifyInput): VerifyOutcome {
  if (!input.signatureHeader) return { ok: false, reason: WEBHOOK_REJECT.missingHeader };

  const parsed = parseHeader(input.signatureHeader);
  if (!parsed) return { ok: false, reason: WEBHOOK_REJECT.malformedHeader };

  const ageMs = input.nowMs - parsed.timestamp;

  if (ageMs > input.maxAgeSeconds * 1000) return { ok: false, reason: WEBHOOK_REJECT.tooOld };

  // Событие из будущего: либо часы разошлись, либо кто-то готовит
  // запись, которая переживёт окно проверки повторов.
  const skewMs = (input.maxSkewSeconds ?? 60) * 1000;
  if (ageMs < -skewMs) return { ok: false, reason: WEBHOOK_REJECT.tooNew };

  const signature = strictBase64(parsed.signature);
  if (!signature) return { ok: false, reason: WEBHOOK_REJECT.badSignature };

  let key: crypto.KeyObject;
  try {
    key = crypto.createPublicKey(input.publicKeyPem);
  } catch {
    return { ok: false, reason: WEBHOOK_REJECT.badKey };
  }

  // Подписанные данные собираются из тех же байтов, что пришли.
  const signed = Buffer.concat([Buffer.from(`${parsed.timestamp}.`, 'utf8'), input.rawBody]);

  let valid = false;
  try {
    valid = verifyRsa(key, signed, signature);
  } catch {
    valid = false;
  }

  if (!valid) return { ok: false, reason: WEBHOOK_REJECT.badSignature };

  // Только теперь тело можно разбирать.
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(input.rawBody.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: WEBHOOK_REJECT.malformedBody };
  }

  const eventId = typeof body.event_id === 'string' ? body.event_id : null;
  const eventType = typeof body.event_type === 'string' ? body.event_type : null;
  const eventCategory = typeof body.event_category === 'string' ? body.event_category : '';
  const createdRaw = typeof body.event_created_at === 'string' ? body.event_created_at : null;
  const object =
    body.event_object && typeof body.event_object === 'object'
      ? (body.event_object as Record<string, unknown>)
      : null;

  if (!eventId || !eventType || !object) {
    return { ok: false, reason: WEBHOOK_REJECT.malformedBody };
  }

  const createdAt = createdRaw ? new Date(createdRaw) : new Date(parsed.timestamp);
  if (Number.isNaN(createdAt.getTime())) {
    return { ok: false, reason: WEBHOOK_REJECT.malformedBody };
  }

  return {
    ok: true,
    event: { eventId, eventType, eventCategory, eventCreatedAt: createdAt, object },
  };
}
