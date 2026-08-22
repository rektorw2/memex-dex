import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifyCoinbaseWebhook, COINBASE_WEBHOOK_REJECT } from './coinbase-webhook.js';

/**
 * Подпись вебхука Coinbase.
 *
 * Публичный адрес отделён от выдачи платной подписки ровно этой
 * проверкой, поэтому каждый способ её обойти проверяется отдельно.
 * Сети здесь нет: подписи собираются тем же алгоритмом, что и у
 * провайдера, и это единственное, что нужно.
 */

const SECRET = 'тестовый секрет вебхука, не настоящий';
const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

const BODY = Buffer.from(
  JSON.stringify({ id: 'evt_1', partnerUserRef: 'mx_ref', status: 'success' }),
  'utf8',
);

function sign(input: {
  body?: Buffer;
  secret?: string;
  timestamp?: number;
  headerNames?: string;
  headerValues?: string[];
}): string {
  const body = input.body ?? BODY;
  const t = input.timestamp ?? Math.floor(NOW / 1000);
  const h = input.headerNames ?? 'x-event-type x-event-id';
  const values = input.headerValues ?? ['onramp.transaction.success', 'evt_1'];

  const signed = Buffer.concat([
    Buffer.from(`${t}.${h}.${values.join('.')}.`, 'utf8'),
    body,
  ]);

  const v1 = crypto.createHmac('sha256', input.secret ?? SECRET).update(signed).digest('hex');

  return `t=${t},v0=deadbeef,h=${h},v1=${v1}`;
}

const HEADERS: Record<string, string> = {
  'x-event-type': 'onramp.transaction.success',
  'x-event-id': 'evt_1',
};

function verify(over: Partial<Parameters<typeof verifyCoinbaseWebhook>[0]> = {}) {
  return verifyCoinbaseWebhook({
    rawBody: BODY,
    signatureHeader: sign({}),
    headers: { ...HEADERS },
    secret: SECRET,
    nowMs: NOW,
    maxAgeSeconds: 300,
    ...over,
  });
}

describe('подпись вебхука Coinbase', () => {
  it('принимает верную подпись и отдаёт разобранное событие', () => {
    const res = verify();

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.event.eventId).toBe('evt_1');
    expect(res.event.eventType).toBe('onramp.transaction.success');
    expect(res.event.body.partnerUserRef).toBe('mx_ref');
  });

  it('отклоняет запрос без заголовка подписи', () => {
    const res = verify({ signatureHeader: undefined });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.missingHeader });
  });

  it('отклоняет подпись, собранную на другом секрете', () => {
    const res = verify({ signatureHeader: sign({ secret: 'другой секрет' }) });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.badSignature });
  });

  it('отклоняет подпись при изменённом теле', () => {
    const res = verify({ rawBody: Buffer.from(JSON.stringify({ id: 'evt_1', amount: 1 })) });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.badSignature });
  });

  it('отклоняет подмену вида события в заголовке', () => {
    // Тело подлинное, подпись подлинная, но `x-event-type` подписан
    // вместе с ней — переставить `updated` на `success` не выйдет.
    const res = verify({
      headers: { ...HEADERS, 'x-event-type': 'onramp.transaction.updated' },
    });

    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.badSignature });
  });

  it('отклоняет запрос, где подписанный заголовок убрали', () => {
    // Пустая строка вместо отсутствующего значения сделала бы подпись
    // сходящейся для запроса без заголовка.
    const res = verify({ headers: { 'x-event-id': 'evt_1' } });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.missingSignedHeader });
  });

  it('отклоняет заголовок с повторяющимися частями', () => {
    const good = sign({});
    const res = verify({ signatureHeader: `t=${Math.floor(NOW / 1000)},${good}` });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedHeader });
  });

  it('отклоняет заголовок без v1', () => {
    const res = verify({ signatureHeader: 't=1,v0=aa,h=x-event-type' });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedHeader });
  });

  it('отклоняет v1 не в шестнадцатеричной записи', () => {
    const res = verify({ signatureHeader: 't=1,h=x-event-type,v1=не-hex' });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedHeader });
  });

  it('отклоняет слишком старое событие', () => {
    const old = Math.floor(NOW / 1000) - 3600;
    const res = verify({ signatureHeader: sign({ timestamp: old }) });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.tooOld });
  });

  it('отклоняет событие из будущего', () => {
    const ahead = Math.floor(NOW / 1000) + 3600;
    const res = verify({ signatureHeader: sign({ timestamp: ahead }) });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.tooNew });
  });

  it('прощает небольшое расхождение часов', () => {
    const ahead = Math.floor(NOW / 1000) + 30;
    expect(verify({ signatureHeader: sign({ timestamp: ahead }) }).ok).toBe(true);
  });

  it('отклоняет тело, которое не разбирается, уже после проверки подписи', () => {
    const body = Buffer.from('{это не json', 'utf8');
    const res = verify({ rawBody: body, signatureHeader: sign({ body }) });
    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedBody });
  });

  it('берёт идентификатор события из тела, когда заголовка нет', () => {
    const headerNames = 'x-event-type';
    const res = verify({
      headers: { 'x-event-type': 'onramp.transaction.success' },
      signatureHeader: sign({ headerNames, headerValues: ['onramp.transaction.success'] }),
    });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.event.eventId).toBe('evt_1');
  });

  it('отклоняет событие без вида и без идентификатора', () => {
    const body = Buffer.from(JSON.stringify({ partnerUserRef: 'mx_ref' }), 'utf8');
    const res = verify({
      rawBody: body,
      headers: {},
      signatureHeader: sign({ body, headerNames: '', headerValues: [] }),
    });

    expect(res).toEqual({ ok: false, reason: COINBASE_WEBHOOK_REJECT.malformedBody });
  });
});
