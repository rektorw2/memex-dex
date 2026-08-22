import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { verifyBridgeWebhook, WEBHOOK_REJECT } from './bridge-webhook.js';

/**
 * Проверка подписи вебхука.
 *
 * Единственное, что отделяет чужой запрос от выдачи платной
 * подписки. Ключи здесь настоящие, но одноразовые: генерируются
 * при запуске набора и никуда не сохраняются.
 */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const MAX_AGE = 600;

let privateKey: crypto.KeyObject;
let publicKeyPem: string;
let otherPrivateKey: crypto.KeyObject;

beforeAll(() => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKey = pair.privateKey;
  publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  otherPrivateKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
});

const body = (over: Record<string, unknown> = {}): Buffer =>
  Buffer.from(
    JSON.stringify({
      api_version: 'v0',
      event_id: 'evt_1',
      event_category: 'transfer',
      event_type: 'transfer.updated',
      event_created_at: new Date(NOW).toISOString(),
      event_object: { id: 'transfer_1', state: 'payment_processed' },
      ...over,
    }),
    'utf8',
  );

/** Подпись как её делает провайдер: над дайджестом `timestamp.body`. */
function sign(raw: Buffer, timestampMs: number, key = privateKey): string {
  const signed = Buffer.concat([Buffer.from(`${timestampMs}.`, 'utf8'), raw]);
  const digest = crypto.createHash('sha256').update(signed).digest();
  const signature = crypto.sign('sha256', digest, key);

  return `t=${timestampMs},v0=${signature.toString('base64')}`;
}

function verify(over: Partial<Parameters<typeof verifyBridgeWebhook>[0]> = {}) {
  const raw = over.rawBody ?? body();

  return verifyBridgeWebhook({
    rawBody: raw,
    signatureHeader: sign(raw, NOW),
    publicKeyPem,
    nowMs: NOW,
    maxAgeSeconds: MAX_AGE,
    ...over,
  });
}

describe('подпись', () => {
  it('настоящая подпись принимается', () => {
    const res = verify();

    expect(res.ok).toBe(true);
    expect(res.ok && res.event.eventId).toBe('evt_1');
    expect(res.ok && res.event.eventType).toBe('transfer.updated');
  });

  it('без заголовка — отказ', () => {
    const res = verify({ signatureHeader: undefined });

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.missingHeader);
  });

  it('чужой ключ не подходит', () => {
    const raw = body();
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW, otherPrivateKey) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.badSignature);
  });

  it('изменённое после подписи тело не проходит', () => {
    // Тело подменяется на такое же по смыслу, но с другой суммой —
    // именно так выглядела бы попытка получить подписку даром.
    const original = body();
    const header = sign(original, NOW);
    const tampered = body({ event_object: { id: 'transfer_1', state: 'payment_processed', amount: '0.01' } });

    const res = verify({ rawBody: tampered, signatureHeader: header });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.badSignature);
  });

  it('пересобранный JSON не проходит', () => {
    // Разбор и обратная сборка меняют порядок ключей и пробелы.
    // Проверять надо байты, а не смысл.
    const original = body();
    const header = sign(original, NOW);
    const reserialized = Buffer.from(
      JSON.stringify(JSON.parse(original.toString('utf8')), null, 2),
      'utf8',
    );

    const res = verify({ rawBody: reserialized, signatureHeader: header });
    expect(res.ok).toBe(false);
  });

  it('заголовок без нужных частей отклоняется', () => {
    for (const header of ['', 't=123', 'v0=abc', 'мусор', 't=,v0=', 't=abc,v0=xyz']) {
      const res = verify({ signatureHeader: header });
      expect(res.ok, header).toBe(false);
    }
  });

  it('порядок частей заголовка значения не имеет', () => {
    const raw = body();
    const full = sign(raw, NOW);
    const sig = full.split(',')[1]!;
    const res = verify({ rawBody: raw, signatureHeader: `${sig},t=${NOW}` });

    expect(res.ok).toBe(true);
  });

  it('подпись не в строгом base64 отклоняется', () => {
    const raw = body();
    const full = sign(raw, NOW);
    const sig = full.split('v0=')[1]!;

    // Лишний символ не должен молча обрезаться до настоящей подписи.
    const res = verify({ rawBody: raw, signatureHeader: `t=${NOW},v0=${sig}!` });
    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.badSignature);
  });

  it('негодный открытый ключ — отдельная причина', () => {
    const res = verify({ publicKeyPem: 'не ключ' });
    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.badKey);
  });
});

describe('время события', () => {
  it('свежее событие принимается', () => {
    const raw = body();
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW - 60_000) });

    expect(res.ok).toBe(true);
  });

  it('ровно на границе возраста ещё принимается', () => {
    const raw = body();
    const ts = NOW - MAX_AGE * 1000;

    expect(verify({ rawBody: raw, signatureHeader: sign(raw, ts) }).ok).toBe(true);
  });

  it('старше десяти минут — отказ', () => {
    // Записанный чужой запрос, отправленный повторно.
    const raw = body();
    const ts = NOW - MAX_AGE * 1000 - 1;
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, ts) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.tooOld);
  });

  it('слишком далеко в будущем — отказ', () => {
    // Либо часы разошлись, либо кто-то готовит запись, которая
    // переживёт окно проверки повторов.
    const raw = body();
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW + 10 * 60_000) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.tooNew);
  });

  it('небольшое опережение допускается', () => {
    const raw = body();
    expect(verify({ rawBody: raw, signatureHeader: sign(raw, NOW + 30_000) }).ok).toBe(true);
  });
});

describe('тело события', () => {
  it('разбирается только после проверки подписи', () => {
    // Негодный JSON с настоящей подписью доходит до разбора
    // и отклоняется отдельной причиной — значит, порядок верный.
    const raw = Buffer.from('{не json', 'utf8');
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.malformedBody);
  });

  it('без идентификатора события — отказ', () => {
    const raw = body({ event_id: undefined });
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.malformedBody);
  });

  it('без объекта события — отказ', () => {
    const raw = body({ event_object: undefined });
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.malformedBody);
  });

  it('объект события доступен целиком', () => {
    const res = verify();

    expect(res.ok && res.event.object).toEqual({ id: 'transfer_1', state: 'payment_processed' });
  });

  it('негодная дата события отклоняется', () => {
    const raw = body({ event_created_at: 'позавчера' });
    const res = verify({ rawBody: raw, signatureHeader: sign(raw, NOW) });

    expect(res.ok === false && res.reason).toBe(WEBHOOK_REJECT.malformedBody);
  });
});
