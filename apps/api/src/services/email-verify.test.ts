import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CODE_TTL_MS, RESEND_COOLDOWN_MS, VERIFY_RESULT } from '@memex/core';
import type { Mailer, OutgoingEmail, SendResult } from './mailer.js';

/**
 * Выдача и проверка кода подтверждения.
 *
 * Проверяется то, что нельзя увидеть в правилах: порядок шагов.
 * Правила говорят, годен ли код; здесь — не осталось ли человека
 * с паузой, но без письма, и не ушло ли два письма там, где годен
 * один код.
 *
 * База подменена. Настоящая проверяется отдельно, на Postgres;
 * здесь важно, в каком порядке к ней обращаются и что происходит,
 * когда отправка не удалась.
 */

const NOW = Date.UTC(2026, 7, 22, 10, 0, 0);
let now = NOW;

/** Строка пользователя в подменённой базе. */
interface Row {
  email: string;
  emailVerifiedAt: Date | null;
  emailCodeHash: string | null;
  emailCodeIssuedAt: Date | null;
  emailCodeExpires: Date | null;
  emailCodeAttempts: number;
}

let row: Row;
let sentTo: OutgoingEmail[] = [];
let logs: unknown[] = [];
let nodeEnv: 'development' | 'production' = 'development';

function freshRow(): Row {
  return {
    email: 'myron@example.com',
    emailVerifiedAt: null,
    emailCodeHash: null,
    emailCodeIssuedAt: null,
    emailCodeExpires: null,
    emailCodeAttempts: 0,
  };
}

/** Условия updateMany, которые нам нужны. Не универсальный движок. */
function matches(where: Record<string, unknown>): boolean {
  if ('emailVerifiedAt' in where && where.emailVerifiedAt === null && row.emailVerifiedAt !== null) {
    return false;
  }

  if ('emailCodeHash' in where && where.emailCodeHash !== row.emailCodeHash) return false;

  if (Array.isArray(where.OR)) {
    const edge = (where.OR as Array<Record<string, { lte?: Date }>>).find(
      (c) => c.emailCodeIssuedAt?.lte,
    )?.emailCodeIssuedAt?.lte;

    const free = row.emailCodeIssuedAt == null || (edge != null && row.emailCodeIssuedAt <= edge);
    if (!free) return false;
  }

  return true;
}

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async () => ({ ...row })),
      updateMany: vi.fn(async ({ where, data }: never & { where: never; data: never }) => {
        if (!matches(where as Record<string, unknown>)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: vi.fn(async ({ data }: never & { data: never }) => {
        const d = data as Record<string, unknown>;
        if (d.emailCodeAttempts && typeof d.emailCodeAttempts === 'object') {
          row.emailCodeAttempts += (d.emailCodeAttempts as { increment: number }).increment;
        } else {
          Object.assign(row, d);
        }
        return { ...row };
      }),
    },
  },
}));

vi.mock('../lib/clock.js', () => ({
  serverNow: () => new Date(now),
  serverNowMs: () => now,
}));

vi.mock('../lib/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
    debug: (...a: unknown[]) => logs.push(a),
  },
}));

vi.mock('../lib/env.js', () => ({
  env: {
    get NODE_ENV() {
      return nodeEnv;
    },
    EMAIL_PROVIDER: 'console',
    PUBLIC_APP_NAME: 'Memex DEX',
  },
}));

const { issueCode, verifyCode } = await import('./email-verify.js');
const { setMailerForTests } = await import('./mailer.js');

function mailer(over: Partial<Mailer> = {}, result?: SendResult): Mailer {
  return {
    name: 'console',
    enabled: true,
    async send(email) {
      sentTo.push(email);
      return result ?? { ok: true, id: 'msg-1' };
    },
    ...over,
  };
}

beforeEach(() => {
  now = NOW;
  row = freshRow();
  sentTo = [];
  logs = [];
  nodeEnv = 'development';
  setMailerForTests(mailer());
});

describe('успешная доставка', () => {
  it('письмо уходит на адрес из записи пользователя', async () => {
    const res = await issueCode('u1');

    expect(res.ok).toBe(true);
    expect(sentTo).toHaveLength(1);
    expect(sentTo[0]!.to).toBe('myron@example.com');
  });

  it('хеш кода сохранён, сам код — нет', async () => {
    await issueCode('u1');

    expect(row.emailCodeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(sentTo[0]!.message.text).not.toContain(row.emailCodeHash);
  });

  it('срок действия — пятнадцать минут от выдачи', async () => {
    const res = await issueCode('u1');

    expect(res.ok && res.expiresAt.getTime()).toBe(NOW + CODE_TTL_MS);
  });

  it('ключ повтора привязан к коду', async () => {
    // Повторная попытка отправки того же кода не создаст второе
    // письмо у провайдера.
    await issueCode('u1');

    expect(sentTo[0]!.idempotencyKey).toContain('verify-u1-');
  });

  it('код есть в письме', async () => {
    await issueCode('u1');

    expect(sentTo[0]!.message.text).toMatch(/\b\d{6}\b/);
  });
});

describe('транспорт не настроен', () => {
  beforeEach(() => setMailerForTests(mailer({ enabled: false })));

  it('отказ вместо мнимого успеха', async () => {
    const res = await issueCode('u1');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toBe('EMAIL_DELIVERY_UNAVAILABLE');
  });

  it('код не создаётся вовсе', async () => {
    // Иначе пауза повторной отправки занята письмом, которого нет.
    await issueCode('u1');

    expect(row.emailCodeHash).toBeNull();
    expect(row.emailCodeIssuedAt).toBeNull();
  });

  it('письмо не отправлялось', async () => {
    await issueCode('u1');
    expect(sentTo).toHaveLength(0);
  });
});

describe('провайдер отказал или не ответил', () => {
  for (const failure of ['REJECTED', 'TIMEOUT', 'NETWORK'] as const) {
    describe(failure, () => {
      beforeEach(() => setMailerForTests(mailer({}, { ok: false, failure })));

      it('ответ сообщает о неудаче', async () => {
        const res = await issueCode('u1');

        expect(res.ok).toBe(false);
        expect(res.ok === false && res.reason).toBe('EMAIL_DELIVERY_FAILED');
        expect(res.ok === false && res.failure).toBe(failure);
      });

      it('пауза не остаётся: письма не было', async () => {
        // Самая дорогая ошибка этого сценария — запереть человека
        // на минуту ожидания письма, которое не ушло.
        const res = await issueCode('u1');

        expect(res.ok === false && res.retryAfterSeconds).toBe(0);
        expect(row.emailCodeIssuedAt).toBeNull();
        expect(row.emailCodeHash).toBeNull();
      });

      it('повторить можно сразу, не дожидаясь паузы', async () => {
        await issueCode('u1');

        // Провайдер починился. Время не двигаем: пауза не должна была
        // начаться, раз письмо не ушло.
        setMailerForTests(mailer());
        sentTo = [];

        const again = await issueCode('u1');
        expect(again.ok).toBe(true);
        expect(sentTo).toHaveLength(1);
      });

      it('негодный код в базе не остаётся', async () => {
        await issueCode('u1');
        const check = await verifyCode('u1', '123456');

        expect(check.result).toBe(VERIFY_RESULT.noCode);
      });
    });
  }
});

describe('пауза между письмами', () => {
  it('второй запрос сразу — отказ с остатком', async () => {
    await issueCode('u1');
    const second = await issueCode('u1');

    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('TOO_SOON');
    expect(second.ok === false && second.retryAfterSeconds).toBe(RESEND_COOLDOWN_MS / 1000);
  });

  it('после паузы письмо уходит снова', async () => {
    await issueCode('u1');
    now = NOW + RESEND_COOLDOWN_MS;

    const second = await issueCode('u1');
    expect(second.ok).toBe(true);
    expect(sentTo).toHaveLength(2);
  });

  it('новый код заменяет старый', async () => {
    await issueCode('u1');
    const first = row.emailCodeHash;
    now = NOW + RESEND_COOLDOWN_MS;
    await issueCode('u1');

    expect(row.emailCodeHash).not.toBe(first);
  });
});

describe('одновременные запросы', () => {
  it('уходит одно письмо, годен один код', async () => {
    // Без атомарного занятия слота оба запроса сгенерировали бы код,
    // оба отправили бы письмо, и годным оказался бы записанный
    // последним — а человек читал бы первое письмо.
    const [a, b] = await Promise.all([issueCode('u1'), issueCode('u1')]);

    const ok = [a, b].filter((r) => r.ok);
    expect(ok).toHaveLength(1);
    expect(sentTo).toHaveLength(1);
  });

  it('проигравший получает паузу, а не ошибку', async () => {
    const results = await Promise.all([issueCode('u1'), issueCode('u1')]);
    const denied = results.find((r) => !r.ok);

    expect(denied && denied.ok === false && denied.reason).toBe('TOO_SOON');
  });

  it('годен именно отправленный код', async () => {
    await Promise.all([issueCode('u1'), issueCode('u1')]);
    const code = sentTo[0]!.message.text.match(/\b(\d{6})\b/)![1]!;

    expect((await verifyCode('u1', code)).result).toBe(VERIFY_RESULT.ok);
  });
});

describe('журналы', () => {
  it('код в журнал не попадает', async () => {
    await issueCode('u1');
    const code = sentTo[0]!.message.text.match(/\b(\d{6})\b/)![1]!;

    expect(JSON.stringify(logs)).not.toContain(code);
  });

  it('полного адреса в журнале нет', async () => {
    await issueCode('u1');
    const text = JSON.stringify(logs);

    expect(text).not.toContain('myron@example.com');
    expect(text).toContain('m***@e***.com');
  });

  it('хеша кода в журнале тоже нет', async () => {
    await issueCode('u1');
    expect(JSON.stringify(logs)).not.toContain(row.emailCodeHash);
  });

  it('при отказе адрес всё равно скрыт', async () => {
    setMailerForTests(mailer({}, { ok: false, failure: 'REJECTED', detail: 'HTTP 422' }));
    await issueCode('u1');

    expect(JSON.stringify(logs)).not.toContain('myron@example.com');
  });
});

describe('код в ответе', () => {
  it('вне production и на транспорте разработки код возвращается', async () => {
    const res = await issueCode('u1');
    expect(res.ok && res.devCode).toMatch(/^\d{6}$/);
  });

  it('в production кода в ответе нет', async () => {
    nodeEnv = 'production';
    const res = await issueCode('u1');

    expect(res.ok).toBe(true);
    expect(res.ok && res.devCode).toBeUndefined();
  });

  it('на настоящем транспорте кода в ответе нет даже в разработке', async () => {
    // Письмо ушло по-настоящему — дублировать код в ответе незачем.
    setMailerForTests(mailer({ name: 'resend' }));
    const res = await issueCode('u1');

    expect(res.ok && res.devCode).toBeUndefined();
  });
});

describe('проверка кода', () => {
  async function issued(): Promise<string> {
    await issueCode('u1');
    return sentTo[0]!.message.text.match(/\b(\d{6})\b/)![1]!;
  }

  it('верный код подтверждает адрес', async () => {
    const code = await issued();
    const res = await verifyCode('u1', code);

    expect(res.result).toBe(VERIFY_RESULT.ok);
    expect(row.emailVerifiedAt).not.toBeNull();
  });

  it('код стирается после подтверждения', async () => {
    const code = await issued();
    await verifyCode('u1', code);

    expect(row.emailCodeHash).toBeNull();
  });

  it('неверный код отклоняется и считается попыткой', async () => {
    await issued();
    const res = await verifyCode('u1', '000000');

    expect(res.result).toBe(VERIFY_RESULT.wrong);
    expect(row.emailCodeAttempts).toBe(1);
  });

  it('истёкший код отклоняется', async () => {
    const code = await issued();
    now = NOW + CODE_TTL_MS;

    expect((await verifyCode('u1', code)).result).toBe(VERIFY_RESULT.expired);
  });

  it('после пяти неудач код сгорает', async () => {
    const code = await issued();
    for (let i = 0; i < 5; i++) await verifyCode('u1', '000000');

    expect((await verifyCode('u1', code)).result).toBe(VERIFY_RESULT.tooManyAttempts);
  });

  it('подтверждённый адрес повторно не подтверждают', async () => {
    const code = await issued();
    await verifyCode('u1', code);

    expect((await verifyCode('u1', code)).result).toBe(VERIFY_RESULT.alreadyVerified);
  });

  it('подтверждённому адресу код больше не выдают', async () => {
    const code = await issued();
    await verifyCode('u1', code);
    now = NOW + RESEND_COOLDOWN_MS;

    const res = await issueCode('u1');
    expect(res.ok === false && res.reason).toBe('ALREADY_VERIFIED');
  });

  it('код не той формы отклоняется до базы', async () => {
    await issued();
    const before = row.emailCodeAttempts;

    expect((await verifyCode('u1', 'abcdef')).result).toBe(VERIFY_RESULT.wrong);
    expect(row.emailCodeAttempts).toBe(before);
  });
});
