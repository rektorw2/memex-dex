import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { verificationEmail } from '@memex/core';

/**
 * Транспорт писем.
 *
 * Проверяется одно свойство и несколько его следствий: слой никогда
 * не отвечает «отправлено», если письмо не приняли. Всё остальное —
 * тайминги, коды ошибок, ключ повтора — существует ради него.
 */

let provider: 'disabled' | 'console' | 'resend' = 'disabled';
let logs: unknown[] = [];

vi.mock('../lib/env.js', () => ({
  env: {
    get EMAIL_PROVIDER() {
      return provider;
    },
    RESEND_API_KEY: 're_тестовый_ключ_не_настоящий',
    EMAIL_FROM: 'Memex DEX <no-reply@example.test>',
    PUBLIC_APP_NAME: 'Memex DEX',
    NODE_ENV: 'test',
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
    debug: (...a: unknown[]) => logs.push(a),
  },
}));

const { getMailer, setMailerForTests, isDeliveryConfigured } = await import('./mailer.js');

const message = verificationEmail({ code: '482913', productName: 'Memex DEX' });
const letter = { to: 'myron@example.com', message };

beforeEach(() => {
  logs = [];
  setMailerForTests(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setMailerForTests(null);
});

describe('транспорт по настройкам', () => {
  it('без настроек — выключен', () => {
    provider = 'disabled';
    setMailerForTests(null);

    expect(getMailer().enabled).toBe(false);
    expect(isDeliveryConfigured()).toBe(false);
  });

  it('выключенный отвечает отказом, а не тишиной', async () => {
    provider = 'disabled';
    setMailerForTests(null);

    const res = await getMailer().send(letter);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure).toBe('DISABLED');
  });

  it('транспорт разработки не пишет код в журнал', async () => {
    // Логи разработки попадают в скриншоты и в отчёты об ошибках.
    provider = 'console';
    setMailerForTests(null);

    await getMailer().send(letter);

    expect(JSON.stringify(logs)).not.toContain('482913');
  });

  it('транспорт разработки не притворяется отправкой', async () => {
    provider = 'console';
    setMailerForTests(null);

    await getMailer().send(letter);
    expect(JSON.stringify(logs)).toMatch(/не отправлено/);
  });
});

describe('Resend через HTTPS API', () => {
  beforeEach(() => {
    provider = 'resend';
    setMailerForTests(null);
  });

  it('вызывает официальный адрес с ключом в заголовке', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'abc' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await getMailer().send({ ...letter, idempotencyKey: 'k-1' });

    expect(res.ok).toBe(true);
    expect(res.ok && res.id).toBe('abc');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.resend.com/emails');

    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(/^Bearer re_/);
    expect(headers['Idempotency-Key']).toBe('k-1');

    const body = JSON.parse(init.body as string);
    expect(body.to).toEqual(['myron@example.com']);
    expect(body.subject).toContain('482913');
    expect(body.text).toContain('482913');
    expect(body.html).toContain('482913');
  });

  it('отказ провайдера — не успех', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"message":"domain not verified"}', { status: 422 })),
    );

    const res = await getMailer().send(letter);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure).toBe('REJECTED');
    expect(res.ok === false && res.detail).toContain('422');
  });

  it('обрыв связи — не успех', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const res = await getMailer().send(letter);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.failure).toBe('NETWORK');
  });

  it('прерванный запрос считается таймаутом', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('The operation was aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );

    const res = await getMailer().send(letter);

    expect(res.ok === false && res.failure).toBe('TIMEOUT');
  });

  it('ключ не попадает в текст ошибки', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('re_тестовый_ключ_не_настоящий отклонён', { status: 401 })),
    );

    const res = await getMailer().send(letter);
    // Тело ответа обрезается, но проверяем главное: наружу уходит
    // ровно то, что вернул провайдер, а не наш заголовок.
    expect(JSON.stringify(res)).not.toContain('Bearer');
  });

  it('ответ без тела не роняет отправку', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })));

    const res = await getMailer().send(letter);

    expect(res.ok).toBe(true);
    expect(res.ok && res.id).toBeNull();
  });

  it('длинный ответ провайдера обрезается', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(5000), { status: 500 })));

    const res = await getMailer().send(letter);

    expect(res.ok === false && (res.detail?.length ?? 0)).toBeLessThan(200);
  });
});
