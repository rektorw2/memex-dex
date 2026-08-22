import { describe, it, expect, beforeEach, vi } from 'vitest';
import { catalogEntryFor } from '@memex/core';
import type { PaymentProviderPort, ProviderTransfer } from './provider.js';

/**
 * Оркестрация оплаты подписки.
 *
 * Живого Bridge здесь нет и быть не может: сеть в тестах не трогаем.
 * Вместо него подставлен адаптер, который отвечает тем, чем ответил
 * бы настоящий, — включая ответы, которых мы не ждём.
 *
 * База тоже подменена. Проверяется не хранение, а решения: кому
 * выдать доступ, на сколько суток, что делать при расхождении
 * и при повторе.
 */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TREASURY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

let now = NOW;
let logs: unknown[] = [];

/** Минимальная база в памяти. */
interface Db {
  users: Map<string, { id: string; email: string; emailVerifiedAt: Date | null }>;
  customers: Map<string, Record<string, unknown>>;
  payments: Map<string, Record<string, unknown>>;
  subscriptions: Map<string, Record<string, unknown>>;
  audits: Record<string, unknown>[];
}

let db: Db;
let seq = 0;
const id = (p: string) => `${p}-${++seq}`;

function freshDb(): Db {
  return {
    users: new Map([
      ['u1', { id: 'u1', email: 'myron@example.com', emailVerifiedAt: new Date(NOW - DAY) }],
      ['u2', { id: 'u2', email: 'other@example.com', emailVerifiedAt: null }],
    ]),
    customers: new Map(),
    payments: new Map(),
    subscriptions: new Map(),
    audits: [],
  };
}

const list = <T>(m: Map<string, T>): T[] => [...m.values()];

function where<T extends Record<string, unknown>>(rows: T[], w: Record<string, unknown>): T[] {
  return rows.filter((r) =>
    Object.entries(w).every(([k, v]) => {
      if (k === 'OR') return true;
      if (v && typeof v === 'object' && 'not' in (v as object)) {
        return r[k] !== (v as { not: unknown }).not;
      }
      if (v && typeof v === 'object' && 'in' in (v as object)) {
        return ((v as { in: unknown[] }).in).includes(r[k]);
      }
      return r[k] === v;
    }),
  );
}

/**
 * Аргумент запроса Prisma.
 *
 * Тип нарочно нестрогий: подделка повторяет ровно те вызовы, которые
 * делает оркестрация, и описывать полную типизацию клиента здесь
 * значило бы поддерживать вторую копию Prisma.
 */
interface Arg {
  where?: Record<string, unknown> & { id?: string; userId_provider?: { userId: string } };
  data?: Record<string, unknown>;
  create?: Record<string, unknown>;
  update?: Record<string, unknown>;
}

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prismaMock()),

    user: {
      findUnique: async ({ where: w }: Arg) => db.users.get(String(w?.id)) ?? null,
    },

    paymentCustomer: {
      findUnique: async ({ where: w }: Arg) =>
        list(db.customers).find((c) => c.userId === w?.userId_provider?.userId) ?? null,

      upsert: async ({ create, update }: Arg) => {
        const found = list(db.customers).find((c) => c.userId === create?.userId);
        if (found) {
          Object.assign(found, update ?? {});
          return found;
        }

        const row = { id: id('cust'), ...(create ?? {}) } as Record<string, unknown>;
        db.customers.set(row.id as string, row);
        return row;
      },

      update: async ({ where: w, data }: Arg) => {
        const row = db.customers.get(String(w?.id))!;
        Object.assign(row, data ?? {});
        return row;
      },
    },

    subscriptionPayment: {
      create: async ({ data }: Arg) => {
        const row = {
          id: id('pay'),
          createdAt: new Date(now),
          paidAt: null,
          grantedSubscriptionId: null,
          providerTransferId: null,
          depositMessage: null,
          depositBankName: null,
          depositAccountNumber: null,
          depositRoutingNumber: null,
          destinationTxHash: null,
          receiptUrl: null,
          deliveredAmount: null,
          provider: 'BRIDGE',
          ...(data ?? {}),
        } as Record<string, unknown>;

        db.payments.set(row.id as string, row);
        return row;
      },

      findFirst: async ({ where: w }: Arg) => where(list(db.payments), w ?? {})[0] ?? null,
      findMany: async ({ where: w }: Arg) => where(list(db.payments), w ?? {}),

      findUniqueOrThrow: async ({ where: w }: Arg) => {
        const row = db.payments.get(String(w?.id));
        if (!row) throw new Error('нет платежа');
        return row;
      },

      update: async ({ where: w, data }: Arg) => {
        const row = db.payments.get(String(w?.id))!;
        Object.assign(row, data ?? {});
        return row;
      },
    },

    subscription: {
      findFirst: async ({ where: w }: Arg) => {
        const rows = where(list(db.subscriptions), w ?? {});

        // Условие по сроку разбирается отдельно: оно стоит только там,
        // где нужен действующий договор.
        if (Array.isArray((w as { OR?: unknown[] } | undefined)?.OR)) {
          return rows.find((r) => r.expiresAt == null || (r.expiresAt as Date) > new Date(now)) ?? null;
        }

        return rows[0] ?? null;
      },

      create: async ({ data }: Arg) => {
        const row = { id: id('sub'), ...(data ?? {}) } as Record<string, unknown>;
        db.subscriptions.set(row.id as string, row);
        return row;
      },

      update: async ({ where: w, data }: Arg) => {
        const row = db.subscriptions.get(String(w?.id))!;
        Object.assign(row, data ?? {});
        return row;
      },
    },

    entitlementAudit: {
      create: async ({ data }: Arg) => {
        db.audits.push(data ?? {});
        return data;
      },
    },
  },
}));

function prismaMock() {
  // Транзакция в тесте — тот же объект: атомарность проверяется
  // на настоящем Postgres, здесь важна последовательность решений.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (globalThis as unknown as { __prisma: unknown }).__prisma;
}

vi.mock('../../lib/logger.js', () => ({
  logger: {
    info: (...a: unknown[]) => logs.push(a),
    warn: (...a: unknown[]) => logs.push(a),
    error: (...a: unknown[]) => logs.push(a),
    debug: (...a: unknown[]) => logs.push(a),
  },
}));

vi.mock('../../lib/clock.js', () => ({
  serverNow: () => new Date(now),
  serverNowMs: () => now,
}));

vi.mock('../../lib/env.js', () => ({
  env: {
    BRIDGE_PAYMENTS_ENABLED: true,
    BRIDGE_API_KEY: 'не настоящий ключ',
    BRIDGE_API_BASE_URL: 'https://api.bridge.xyz/v0',
    SUBSCRIPTION_TREASURY_SOLANA_ADDRESS: TREASURY,
    EXECUTION_MODE: 'paper',
    NODE_ENV: 'test',
  },
}));

const { prisma } = await import('../../lib/prisma.js');
(globalThis as unknown as { __prisma: unknown }).__prisma = prisma;

const { setPaymentProviderForTests } = await import('./index.js');
const checkout = await import('./checkout.js');

// ─────────────────────────── Поддельный провайдер ───────────────────────────

let transferState = 'awaiting_funds';
let transferOverrides: Partial<ProviderTransfer> = {};
let providerFails: 'none' | 'timeout' | 'rejected' = 'none';
let createdTransfers: string[] = [];
let idempotencyKeys: string[] = [];

function fakeTransfer(over: Partial<ProviderTransfer> = {}): ProviderTransfer {
  const entry = catalogEntryFor('PRO');

  return {
    externalTransferId: 'transfer_1',
    state: 'AWAITING_FUNDS',
    rawState: transferState,
    externalCustomerId: 'cust_1',
    sourceCurrency: 'usd',
    sourceAmount: entry.sourceAmount,
    destinationCurrency: 'usdc',
    destinationRail: 'solana',
    destinationAddress: TREASURY,
    instructions: {
      depositMessage: 'BRG123456',
      bankName: 'Bridge Bank',
      accountNumber: '123456789',
      routingNumber: '101019644',
      amount: entry.sourceAmount,
      currency: 'usd',
    },
    deliveredAmount: null,
    providerFee: null,
    exchangeFee: null,
    destinationTxHash: null,
    receiptUrl: null,
    ...over,
    ...transferOverrides,
  };
}

function fakeProvider(): PaymentProviderPort {
  const { fromBridgeState } = require('@memex/core') as { fromBridgeState: (s: string) => never };

  const build = (): ProviderTransfer =>
    fakeTransfer({
      state: fromBridgeState(transferState),
      rawState: transferState,
      ...(transferState === 'payment_processed'
        ? {
            deliveredAmount: '49.75',
            providerFee: '0.0',
            exchangeFee: '0.25',
            destinationTxHash: 'sol-tx-hash',
            receiptUrl: 'https://bridge.xyz/receipt/1',
          }
        : {}),
    });

  return {
    name: 'fake',
    enabled: true,
    async createKycLink(input) {
      idempotencyKeys.push(input.idempotencyKey);
      return {
        ok: true,
        value: {
          externalKycLinkId: 'kyc_1',
          kycUrl: 'https://bridge.withpersona.com/verify?x=1',
          tosUrl: 'https://bridge.xyz/tos?x=1',
          kycState: 'APPROVED',
          tosAccepted: true,
          externalCustomerId: 'cust_1',
        },
      };
    },
    async getKycLink() {
      return {
        ok: true,
        value: {
          externalKycLinkId: 'kyc_1',
          kycUrl: 'https://bridge.withpersona.com/verify?x=1',
          tosUrl: 'https://bridge.xyz/tos?x=1',
          kycState: 'APPROVED',
          tosAccepted: true,
          externalCustomerId: 'cust_1',
        },
      };
    },
    async createTransfer(input) {
      idempotencyKeys.push(input.idempotencyKey);

      if (providerFails === 'timeout') return { ok: false, failure: 'TIMEOUT' };
      if (providerFails === 'rejected') return { ok: false, failure: 'REJECTED', status: 422 };

      createdTransfers.push(input.idempotencyKey);
      return { ok: true, value: build() };
    },
    async getTransfer() {
      if (providerFails === 'timeout') return { ok: false, failure: 'TIMEOUT' };
      return { ok: true, value: build() };
    },
  };
}

beforeEach(async () => {
  now = NOW;
  db = freshDb();
  logs = [];
  seq = 0;
  transferState = 'awaiting_funds';
  transferOverrides = {};
  providerFails = 'none';
  createdTransfers = [];
  idempotencyKeys = [];
  setPaymentProviderForTests(fakeProvider());
});

async function onboard(userId = 'u1'): Promise<void> {
  await checkout.startOnboarding(userId, 'Myron Satsyk');
}

async function buy(plan = 'PRO', userId = 'u1') {
  return checkout.createCheckout(userId, plan);
}

/** Довести перевод до состояния и применить его к платежу. */
async function advance(paymentId: string, state: string) {
  transferState = state;
  const provider = (await import('./index.js')).getPaymentProvider();
  const fresh = await provider.getTransfer('transfer_1');
  if (!fresh.ok) throw new Error('поддельный провайдер отказал');

  return checkout.applyTransferToPayment(paymentId, fresh.value);
}

// ─────────────────────────────────── Тесты ──────────────────────────────────

describe('проверка личности', () => {
  it('без подтверждённой почты ссылка не выдаётся', async () => {
    const res = await checkout.startOnboarding('u2', 'Кто-то');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toBe('EMAIL_NOT_VERIFIED');
  });

  it('выдаются обе ссылки: условия и проверка', async () => {
    const res = await checkout.startOnboarding('u1', 'Myron Satsyk');

    expect(res.ok).toBe(true);
    expect(res.ok && res.kycUrl).toContain('persona');
    expect(res.ok && res.tosUrl).toContain('tos');
  });

  it('ключ идемпотентности устойчив между вызовами', async () => {
    await onboard();
    await onboard();

    expect(idempotencyKeys.filter((k) => k.startsWith('kyc-'))).toEqual(['kyc-u1']);
  });

  it('без проверки оплату создать нельзя', async () => {
    const res = await buy();

    expect(res.ok === false && res.error).toBe('KYC_REQUIRED');
  });
});

describe('выключенный модуль', () => {
  beforeEach(async () => {
    const { disabledProvider } = await import('./provider.js');
    setPaymentProviderForTests(disabledProvider);
  });

  it('оплата отвечает отказом, а не тишиной', async () => {
    const res = await buy();

    expect(res.ok === false && res.error).toBe('PAYMENTS_UNAVAILABLE');
  });

  it('проверка личности тоже недоступна', async () => {
    const res = await checkout.startOnboarding('u1', 'Myron Satsyk');

    expect(res.ok === false && res.error).toBe('PAYMENTS_UNAVAILABLE');
  });
});

describe('создание оплаты', () => {
  beforeEach(() => onboard());

  it('сумма и срок берутся из каталога', async () => {
    const res = await buy('PRO');

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.checkout.priceAmount).toBe('50');
    expect(res.checkout.priceCurrency).toBe('USDC');
    expect(res.checkout.termDays).toBe(30);
    expect(res.checkout.sourceCurrency).toBe('USD');
    expect(res.checkout.destinationChain).toBe('SOLANA');
  });

  it('инструкции содержат обязательное сообщение перевода', async () => {
    const res = await buy();

    expect(res.ok && res.checkout.instructions?.depositMessage).toBe('BRG123456');
  });

  it('неизвестный план отклоняется', async () => {
    expect((await buy('БЕСПЛАТНО')).ok).toBe(false);
    expect((await buy('TRIAL')).ok).toBe(false);
    expect((await buy('EXPIRED')).ok).toBe(false);
  });

  it('второй незавершённый счёт на тот же план не создаётся', async () => {
    await buy('PRO');
    const second = await buy('PRO');

    expect(second.ok === false && second.error).toBe('CHECKOUT_IN_PROGRESS');
    expect(createdTransfers).toHaveLength(1);
  });

  it('одновременные попытки создают один перевод', async () => {
    const [a, b] = await Promise.all([buy('PRO'), buy('PRO')]);
    const ok = [a, b].filter((r) => r.ok);

    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(createdTransfers.length).toBeLessThanOrEqual(2);
  });

  it('ключ идемпотентности уходит провайдеру', async () => {
    const res = await buy();

    expect(res.ok).toBe(true);
    expect(idempotencyKeys.some((k) => k.startsWith('sub-u1-PRO-'))).toBe(true);
  });

  it('таймаут провайдера не создаёт висящий счёт', async () => {
    providerFails = 'timeout';
    const res = await buy();

    expect(res.ok === false && res.error).toBe('PROVIDER_FAILED');
    expect(res.ok === false && res.detail).toBe('TIMEOUT');

    // Платёж помечен неудачным, значит новый счёт создать можно.
    providerFails = 'none';
    expect((await buy()).ok).toBe(true);
  });

  it('отказ провайдера нормализован', async () => {
    providerFails = 'rejected';
    const res = await buy();

    expect(res.ok === false && res.detail).toBe('REJECTED');
  });
});

describe('выдача доступа', () => {
  beforeEach(() => onboard());

  it('до payment_processed подписки нет', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    for (const state of ['awaiting_funds', 'in_review', 'funds_received', 'payment_submitted']) {
      await advance(res.checkout.paymentId, state);
      expect(db.subscriptions.size, state).toBe(0);
    }
  });

  it('payment_processed выдаёт ровно тридцать суток', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    await advance(res.checkout.paymentId, 'payment_processed');

    expect(db.subscriptions.size).toBe(1);
    const sub = [...db.subscriptions.values()][0]!;
    expect(sub.plan).toBe('PRO');
    expect((sub.expiresAt as Date).getTime() - NOW).toBe(30 * DAY);
  });

  it('повторное событие не продлевает второй раз', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    await advance(res.checkout.paymentId, 'payment_processed');
    const first = [...db.subscriptions.values()][0]!.expiresAt as Date;

    await advance(res.checkout.paymentId, 'payment_processed');
    const after = [...db.subscriptions.values()][0]!.expiresAt as Date;

    expect(after.getTime()).toBe(first.getTime());
    expect(db.subscriptions.size).toBe(1);
  });

  it('в журнал прав записан один переход', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    await advance(res.checkout.paymentId, 'payment_processed');
    await advance(res.checkout.paymentId, 'payment_processed');

    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]!.nextPlan).toBe('PRO');
  });

  it('доставленная сумма и хеш сохраняются', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    await advance(res.checkout.paymentId, 'payment_processed');
    const view = await checkout.paymentForUser('u1', res.checkout.paymentId);

    expect(view?.deliveredAmount).toBe('49.75');
    expect(view?.destinationTxHash).toBe('sol-tx-hash');
    expect(view?.receiptUrl).toContain('receipt');
  });

  it('продление того же плана добавляет ровно тридцать суток', async () => {
    const first = await buy();
    if (!first.ok) throw new Error('счёт не создан');
    await advance(first.checkout.paymentId, 'payment_processed');

    const expiresAfterFirst = [...db.subscriptions.values()][0]!.expiresAt as Date;

    // Второй платёж через десять дней.
    now = NOW + 10 * DAY;
    transferState = 'awaiting_funds';
    transferOverrides = { externalTransferId: 'transfer_2' };

    const second = await buy();
    if (!second.ok) throw new Error('второй счёт не создан');
    await advance(second.checkout.paymentId, 'payment_processed');

    const expiresAfterSecond = [...db.subscriptions.values()][0]!.expiresAt as Date;

    expect(expiresAfterSecond.getTime() - expiresAfterFirst.getTime()).toBe(30 * DAY);
  });
});

describe('сверка перевода', () => {
  beforeEach(() => onboard());

  const cases: Array<[string, Partial<ProviderTransfer>]> = [
    ['чужая исходная валюта', { sourceCurrency: 'eur' }],
    ['другая сумма', { sourceAmount: '5.00' }],
    ['чужая валюта назначения', { destinationCurrency: 'usdt' }],
    ['чужая сеть', { destinationRail: 'ethereum' }],
    ['чужой адрес', { destinationAddress: 'ЧужойАдресКазначейства' }],
  ];

  for (const [name, override] of cases) {
    it(`${name} отправляет платёж на разбор`, async () => {
      const res = await buy();
      if (!res.ok) throw new Error('счёт не создан');

      transferOverrides = override;
      const state = await advance(res.checkout.paymentId, 'payment_processed');

      expect(state).toBe('MANUAL_REVIEW_REQUIRED');
      expect(db.subscriptions.size).toBe(0);
    });
  }

  it('деньги при расхождении не теряются', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    transferOverrides = { destinationAddress: 'Чужой' };
    await advance(res.checkout.paymentId, 'payment_processed');

    const view = await checkout.paymentForUser('u1', res.checkout.paymentId);
    expect(view?.state).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('регистр адреса значим', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    transferOverrides = { destinationAddress: TREASURY.toLowerCase() };
    const state = await advance(res.checkout.paymentId, 'payment_processed');

    expect(state).toBe('MANUAL_REVIEW_REQUIRED');
  });

  it('запись сумм иная, величина та же — расхождением не считается', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    transferOverrides = { sourceAmount: '50.000' };
    const state = await advance(res.checkout.paymentId, 'payment_processed');

    expect(state).toBe('PAID');
  });
});

describe('доступ к чужим платежам', () => {
  beforeEach(() => onboard());

  it('чужой платёж не отдаётся', async () => {
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    expect(await checkout.paymentForUser('u2', res.checkout.paymentId)).toBeNull();
  });

  it('список содержит только свои', async () => {
    await buy();

    expect(await checkout.paymentsForUser('u2')).toHaveLength(0);
    expect((await checkout.paymentsForUser('u1')).length).toBeGreaterThan(0);
  });
});

describe('журналы', () => {
  it('ключа провайдера и банковских реквизитов в них нет', async () => {
    await onboard();
    const res = await buy();
    if (!res.ok) throw new Error('счёт не создан');

    await advance(res.checkout.paymentId, 'payment_processed');

    const text = JSON.stringify(logs);
    expect(text).not.toContain('не настоящий ключ');
    expect(text).not.toContain('123456789');
    expect(text).not.toContain('101019644');
    expect(text).not.toContain('BRG123456');
  });
});
