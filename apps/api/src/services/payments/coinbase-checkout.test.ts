import { describe, it, expect, beforeEach, vi } from 'vitest';
import { catalogEntryFor, isPartnerUserRef, sameMoney } from '@memex/core';
import { HOSTED_URL, type OnrampTransaction, type CoinbaseResult, type SessionToken } from './coinbase.js';

/**
 * Оркестрация оплаты через Coinbase.
 *
 * Живого Coinbase здесь нет: сеть в тестах не трогаем, ключи
 * не используем, деньги не двигаем. Провайдер подменён адаптером,
 * который отвечает и так, как ответил бы настоящий, и так, как
 * ответил бы недобросовестный участник.
 *
 * База подменена картой в памяти. Проверяется не хранение, а решения:
 * кому выдать доступ, на сколько суток, что делать при расхождении
 * и при повторе.
 */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const TREASURY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SESSION_TOKEN = 'токен-сессии-который-нельзя-хранить';

let now = NOW;
let logs: unknown[][] = [];

interface Db {
  users: Map<string, { id: string; email: string; emailVerifiedAt: Date | null }>;
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
      ['u3', { id: 'u3', email: 'third@example.com', emailVerifiedAt: new Date(NOW - DAY) }],
    ]),
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
        return (v as { in: unknown[] }).in.includes(r[k]);
      }
      return r[k] === v;
    }),
  );
}

interface Arg {
  where?: Record<string, unknown> & { id?: string };
  data?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: Record<string, unknown>;
}

vi.mock('../../lib/prisma.js', () => ({
  prisma: {
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) =>
      fn((globalThis as unknown as { __prisma: unknown }).__prisma),

    user: {
      findUnique: async ({ where: w }: Arg) => db.users.get(String(w?.id)) ?? null,
    },

    subscriptionPayment: {
      create: async ({ data }: Arg) => {
        const row = {
          id: id('pay'),
          createdAt: new Date(now),
          paidAt: null,
          grantedSubscriptionId: null,
          providerTransferId: null,
          partnerUserRef: null,
          checkoutExpiresAt: null,
          reviewReason: null,
          destinationTxHash: null,
          deliveredAmount: null,
          provider: 'BRIDGE',
          ...(data ?? {}),
        } as Record<string, unknown>;

        db.payments.set(row.id as string, row);
        return row;
      },

      findFirst: async ({ where: w }: Arg) => where(list(db.payments), w ?? {})[0] ?? null,
      findMany: async ({ where: w }: Arg) => where(list(db.payments), w ?? {}),
      findUnique: async ({ where: w }: Arg) => db.payments.get(String(w?.id)) ?? null,

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

        if (Array.isArray((w as { OR?: unknown[] } | undefined)?.OR)) {
          return (
            rows.find((r) => r.expiresAt == null || (r.expiresAt as Date) > new Date(now)) ?? null
          );
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
    SUBSCRIPTION_PAYMENT_PROVIDER: 'coinbase',
    COINBASE_ONRAMP_ENABLED: true,
    COINBASE_ONRAMP_MODE: 'sandbox',
    COINBASE_SANDBOX_CLIENT_IP: '192.0.2.1',
    BRIDGE_PAYMENTS_ENABLED: false,
    SUBSCRIPTION_TREASURY_SOLANA_ADDRESS: TREASURY,
    EXECUTION_MODE: 'paper',
    NODE_ENV: 'test',
  },
}));

const { prisma } = await import('../../lib/prisma.js');
(globalThis as unknown as { __prisma: unknown }).__prisma = prisma;

const { setCoinbaseForTests } = await import('./index.js');
const cb = await import('./coinbase-checkout.js');

// ────────────────────────── Поддельный провайдер ────────────────────────────

let tokenOutcome: 'ok' | 'timeout' | 'rejected' = 'ok';
let transactions: OnrampTransaction[] = [];
let hostedUrls: string[] = [];
let sessionCalls: { clientIp: string }[] = [];

const entry = catalogEntryFor('PRO');

function successTx(over: Partial<OnrampTransaction> = {}): OnrampTransaction {
  const ref = String(list(db.payments)[0]?.partnerUserRef ?? 'mx_ref');

  return {
    transactionId: 'tx_1',
    partnerUserRef: ref,
    state: 'PAID',
    rawStatus: 'ONRAMP_TRANSACTION_STATUS_SUCCESS',
    purchaseCurrency: 'USDC',
    purchaseNetwork: 'solana',
    purchaseAmount: entry.price.amount,
    paymentSubtotal: '50.00',
    paymentTotal: '51.99',
    paymentCurrency: 'USD',
    coinbaseFee: '1.99',
    networkFee: '0.00',
    walletAddress: TREASURY,
    txHash: 'sol-tx-hash',
    type: 'ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND',
    typeAllowed: true,
    ...over,
  };
}

function fakeCoinbase() {
  return {
    name: 'coinbase' as const,
    enabled: true as const,
    mode: 'sandbox' as const,

    async createSessionToken(input: {
      clientIp: string;
      nowMs: number;
    }): Promise<CoinbaseResult<SessionToken>> {
      sessionCalls.push({ clientIp: input.clientIp });

      if (tokenOutcome === 'timeout') return { ok: false, failure: 'TIMEOUT' };
      if (tokenOutcome === 'rejected') return { ok: false, failure: 'REJECTED', status: 401 };

      return {
        ok: true,
        value: { token: SESSION_TOKEN, expiresAt: new Date(input.nowMs + 5 * 60 * 1000) },
      };
    },

    hostedUrl(input: { token: string; partnerUserRef: string; fiatAmount: string }): string {
      const url = new URL(HOSTED_URL.sandbox);
      url.searchParams.set('sessionToken', input.token);
      url.searchParams.set('partnerUserRef', input.partnerUserRef);
      url.searchParams.set('defaultNetwork', 'solana');
      url.searchParams.set('defaultAsset', 'USDC');
      url.searchParams.set('presetFiatAmount', input.fiatAmount);

      const built = url.toString();
      hostedUrls.push(built);
      return built;
    },

    async transactionsByRef(ref: string): Promise<CoinbaseResult<OnrampTransaction[]>> {
      return { ok: true, value: transactions.filter((t) => t.partnerUserRef === ref) };
    },

    async successfulTransaction(ref: string): Promise<CoinbaseResult<OnrampTransaction | null>> {
      const mine = transactions.filter((t) => t.partnerUserRef === ref);
      const success = mine.find((t) => t.rawStatus === 'ONRAMP_TRANSACTION_STATUS_SUCCESS');
      return { ok: true, value: success ?? mine[0] ?? null };
    },
  };
}

type Fake = ReturnType<typeof fakeCoinbase>;
const install = (p: Fake | null) => setCoinbaseForTests(p as never);

beforeEach(() => {
  now = NOW;
  db = freshDb();
  logs = [];
  seq = 0;
  tokenOutcome = 'ok';
  transactions = [];
  hostedUrls = [];
  sessionCalls = [];
  install(fakeCoinbase());
});

async function startCheckout(plan = 'PRO', userId = 'u1') {
  return cb.createCoinbaseCheckout(userId, plan, '192.0.2.1');
}

const onlyPayment = () => list(db.payments)[0]!;

// ──────────────────────────────── Создание ──────────────────────────────────

describe('создание оплаты через Coinbase', () => {
  it('отдаёт ссылку на размещённую страницу и записывает платёж', async () => {
    const res = await startCheckout();

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.checkout.hostedUrl.startsWith(HOSTED_URL.sandbox)).toBe(true);
    expect(res.checkout.priceAmount).toBe(entry.price.amount);
    expect(res.checkout.priceCurrency).toBe('USDC');
    expect(res.checkout.termDays).toBe(30);

    const payment = onlyPayment();
    expect(payment.provider).toBe('COINBASE');
    expect(payment.state).toBe('AWAITING_FUNDS');
    expect(payment.destinationAddress).toBe(TREASURY);
  });

  it('не хранит токен сессии в базе', async () => {
    await startCheckout();

    // Одноразовый токен, живущий пять минут. Сохранённый — это чужая
    // страница оплаты, привязанная к нашему адресу казначейства.
    const dump = JSON.stringify([...db.payments.values()]);
    expect(dump).not.toContain(SESSION_TOKEN);
    expect(onlyPayment().checkoutExpiresAt).toEqual(new Date(NOW + 5 * 60 * 1000));
  });

  it('не пишет токен сессии в журнал', async () => {
    await startCheckout();
    expect(JSON.stringify(logs)).not.toContain(SESSION_TOKEN);
  });

  it('выдаёт ссылку покупателя нужной формы и разную на каждую покупку', async () => {
    const first = await startCheckout();
    expect(first.ok).toBe(true);

    const refA = String(onlyPayment().partnerUserRef);
    expect(isPartnerUserRef(refA)).toBe(true);
    expect(refA.length).toBeLessThanOrEqual(49);

    // Закрываем первый платёж, чтобы правило «один незавершённый»
    // не помешало второму.
    onlyPayment().state = 'FAILED';

    await startCheckout();
    const refs = list(db.payments).map((p) => p.partnerUserRef);
    expect(new Set(refs).size).toBe(2);
  });

  it('задаёт адрес, актив и сеть на сервере, а не в запросе', async () => {
    const res = await startCheckout();
    expect(res.ok).toBe(true);

    const url = new URL(hostedUrls[0]!);
    expect(url.searchParams.get('defaultNetwork')).toBe('solana');
    expect(url.searchParams.get('defaultAsset')).toBe('USDC');
    expect(url.searchParams.get('presetFiatAmount')).toBe(entry.sourceAmount);

    // Адрес казначейства в ссылку не попадает: он задан токеном.
    expect(hostedUrls[0]).not.toContain(TREASURY);
  });

  it('подставляет документационный адрес в песочнице', async () => {
    await startCheckout();
    expect(sessionCalls[0]!.clientIp).toBe('192.0.2.1');
  });

  it('отказывает без подтверждённой почты', async () => {
    const res = await startCheckout('PRO', 'u2');
    expect(res).toMatchObject({ ok: false, error: 'EMAIL_NOT_VERIFIED' });
    expect(db.payments.size).toBe(0);
  });

  it('отказывает по несуществующему плану', async () => {
    expect(await startCheckout('BEST_EVER')).toMatchObject({ ok: false, error: 'UNKNOWN_PLAN' });
  });

  it('не продаёт TRIAL за деньги', async () => {
    expect(await startCheckout('TRIAL')).toMatchObject({ ok: false, error: 'UNKNOWN_PLAN' });
  });

  it('отказывает при выключенном провайдере', async () => {
    install(null);
    expect(await startCheckout()).toMatchObject({ ok: false, error: 'PAYMENTS_UNAVAILABLE' });
  });

  it('не оставляет висящий платёж, когда провайдер не ответил', async () => {
    tokenOutcome = 'timeout';

    const res = await startCheckout();
    expect(res).toMatchObject({ ok: false, error: 'PROVIDER_FAILED', detail: 'TIMEOUT' });

    // Платёж помечен неудачным, а не «созданным»: иначе правило
    // «один незавершённый на план» заблокировало бы повтор.
    expect(onlyPayment().state).toBe('FAILED');

    tokenOutcome = 'ok';
    expect((await startCheckout()).ok).toBe(true);
  });

  it('не создаёт вторую оплату того же плана', async () => {
    const first = await startCheckout();
    expect(first.ok).toBe(true);

    const second = await startCheckout();
    expect(second).toMatchObject({ ok: false, error: 'CHECKOUT_IN_PROGRESS' });
    if (second.ok) return;
    expect(second.paymentId).toBe(onlyPayment().id);
  });

  it('не продаёт второй план поверх действующего платного', async () => {
    db.subscriptions.set('s1', {
      id: 's1',
      userId: 'u1',
      plan: 'PRO',
      status: 'ACTIVE',
      expiresAt: new Date(NOW + 10 * DAY),
    });

    expect(await startCheckout('FULL_AUTO')).toMatchObject({
      ok: false,
      error: 'PLAN_CHANGE_POLICY_REQUIRED',
    });
  });

  it('разрешает продление того же плана', async () => {
    db.subscriptions.set('s1', {
      id: 's1',
      userId: 'u1',
      plan: 'PRO',
      status: 'ACTIVE',
      expiresAt: new Date(NOW + 10 * DAY),
    });

    expect((await startCheckout('PRO')).ok).toBe(true);
  });
});

// ───────────────────────────────── Сверка ───────────────────────────────────

describe('применение транзакции Coinbase', () => {
  async function paid(over: Partial<OnrampTransaction> = {}) {
    await startCheckout();
    const payment = onlyPayment();
    const tx = successTx(over);
    transactions = [tx];

    const state = await cb.applyCoinbaseTransaction(String(payment.id), tx);
    return { payment, state };
  }

  it('выдаёт подписку на тридцать суток по совпавшей транзакции', async () => {
    const { payment, state } = await paid();

    expect(state).toBe('PAID');
    expect(payment.grantedSubscriptionId).toBeTruthy();

    const sub = list(db.subscriptions)[0]!;
    expect(sub.plan).toBe('PRO');
    expect(sub.expiresAt).toEqual(new Date(NOW + 30 * DAY));
    expect(sub.source).toBe('PAYMENT');
  });

  it('пишет в журнал прав одну запись на выдачу', async () => {
    await paid();
    expect(db.audits).toHaveLength(1);
    expect(db.audits[0]).toMatchObject({ nextPlan: 'PRO', reason: 'PAYMENT_RECEIVED' });
  });

  it('продлевает от конца действующего периода, а не от «сейчас»', async () => {
    db.subscriptions.set('s1', {
      id: 's1',
      userId: 'u1',
      plan: 'PRO',
      status: 'ACTIVE',
      startsAt: new Date(NOW - DAY),
      expiresAt: new Date(NOW + 10 * DAY),
    });

    await paid();

    // Оплаченное время не сгорает: десять суток плюс тридцать.
    expect(db.subscriptions.get('s1')!.expiresAt).toEqual(new Date(NOW + 40 * DAY));
    expect(db.audits[0]).toMatchObject({ reason: 'SUBSCRIPTION_RENEWED' });
  });

  it('не выдаёт доступ второй раз по повторному событию', async () => {
    const { payment } = await paid();
    const before = db.subscriptions.get(String(payment.grantedSubscriptionId))!.expiresAt;

    await cb.applyCoinbaseTransaction(String(payment.id), successTx());
    await cb.applyCoinbaseTransaction(String(payment.id), successTx());

    expect(db.subscriptions.size).toBe(1);
    expect(db.subscriptions.get(String(payment.grantedSubscriptionId))!.expiresAt).toEqual(before);
    expect(db.audits).toHaveLength(1);
  });

  it.each([
    ['недоплата', { purchaseAmount: '10.00' }, 'purchase_amount_mismatch'],
    ['переплата', { purchaseAmount: '500.00' }, 'purchase_amount_mismatch'],
    ['другой актив', { purchaseCurrency: 'USDT' }, 'purchase_currency_mismatch'],
    ['другая сеть', { purchaseNetwork: 'base' }, 'purchase_network_mismatch'],
    ['чужой адрес', { walletAddress: OTHER_WALLET }, 'destination_wallet_mismatch'],
    ['нет хеша', { txHash: null }, 'missing_tx_hash'],
    ['чужая ссылка', { partnerUserRef: 'mx_чужой' }, 'partner_ref_mismatch'],
  ])('%s уводит платёж на разбор и не даёт доступа', async (_name, over, reason) => {
    const { payment, state } = await paid(over as Partial<OnrampTransaction>);

    expect(state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(payment.reviewReason).toBe(reason);
    expect(payment.grantedSubscriptionId).toBeNull();
    expect(db.subscriptions.size).toBe(0);
  });

  it('сохраняет факты даже когда уводит платёж на разбор', async () => {
    // Разбираться вслепую нельзя: то, что прислал провайдер,
    // остаётся записанным.
    const { payment } = await paid({ walletAddress: OTHER_WALLET });

    expect(payment.providerTransferId).toBe('tx_1');
    expect(payment.deliveredToAddress).toBe(OTHER_WALLET);
    expect(sameMoney(String(payment.purchaseAmount), entry.price.amount)).toBe(true);
  });

  it('не даёт одной транзакции оплатить две подписки', async () => {
    await startCheckout();
    const first = onlyPayment();
    await cb.applyCoinbaseTransaction(String(first.id), successTx());

    // Другой человек предъявляет тот же идентификатор транзакции.
    const res = await startCheckout('PRO', 'u3');
    expect(res.ok).toBe(true);

    const second = list(db.payments).find((p) => p.userId === 'u3')!;
    const state = await cb.applyCoinbaseTransaction(
      String(second.id),
      successTx({ partnerUserRef: String(second.partnerUserRef) }),
    );

    expect(state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(second.reviewReason).toBe('transaction_already_used');
    expect(db.subscriptions.size).toBe(1);
  });

  it('не двигает состояние назад по опоздавшему событию', async () => {
    const { payment } = await paid();

    const state = await cb.applyCoinbaseTransaction(
      String(payment.id),
      successTx({ state: 'PAYMENT_SUBMITTED', rawStatus: 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS' }),
    );

    expect(state).toBe('PAID');
    expect(payment.state).toBe('PAID');
  });

  it('переводит неудачную транзакцию в отказ без доступа', async () => {
    await startCheckout();
    const payment = onlyPayment();

    const state = await cb.applyCoinbaseTransaction(
      String(payment.id),
      successTx({ state: 'FAILED', rawStatus: 'ONRAMP_TRANSACTION_STATUS_FAILED' }),
    );

    expect(state).toBe('FAILED');
    expect(db.subscriptions.size).toBe(0);
  });

  it('уводит на разбор незнакомое состояние провайдера', async () => {
    await startCheckout();
    const payment = onlyPayment();

    // Неизвестное — не безопасное. Молчаливое «пропустим» здесь
    // означало бы доступ по слову, которого мы не понимаем.
    const { fromCoinbaseStatus } = await import('@memex/core');
    const state = fromCoinbaseStatus('ONRAMP_TRANSACTION_STATUS_НЕЧТО_НОВОЕ');
    expect(state).toBe('MANUAL_REVIEW_REQUIRED');

    const applied = await cb.applyCoinbaseTransaction(
      String(payment.id),
      successTx({ state, rawStatus: 'ONRAMP_TRANSACTION_STATUS_НЕЧТО_НОВОЕ' }),
    );

    expect(applied).toBe('MANUAL_REVIEW_REQUIRED');
    expect(db.subscriptions.size).toBe(0);
  });

  it('уводит на разбор, если за время оплаты появился другой платный план', async () => {
    await startCheckout();
    const payment = onlyPayment();

    db.subscriptions.set('s9', {
      id: 's9',
      userId: 'u1',
      plan: 'FULL_AUTO',
      status: 'ACTIVE',
      startsAt: new Date(NOW),
      expiresAt: new Date(NOW + 30 * DAY),
    });

    await cb.applyCoinbaseTransaction(String(payment.id), successTx());

    expect(payment.state).toBe('MANUAL_REVIEW_REQUIRED');
    expect(payment.reviewReason).toBe('active_plan_conflict');
    expect(db.subscriptions.get('s9')!.plan).toBe('FULL_AUTO');
  });
});

// ──────────────────────────────── События ───────────────────────────────────

describe('обработка события Coinbase', () => {
  it('не выдаёт доступ по телу события, а перечитывает транзакцию', async () => {
    await startCheckout();
    const payment = onlyPayment();
    const ref = String(payment.partnerUserRef);

    // Событие говорит «успех», но у провайдера успешной транзакции нет.
    transactions = [];

    const res = await cb.handleCoinbaseEvent('onramp.transaction.success', {
      partnerUserRef: ref,
      status: 'ONRAMP_TRANSACTION_STATUS_SUCCESS',
    });

    expect(res.outcome).toContain('NO_TRANSACTION');
    expect(db.subscriptions.size).toBe(0);
    expect(payment.state).not.toBe('PAID');
  });

  it('выдаёт доступ, когда перечитанная транзакция совпала', async () => {
    await startCheckout();
    const payment = onlyPayment();
    transactions = [successTx({ partnerUserRef: String(payment.partnerUserRef) })];

    const res = await cb.handleCoinbaseEvent('onramp.transaction.success', {
      partnerUserRef: payment.partnerUserRef,
    });

    expect(res.outcome).toBe('APPLIED:PAID');
    expect(db.subscriptions.size).toBe(1);
  });

  it('не падает на событии по чужой ссылке', async () => {
    const res = await cb.handleCoinbaseEvent('onramp.transaction.success', {
      partnerUserRef: 'mx_никому_не_принадлежит',
    });

    expect(res).toEqual({ outcome: 'UNKNOWN_REF', paymentId: null });
  });

  it('не падает на событии без ссылки покупателя', async () => {
    const res = await cb.handleCoinbaseEvent('onramp.transaction.created', {});
    expect(res).toEqual({ outcome: 'NO_PARTNER_REF', paymentId: null });
  });
});

// ────────────────────── Перечитывание после возврата ────────────────────────

describe('перечитывание платежа', () => {
  it('возврат браузера сам по себе доступа не даёт', async () => {
    await startCheckout();
    const payment = onlyPayment();

    // Ничего не купили — просто вернулись на страницу.
    transactions = [];

    await cb.refreshCoinbasePayment(String(payment.id));

    expect(payment.state).toBe('AWAITING_FUNDS');
    expect(db.subscriptions.size).toBe(0);
  });

  it('подтверждает оплату, когда она действительно произошла', async () => {
    await startCheckout();
    const payment = onlyPayment();
    transactions = [successTx({ partnerUserRef: String(payment.partnerUserRef) })];

    expect(await cb.refreshCoinbasePayment(String(payment.id))).toBe('PAID');
    expect(db.subscriptions.size).toBe(1);
  });

  it('ничего не делает с платежом другого провайдера', async () => {
    db.payments.set('p-bridge', {
      id: 'p-bridge',
      userId: 'u1',
      provider: 'BRIDGE',
      state: 'AWAITING_FUNDS',
      partnerUserRef: null,
    });

    expect(await cb.refreshCoinbasePayment('p-bridge')).toBeNull();
  });
});

// ───────────────────────────── Адрес человека ───────────────────────────────

describe('адрес человека для провайдера', () => {
  it('в песочнице подставляет документационный адрес', () => {
    expect(cb.resolveClientIp('203.0.113.7')).toBe('192.0.2.1');
    expect(cb.resolveClientIp(undefined)).toBe('192.0.2.1');
  });
});
