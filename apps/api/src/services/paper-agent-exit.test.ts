import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAPER_AGENT_STRATEGIES, strategyForNetwork, PAPER_EXIT_PRESETS, fixedAllocationPolicy } from '@memex/core';

/*
 * Сопровождение позиции по плану выхода — на памяти вместо базы.
 *
 * Проверяется не SQL, а бухгалтерия: после частичной фиксации счёт
 * сходится, позиция остаётся открытой, после закрытия остатка сумма
 * реализованного равна тому, что дали бы две продажи по отдельности.
 * Транзакция здесь — обычная функция: важен порядок записей, а не
 * изоляция Postgres, которую проверяет отдельный pglite-тест.
 */

type Row = Record<string, any>;

const store = vi.hoisted(() => ({
  session: {} as Row,
  allocation: {} as Row,
  run: {} as Row,
  ledger: [] as Row[],
  outbox: [] as Row[],
  audit: [] as Row[],
  tokens: [] as Row[],
}));

const tx = vi.hoisted(() => ({
  paperAgentAllocation: {
    findUnique: vi.fn(async () => ({ ...store.allocation })),
    findMany: vi.fn(async ({ where }: any) =>
      where?.state === 'OPEN' && where?.id?.not ? [] : store.allocation.state === 'OPEN' ? [{ ...store.allocation }] : []),
    update: vi.fn(async ({ data }: any) => { Object.assign(store.allocation, data); return store.allocation; }),
  },
  paperAgentAccountSession: {
    findUnique: vi.fn(async () => ({ ...store.session })),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (where.ledgerVersion !== store.session.ledgerVersion) return { count: 0 };
      const { ledgerVersion, ...rest } = data;
      Object.assign(store.session, rest, { ledgerVersion: store.session.ledgerVersion + 1 });
      return { count: 1 };
    }),
  },
  paperAgentRun: { updateMany: vi.fn(async ({ data }: any) => { Object.assign(store.run, data); return { count: 1 }; }) },
  paperAgentCapitalLedger: { create: vi.fn(async ({ data }: any) => { store.ledger.push(data); return data; }) },
  paperAgentNotification: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: any) => { store.outbox.push(data); return data; }),
    upsert: vi.fn(async ({ create }: any) => { store.outbox.push(create); return create; }),
  },
}));

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    $transaction: async (work: (client: typeof tx) => Promise<void>) => work(tx),
    paperAgentAllocation: {
      findMany: vi.fn(async () => (store.allocation.state === 'OPEN' ? [{ ...store.allocation }] : [])),
    },
    token: { findMany: vi.fn(async () => store.tokens) },
    auditLog: { create: vi.fn(async ({ data }: any) => { store.audit.push(data); return data; }) },
    paperAgentControl: { findUnique: vi.fn(async () => ({ learningModeEnabled: false })) },
  },
}));
vi.mock('./paper-agent-outbox.js', () => ({
  enqueuePaperAgentOutbox: vi.fn(async (_tx: unknown, event: Row) => { store.outbox.push(event); }),
}));
vi.mock('../lib/env.js', () => ({ env: { EXECUTION_MODE: 'paper', TELEGRAM_AGENT_NOTIFICATIONS_ENABLED: false } }));

const { settlePaperAllocation, closeAllPaperPositions } = await import('./paper-agent-allocation.js');

const D = (value: number | string) => ({ toString: () => String(value), toNumber: () => Number(value) });
const strategy = PAPER_AGENT_STRATEGIES[0]!;
const ENTRY_AT = new Date('2026-09-08T10:00:00.000Z');

function openPosition(mode: keyof typeof PAPER_EXIT_PRESETS, network: 'SOLANA' | 'BNB' | 'ROBINHOOD' = 'SOLANA') {
  const policy = { ...fixedAllocationPolicy({ capitalUsd: 1_000, maxOpenPositions: 4, reservePct: 30 }), exitPlan: PAPER_EXIT_PRESETS[mode] };
  const allocated = 100;
  // Вход считается по модели расходов сети; в run сохраняется её снимок.
  const entryStrategy = strategyForNetwork(strategy, network);
  const feeRate = entryStrategy.tradeFeeBps / 10_000;
  const entryFee = allocated * feeRate + entryStrategy.networkFeeUsdPerSide;
  const executionPrice = 1 * (1 + entryStrategy.entrySlippageBps / 10_000);
  const quantity = (allocated - entryFee) / executionPrice;
  store.session = {
    id: 'active', kind: 'ACTIVE', status: 'ACTIVE', ledgerVersion: 3, closedAt: null,
    initialCapitalUsd: D(1_000), freeBalanceUsd: D(600), reservedBalanceUsd: D(300), inPositionsUsd: D(100),
    realizedPnlUsd: D(0), unrealizedPnlUsd: D(0), tradingFeesUsd: D(0), slippageUsd: D(0), networkCostsUsd: D(0),
    equityUsd: D(1_000), peakEquityUsd: D(1_000), drawdownPct: D(0), openPositions: 1,
  };
  store.allocation = {
    id: 'alloc', sessionId: 'active', runId: 'run', isShadow: false, state: 'OPEN', mode: 'FIXED',
    policyKey: policy.policyKey, policyVersion: 1, riskProfile: null, policySnapshot: policy, allocationReason: 'FIXED_STRONG_POSITION',
    allocatedUsd: D(allocated), capitalPct: D(10), entryAt: ENTRY_AT,
    entrySourcePriceUsd: D(1), entryExecutionPriceUsd: D(executionPrice), entryQuantity: D(quantity),
    peakSourcePriceUsd: D(1), maxMultiple: D(1), maxDrawdownPct: D(0),
    realizedPnlUsd: null, tradingFeesUsd: null, slippageUsd: null, networkCostsUsd: null,
    exitPlan: PAPER_EXIT_PRESETS[mode], exitState: null, exitReason: null,
    run: {
      tokenId: 'token', symbol: 'GEM', address: 'Mint', chain: network,
      costModelKey: entryStrategy.costModelKey, tradeFeeBps: entryStrategy.tradeFeeBps, entrySlippageBps: entryStrategy.entrySlippageBps,
      exitSlippageBps: entryStrategy.exitSlippageBps, networkFeeUsdPerSide: D(entryStrategy.networkFeeUsdPerSide),
      // «После рестарта»: общая стратегия читается с расходами Solana — позиция обязана вестись по снимку.
      strategy: { key: strategy.key, version: strategy.version, label: strategy.label, config: strategy },
    },
  };
  store.run = { state: 'PAPER_OPEN' };
  store.ledger = [];
  store.outbox = [];
  store.audit = [];
  store.tokens = [];
  return { allocated, quantity };
}

const num = (value: any) => Number(value?.toString?.() ?? value);
const at = (minutes: number) => new Date(ENTRY_AT.getTime() + minutes * 60_000);

describe('план выхода на счёте', () => {
  beforeEach(() => vi.clearAllMocks());

  it('TARGET: без стопа держит любое падение и закрывает на 2×', async () => {
    openPosition('TARGET');
    expect((await settlePaperAllocation(store.allocation as any, 0.2, at(1))).outcome).toBe('HELD');
    expect(store.allocation.state).toBe('OPEN');
    const closed = await settlePaperAllocation(store.allocation as any, 2, at(2));
    expect(closed).toMatchObject({ outcome: 'CLOSED', reason: 'TARGET_REACHED' });
    expect(store.allocation.exitReason).toBe('TARGET_REACHED');
    expect(store.session.openPositions).toBe(0);
  });

  it('PROTECTED: стоп −35% закрывает и записывает причину в журнал', async () => {
    openPosition('PROTECTED');
    const result = await settlePaperAllocation(store.allocation as any, 0.64, at(1));
    expect(result).toMatchObject({ outcome: 'CLOSED', reason: 'STOP_LOSS' });
    expect(store.ledger).toHaveLength(1);
    expect(store.ledger[0]).toMatchObject({ eventType: 'CLOSE', metadata: { exitReason: 'STOP_LOSS', exitMode: 'PROTECTED' } });
    expect(num(store.session.realizedPnlUsd)).toBeLessThan(-30);
    expect(store.run.state).toBe('PAPER_CLOSED');
  });

  it('PROTECTED: через 45 минут без роста выходит по времени', async () => {
    openPosition('PROTECTED');
    expect((await settlePaperAllocation(store.allocation as any, 1.1, at(44))).outcome).toBe('HELD');
    expect(await settlePaperAllocation(store.allocation as any, 1.1, at(45))).toMatchObject({ outcome: 'CLOSED', reason: 'TIME_STOP' });
  });

  it('LADDER: частичная фиксация оставляет позицию открытой, а счёт сходится', async () => {
    const { allocated } = openPosition('LADDER');
    const partial = await settlePaperAllocation(store.allocation as any, 1.6, at(5));
    expect(partial).toMatchObject({ outcome: 'PARTIAL', reason: 'TAKE_PROFIT_LEG' });
    expect(store.allocation.state).toBe('OPEN');
    expect(store.session.openPositions).toBe(1);
    expect(store.allocation.exitState).toMatchObject({ legsFilled: 1, remainingPct: 60, stopReason: 'BREAKEVEN_STOP' });
    // Освобождено 40% стоимости входа; остаток $60 всё ещё «вложено».
    expect(num(store.session.inPositionsUsd)).toBeCloseTo(allocated * 0.6, 6);
    expect(num(store.session.freeBalanceUsd)).toBeGreaterThan(600 + 40 * 1.5);
    expect(store.ledger[0]).toMatchObject({ eventType: 'PARTIAL_EXIT', eventKey: 'alloc:LEG:1' });
    expect(store.outbox.map((event) => event.eventType)).toEqual(['PAPER_SELL']);
    // Инвариант: equity = свободно + резерв + вложено + нереализованный.
    const s = store.session;
    expect(num(s.equityUsd)).toBeCloseTo(num(s.freeBalanceUsd) + num(s.reservedBalanceUsd) + num(s.inPositionsUsd) + num(s.unrealizedPnlUsd), 6);

    const second = await settlePaperAllocation(store.allocation as any, 2.0, at(6));
    expect(second).toMatchObject({ outcome: 'PARTIAL', reason: 'TAKE_PROFIT_LEG' });
    expect(store.allocation.exitState).toMatchObject({ legsFilled: 2, remainingPct: 30, stopReason: 'TRAILING_STOP' });

    // Пик 2.4, трейлинг −25% → стоп 1.8. Цена 1.79 закрывает остаток.
    expect((await settlePaperAllocation(store.allocation as any, 2.4, at(7))).outcome).toBe('HELD');
    const closed = await settlePaperAllocation(store.allocation as any, 1.79, at(8));
    expect(closed).toMatchObject({ outcome: 'CLOSED', reason: 'TRAILING_STOP' });
    expect(store.session.openPositions).toBe(0);
    expect(num(store.session.inPositionsUsd)).toBeCloseTo(0, 6);
    expect(num(store.allocation.realizedPnlUsd)).toBeGreaterThan(50);
    expect(num(store.session.realizedPnlUsd)).toBeCloseTo(num(store.allocation.realizedPnlUsd), 6);
    expect(store.outbox.map((event) => event.eventType)).toEqual(['PAPER_SELL', 'PAPER_SELL', 'PAPER_SELL', 'TRADE_RESULT']);
  });

  it('TRAILING: половина на 2×, остаток по −50% от максимума', async () => {
    openPosition('TRAILING');
    expect(await settlePaperAllocation(store.allocation as any, 2, at(1))).toMatchObject({ outcome: 'PARTIAL' });
    expect(store.allocation.exitState).toMatchObject({ remainingPct: 50 });
    expect((await settlePaperAllocation(store.allocation as any, 5, at(2))).outcome).toBe('HELD');
    expect(store.allocation.exitState.stopSourcePriceUsd).toBeCloseTo(2.5, 9);
    expect(await settlePaperAllocation(store.allocation as any, 2.5, at(3))).toMatchObject({ outcome: 'CLOSED', reason: 'TRAILING_STOP' });
  });

  it('позиция без плана (открыта до режимов) ведётся как TARGET', async () => {
    openPosition('TARGET');
    store.allocation.exitPlan = null;
    store.allocation.policySnapshot = fixedAllocationPolicy({ capitalUsd: 1_000, maxOpenPositions: 4 });
    delete (store.allocation.policySnapshot as any).exitPlan;
    expect((await settlePaperAllocation(store.allocation as any, 0.1, at(600))).outcome).toBe('HELD');
    expect(store.allocation.exitPlan).toMatchObject({ mode: 'TARGET' });
  });

  it('устаревшая версия счёта не записывается', async () => {
    openPosition('PROTECTED');
    tx.paperAgentAccountSession.findUnique.mockResolvedValueOnce({ ...store.session, ledgerVersion: 99 });
    expect((await settlePaperAllocation(store.allocation as any, 0.5, at(1))).outcome).toBe('CONFLICT');
    expect(store.allocation.state).toBe('OPEN');
    expect(store.ledger).toHaveLength(0);
  });
});

describe('снимок расходов позиции по сетям', () => {
  it.each(['SOLANA', 'BNB', 'ROBINHOOD'] as const)('%s: частичная продажа и закрытие считают комиссии по снимку входа, а не по общей стратегии', async (network) => {
    const { allocated } = openPosition('LADDER', network);
    const fee = strategyForNetwork(strategy, network).networkFeeUsdPerSide;
    const partial = await settlePaperAllocation(store.allocation as any, 1.6, at(5));
    expect(partial).toMatchObject({ outcome: 'PARTIAL' });
    // Сетевые расходы: вход целиком + доля выхода (40% остатка) — по сбору сети, не Solana.
    expect(num(store.allocation.networkCostsUsd)).toBeCloseTo(fee * 1.4, 8);
    const sellEvent = store.outbox.find((event) => event.eventType === 'PAPER_SELL');
    expect(sellEvent!.payload.network).toBe({ SOLANA: 'Solana', BNB: 'BNB Chain', ROBINHOOD: 'Robinhood Chain' }[network]);
    await settlePaperAllocation(store.allocation as any, 2.0, at(6));
    const closed = await settlePaperAllocation(store.allocation as any, 1.2, at(8));
    expect(closed.outcome).toBe('CLOSED');
    // Вход (один сбор по долям) + три продажи, каждая — отдельная транзакция со своим сбором сети.
    expect(num(store.allocation.networkCostsUsd)).toBeCloseTo(fee * 4, 8);
    const result = store.outbox.find((event) => event.eventType === 'TRADE_RESULT');
    expect(result!.payload.network).toBe({ SOLANA: 'Solana', BNB: 'BNB Chain', ROBINHOOD: 'Robinhood Chain' }[network]);
    const s = store.session;
    expect(num(s.equityUsd)).toBeCloseTo(num(s.freeBalanceUsd) + num(s.reservedBalanceUsd) + num(s.inPositionsUsd) + num(s.unrealizedPnlUsd), 6);
    expect(allocated).toBe(100);
  });

  it('позиция без снимка (открыта до появления поля) ведётся по общей стратегии', async () => {
    openPosition('TARGET', 'BNB');
    store.allocation.run = { ...store.allocation.run, costModelKey: null, tradeFeeBps: null, entrySlippageBps: null, exitSlippageBps: null, networkFeeUsdPerSide: null };
    const closed = await settlePaperAllocation(store.allocation as any, 2.0, at(5));
    expect(closed.outcome).toBe('CLOSED');
    expect(num(store.allocation.networkCostsUsd)).toBeCloseTo(strategy.networkFeeUsdPerSide * 2, 8);
  });
});

describe('Panic закрывает всё по текущей цене', () => {
  beforeEach(() => vi.clearAllMocks());

  it('закрывает открытую позицию с причиной MANUAL_PANIC и пишет аудит', async () => {
    openPosition('TARGET');
    store.tokens = [{ id: 'token', priceUsd: D(1.5) }];
    const result = await closeAllPaperPositions('MANUAL_PANIC', { actorId: 'admin', ip: null });
    expect(result.closed).toBe(1);
    expect(result.skipped).toEqual([]);
    expect(store.allocation).toMatchObject({ state: 'CLOSED', exitReason: 'MANUAL_PANIC' });
    expect(store.audit[0]).toMatchObject({ action: 'paper_agent.panic_close' });
  });

  it('позиция без цены не закрывается по выдуманной цене — она названа в ответе', async () => {
    openPosition('TARGET');
    store.tokens = [];
    const result = await closeAllPaperPositions('MANUAL_PANIC', null);
    expect(result.closed).toBe(0);
    expect(result.skipped).toEqual([{ allocationId: 'alloc', symbol: 'GEM' }]);
    expect(store.allocation.state).toBe('OPEN');
  });
});
