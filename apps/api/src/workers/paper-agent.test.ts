import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma as P } from '@prisma/client';
import { PAPER_AGENT_STRATEGIES, markPaperPosition, openPaperPosition, strategyForNetwork } from '@memex/core';

import { metadataGateDatabase } from '../test-support/metadata-gate.js';
const gate = metadataGateDatabase();
let storedRun: any = null;
let tokenPrice = 1;
let successfulCreates = 0;
const notifications: any[] = [];
let controlEnabled = true;
let signalChain = 'SOLANA';
let signalOrigin = 'WEBSOCKET_LIVE';
const ingestUpdates: any[] = [];
const baseline = PAPER_AGENT_STRATEGIES[0]!;
const strategyRow = {
  id: 'strategy-1',
  key: baseline.key,
  config: baseline,
  label: baseline.label,
  kind: baseline.kind,
  isEnabled: true,
};
const signal = {
  id: 'signal-1',
  providerKey: 'okx-signal:one',
  tokenId: 'token-1',
  chain: 'SOLANA',
  address: 'Token111',
  symbol: 'GEM',
  source: 'okx_websocket',
  ingestOrigin: 'WEBSOCKET_LIVE',
  signaledAt: new Date(Date.now() - 5_000),
  receivedAt: new Date(Date.now() - 4_900),
  walletTypes: ['smart_money'],
  triggerWalletAddresses: ['Wallet111'],
  amountUsd: new P.Decimal(6_000),
  priceUsd: new P.Decimal(1),
  marketCapUsd: new P.Decimal(20_000),
  token: {
    priceUsd: new P.Decimal(1),
    priceUpdatedAt: new Date(),
    poolCreatedAt: new Date(Date.now() - 10 * 60_000),
    // Эти факты обязаны попасть в warnings, а не в допуск.
    riskLevel: 'blocked',
    riskCodes: ['LOW_LIQUIDITY', 'HONEYPOT'],
    scamVerdict: 'BLOCK',
  },
};

function stateMatches(where: any): boolean {
  if (!storedRun || storedRun.id !== where.id) return false;
  if ('decisionCode' in where && (storedRun.decisionCode ?? null) !== where.decisionCode) return false;
  if (typeof where.state === 'string') return storedRun.state === where.state;
  if (where.state?.in) return where.state.in.includes(storedRun.state);
  return true;
}

const prismaMock = {
  $queryRaw: gate.$queryRaw,
  $executeRaw: gate.$executeRaw,
  $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => gate.transaction(() => work(prismaMock))),
  paperAgentControl: {
    findUnique: vi.fn(async () => ({
      id: 'primary',
      isEnabled: controlEnabled,
      baselineStrategyKey: baseline.key,
      telegramShadowEnabled: false,
    })),
    upsert: vi.fn(),
  },
  paperAgentStrategy: {
    findMany: vi.fn(async () => [strategyRow]),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
  paperAgentAllocation: { findMany: vi.fn(async () => []) },
  okxSignal: {
    // Запрос «сигнал без run этой стратегии»: пока run нет — сигнал находится.
    findMany: vi.fn(async ({ where }: any) => (storedRun ? [] : (where.ingestOrigin?.in ?? []).includes(signalOrigin) ? [{ id: signal.id }] : [])),
    findUnique: vi.fn(async () => ({
      ...signal,
      chain: signalChain,
      ingestOrigin: signalOrigin,
      token: { ...signal.token, priceUsd: new P.Decimal(tokenPrice) },
    })),
    updateMany: vi.fn(async ({ data }: any) => {
      ingestUpdates.push(data);
      return { count: 1 };
    }),
  },
  paperAgentRun: {
    /*
     * Вставка через `ON CONFLICT DO NOTHING`, как в production.
     *
     * Раньше мок предоставлял `create`, который на повторе бросал
     * `P2002`. Production перешёл на `createMany({ skipDuplicates })`,
     * и конфликт теперь разрешает сама база одним оператором: второй
     * вызов не бросает ничего, а возвращает `count: 0`.
     *
     * Мок обязан вести себя так же. Оставить прежнее поведение
     * значило бы проверять контракт, которого больше нет.
     */
    createMany: vi.fn(async ({ data, skipDuplicates }: any) => {
      const rows = Array.isArray(data) ? data : [data];
      expect(skipDuplicates, 'вставка обязана пропускать дубликаты').toBe(true);
      expect(rows, 'вставляется ровно одна строка').toHaveLength(1);

      // Повтор той же пары: строка уже есть, вставки не происходит.
      if (storedRun) return { count: 0 };

      successfulCreates++;
      storedRun = {
        id: 'run-1',
        ...rows[0],
        strategy: {
          key: baseline.key,
          version: baseline.version,
          label: baseline.label,
          config: baseline,
        },
        updatedAt: new Date(),
      };
      return { count: 1 };
    }),
    findUnique: vi.fn(async () => (storedRun ? { id: storedRun.id } : null)),
    updateMany: vi.fn(async ({ where, data }: any) => {
      if (!stateMatches(where)) return { count: 0 };
      storedRun = { ...storedRun, ...data, updatedAt: new Date() };
      return { count: 1 };
    }),
    findMany: vi.fn(async () =>
      storedRun?.state === 'PAPER_OPEN'
        ? [{
            ...storedRun,
            strategy: {
              key: baseline.key,
              version: baseline.version,
              label: baseline.label,
              config: baseline,
            },
          }]
        : [],
    ),
  },
  paperAgentNotification: {
    create: vi.fn(async ({ data }: any) => {
      notifications.push(data);
      return { id: `notification-${notifications.length}`, ...data };
    }),
  },
  token: {
    updateMany: vi.fn(async ({data}: any) => { signal.token.poolCreatedAt = data.poolCreatedAt; return {count:1}; }),
    findMany: vi.fn(async () => [{ id: 'token-1', priceUsd: new P.Decimal(tokenPrice) }]),
  },
};

const metadata = vi.hoisted(() => ({ fetch: vi.fn(), reserve: vi.fn(() => true) }));
vi.mock('../services/market-data.js', () => ({ fetchPoolForToken: metadata.fetch, reservePoolMetadataSlot: metadata.reserve }));
vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
/*
 * Флаг управляемого источника переключается тестом. Остальное окружение
 * настоящее: конфликт флагов проверяется на старте `env.ts`, а здесь
 * важно только правило допуска по происхождению.
 */
const testSource = vi.hoisted(() => ({ enabled: false }));
vi.mock('../lib/env.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/env.js')>();
  return { ...actual, env: new Proxy(actual.env, { get: (target, key) => (key === 'PAPER_TEST_SOURCE_ENABLED' ? testSource.enabled : (target as any)[key]) }) };
});
vi.mock('../lib/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../services/evm-chain-probe.js', () => ({ evmProbeState: (n: string) => ({ state: n === 'SOLANA' ? 'NOT_APPLICABLE' : 'VERIFIED', chainId: null, checkedAt: 1 }), refreshEvmProbes: async () => undefined }));
vi.mock('./hot-tokens.js', () => ({ markHot: vi.fn() }));
vi.mock('./candle-builder.js', () => ({ requestCandlesSoon: vi.fn() }));

const { processPaperAgentSignal, processOpenPaperPositions, setPaperSignalSourceProbe, originAllowedNow, runPaperAgentTickOnce, queuePaperAgentSignal, getPaperAgentRuntimeStatus } = await import('./paper-agent.js');
// Импорт приёмника регистрирует настоящую проверку источника (как в API и на стенде): ключей OKX нет → OKX_NOT_CONFIGURED.
await import('./okx-signal-ingest.js');
const okxDown = () => ({ configured: false, transportMode: 'DISABLED', socketHealthy: false, channelDeniedCode: null, lastRestSuccessAtMs: null, lastRestErrorCode: null, restIntervalMs: 60_000, startedAtMs: null, nowMs: Date.now() }) as never;
const okxUp = () => ({ configured: true, transportMode: 'WEBSOCKET', socketHealthy: true, channelDeniedCode: null, lastRestSuccessAtMs: Date.now(), lastRestErrorCode: null, restIntervalMs: 60_000, startedAtMs: Date.now() - 600_000, nowMs: Date.now() }) as never;
const market = await import('../services/okx-market.js');

beforeEach(() => {
  gate.reset();
  metadata.fetch.mockImplementation(() => new Promise(() => {}));
  metadata.reserve.mockReturnValue(true);
  storedRun = null;
  signal.token.poolCreatedAt = new Date(Date.now() - 10 * 60_000);
  signal.signaledAt = new Date(Date.now() - 5_000);
  signal.receivedAt = new Date(Date.now() - 4_900);
  tokenPrice = 1;
  successfulCreates = 0;
  notifications.length = 0;
  controlEnabled = true;
  signalChain = 'SOLANA';
  signalOrigin = 'WEBSOCKET_LIVE';
  ingestUpdates.length = 0;
  testSource.enabled = false;
  setPaperSignalSourceProbe(null);
  vi.clearAllMocks();
});

describe('два источника сигналов: OKX и управляемый стенд', () => {
  it('OKX недоступен — настоящий сигнал ждёт: run нет, запись не помечена, очередь не потеряна', async () => {
    setPaperSignalSourceProbe(okxDown);
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
    expect(ingestUpdates).toEqual([]);
    // Источник вернулся — тот же сигнал обрабатывается без повторной доставки.
    setPaperSignalSourceProbe(okxUp);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN');
  });

  it('стенд включён, OKX недоступен — сигнал TEST_HARNESS обрабатывается, настоящий по-прежнему ждёт', async () => {
    testSource.enabled = true;
    setPaperSignalSourceProbe(okxDown);
    signalOrigin = 'TEST_HARNESS';
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.signalOrigin).toBe('TEST_HARNESS');

    storedRun = null; successfulCreates = 0;
    signalOrigin = 'WEBSOCKET_LIVE';
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
  });

  it('стенд выключен — сигнал TEST_HARNESS не действует даже при живом OKX', async () => {
    setPaperSignalSourceProbe(okxUp);
    signalOrigin = 'TEST_HARNESS';
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(ingestUpdates).toEqual([{ paperAgentIngestCode: 'BACKFILL_DIAGNOSTIC_ONLY' }]);
  });

  it('воспроизведение падения стенда: проход с зарегистрированной проверкой OKX (ключей нет) обрабатывает TEST_HARNESS и держит настоящий', async () => {
    const { getOkxSignalSourceFacts } = await import('./okx-signal-ingest.js');
    setPaperSignalSourceProbe(() => getOkxSignalSourceFacts());
    testSource.enabled = true;
    signalOrigin = 'TEST_HARNESS';
    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();
    const status = getPaperAgentRuntimeStatus();
    expect(status.entriesPausedBySource?.code).toBe('OKX_NOT_CONFIGURED');
    expect(storedRun?.state).toBe('PAPER_OPEN');
    expect(storedRun.signalOrigin).toBe('TEST_HARNESS');

    storedRun = null; successfulCreates = 0;
    signalOrigin = 'WEBSOCKET_LIVE';
    queuePaperAgentSignal(signal.id);
    await runPaperAgentTickOnce();
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
  });

  it('таблица допуска по происхождению', () => {
    testSource.enabled = false;
    expect(originAllowedNow('WEBSOCKET_LIVE', false)).toBe(true);
    expect(originAllowedNow('WEBSOCKET_LIVE', true)).toBe(false);
    expect(originAllowedNow('REST_RECONCILIATION', true)).toBe(false);
    expect(originAllowedNow('REST_BACKFILL', false)).toBe(false);
    expect(originAllowedNow('TEST_HARNESS', false)).toBe(false);
    testSource.enabled = true;
    expect(originAllowedNow('TEST_HARNESS', true)).toBe(true);
    expect(originAllowedNow('WEBSOCKET_LIVE', true)).toBe(false);
  });
});

describe('paper-agent — идемпотентное исполнение', () => {
  it('открывает одну paper-позицию и сохраняет риск только как диагностику', async () => {
    await processPaperAgentSignal(signal.id);

    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.positionUsd.toNumber()).toBe(100);
    expect(storedRun.currentExecutionPriceUsd.toNumber()).toBeCloseTo(0.99);
    expect(storedRun.unrealizedPnlUsd.toNumber()).toBeCloseTo(-2.606979802);
    expect(storedRun.warnings).toMatchObject({
      riskLevel: 'blocked',
      riskCodes: ['LOW_LIQUIDITY', 'HONEYPOT'],
      note: 'diagnostic_only',
    });
    expect(successfulCreates).toBe(1);

    /*
     * Контракт обращения к базе, а не только его последствия.
     * `skipDuplicates` — это `ON CONFLICT DO NOTHING`: конфликт
     * разрешает база одним оператором, исключения не возникает
     * вовсе. Потерять этот флаг значит вернуть в журнал штатной
     * работы лавину пойманных `P2002`.
     *
     * Отсутствие прежнего `create` отдельно не проверяется: его нет
     * в моке, и обращение к нему упало бы с «is not a function» —
     * ровно так этот разрыв и обнаружился. Здесь это гарантирует
     * ещё и компилятор.
     */
    expect(prismaMock.paperAgentRun.createMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.paperAgentRun.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true }),
    );

    expect(storedRun.signalOrigin).toBe('WEBSOCKET_LIVE');
    expect(storedRun.providerDeliveryLatencyMs).toBe(100);
    expect(storedRun.agentDecisionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(storedRun.endToEndLatencyMs).toBeGreaterThanOrEqual(5_000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ eventType: 'PAPER_BUY', eventKey: 'run-1:PAPER_BUY:v3' });
  });

  it('два параллельных обработчика не создают две позиции', async () => {
    await Promise.all([processPaperAgentSignal(signal.id), processPaperAgentSignal(signal.id)]);

    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.entryQuantity.toNumber()).toBeGreaterThan(0);

    /*
     * Успешная вставка ровно одна, и run ровно один. Второй вызов
     * доходит до базы и получает `count: 0` — то есть проигрывает
     * гонку, а не падает с ошибкой.
     */
    expect(successfulCreates, 'вставка удалась один раз').toBe(1);
    expect(storedRun.id, 'run один').toBe('run-1');

    const results = await Promise.all(
      prismaMock.paperAgentRun.createMany.mock.results.map((result: any) => result.value),
    );
    expect(
      results.filter((row: any) => row.count === 1),
      'ровно одна вставка вернула count: 1',
    ).toHaveLength(1);
  });

  it('повтор после рестарта продолжает существующий run без второго входа', async () => {
    await processPaperAgentSignal(signal.id);
    const firstEntryAt = storedRun.entryAt;
    const firstQuantity = storedRun.entryQuantity.toString();

    await processPaperAgentSignal(signal.id);

    expect(successfulCreates).toBe(1);
    expect(storedRun.entryAt).toEqual(firstEntryAt);
    expect(storedRun.entryQuantity.toString()).toBe(firstQuantity);
  });

  it('обновляет максимум и просадку, затем закрывает по 2x', async () => {
    await processPaperAgentSignal(signal.id);

    tokenPrice = 1.5;
    await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.maxMultiple.toNumber()).toBe(1.5);

    tokenPrice = 1.2;
    await processOpenPaperPositions(new Date());
    expect(storedRun.maxDrawdownPct.toNumber()).toBeCloseTo(20);

    tokenPrice = 2;
    await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_CLOSED');
    expect(storedRun.exitReason).toBe('TARGET_REACHED');
    expect(storedRun.realizedPnlUsd.toNumber()).toBeCloseTo(94.8060404);
    expect(notifications.map((row) => row.eventType)).toEqual([
      'PAPER_BUY',
      'PAPER_SELL',
      'TRADE_RESULT',
    ]);
  });

  it('Stop не стирает открытую позицию и позволяет ей корректно закрыться', async () => {
    await processPaperAgentSignal(signal.id);
    controlEnabled = false;
    tokenPrice = 2;
    await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_CLOSED');
    expect(storedRun.realizedPnlUsd.toNumber()).toBeCloseTo(94.8060404);
  });

  it.each(['BASE', 'ETHEREUM'])('фильтрует %s до создания strategy runs', async (chain) => {
    signalChain = chain;
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
    expect(ingestUpdates).toEqual([{ paperAgentIngestCode: 'FILTERED_UNSUPPORTED_NETWORK' }]);
  });

  it('Robinhood Chain без подтверждения OKX — своя сеть, но не готовая: NETWORK_NOT_READY', async () => {
    signalChain = 'ROBINHOOD';
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
    expect(ingestUpdates).toEqual([{ paperAgentIngestCode: 'NETWORK_NOT_READY' }]);
  });

  /*
   * Полный цикл по сетям: вход → переоценка → закрытие на 2×. Стратегия
   * при сопровождении читается «после рестарта» — общая, с расходами
   * Solana (см. findMany выше), а позиция обязана закрыться по снимку
   * расходов своего входа. Ожидание считается той же формулой ядра с
   * моделью расходов сети: 94.806 (Solana), 94.422 (BNB), 94.776 (Robinhood).
   */
  it.each([
    ['SOLANA', 'solana-conservative-v1', 0.02],
    ['BNB', 'bnb-conservative-v1', 0.15],
    ['ROBINHOOD', 'robinhood-conservative-v1', 0.03],
  ])('%s: снимок расходов входа ведёт позицию до закрытия, PnL считается по нему', async (chain, costModelKey, networkFee) => {
    const networkStrategy = strategyForNetwork(baseline, chain as never);
    const expectedPnl = markPaperPosition(networkStrategy, openPaperPosition(networkStrategy, 1)!, 2)!.pnlUsd;
    const solanaPnl = markPaperPosition(baseline, openPaperPosition(baseline, 1)!, 2)!.pnlUsd;
    if (chain !== 'SOLANA') expect(expectedPnl).not.toBeCloseTo(solanaPnl, 3);
    if (chain === 'ROBINHOOD') { market.setOkxSignalChainIndexes(['501', '56', '4663']); market.setOkxMarketChainIndexes(['501', '56', '4663']); }
    signalChain = chain;
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.costModelKey).toBe(costModelKey);
    expect(storedRun.networkFeeUsdPerSide.toNumber()).toBe(networkFee);
    expect(storedRun.entryNetworkFeeUsd.toNumber()).toBe(networkFee);

    tokenPrice = 1.5;
    await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_OPEN');
    tokenPrice = 2;
    await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_CLOSED');
    expect(storedRun.realizedPnlUsd.toNumber()).toBeCloseTo(expectedPnl, 8);
    expect(storedRun.exitNetworkFeeUsd.toNumber()).toBe(networkFee);
    const sell = notifications.find((row) => row.eventType === 'PAPER_SELL');
    expect(sell.payload.network).toBe({ SOLANA: 'Solana', BNB: 'BNB Chain', ROBINHOOD: 'Robinhood Chain' }[chain]);
    expect(sell.payload.costModelKey ?? storedRun.costModelKey).toBe(costModelKey);
    market.setOkxSignalChainIndexes(null);
    market.setOkxMarketChainIndexes(null);
  });

  it('backfill остаётся диагностическим и не открывает позицию', async () => {
    signalOrigin = 'REST_BACKFILL';
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(ingestUpdates).toEqual([{ paperAgentIngestCode: 'BACKFILL_DIAGNOSTIC_ONLY' }]);
  });

  it('живой REST reconciliation может открыть допустимую PAPER-позицию', async () => {
    signalOrigin = 'REST_RECONCILIATION';
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.signalOrigin).toBe('REST_RECONCILIATION');
  });
});


describe('ограниченное ожидание возраста', () => {
  it('сразу использует достоверную дату и сохраняет её в run', async () => {
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toMatchObject({state:'PAPER_OPEN',poolCreatedAt:signal.token.poolCreatedAt});
  });
  it('поздняя дата в допустимом окне продолжает тот же run; повтор не открывает дубль', async () => {
    const date = signal.token.poolCreatedAt;
    signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toMatchObject({state:'RECEIVED',decisionCode:'WAITING_FOR_TOKEN_METADATA'});
    await processPaperAgentSignal(signal.id);
    expect(metadata.fetch).toHaveBeenCalledTimes(1);
    signal.token.poolCreatedAt = date;
    await processPaperAgentSignal(signal.id);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(storedRun.poolCreatedAt).toEqual(date);
    expect(successfulCreates).toBe(1);
  });
  it('без даты ожидание завершается; дата после пропуска не переписывает решение', async () => {
    signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    signal.signaledAt = new Date(Date.now() - 40_000);
    signal.receivedAt = new Date(Date.now() - 39_900);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('SKIPPED');
    expect(storedRun.decisionCode).toBe('DECISION_DEADLINE_EXCEEDED');
    const decided = storedRun.decidedAt;
    signal.token.poolCreatedAt = new Date(Date.now() - 60_000);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.decidedAt).toEqual(decided);
    expect(storedRun.state).toBe('SKIPPED');
  });
  it('после ожидания слишком старый токен пропускается', async () => {
    signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    signal.token.poolCreatedAt = new Date(Date.now() - 20*60_000);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.decisionCode).toBe('TOKEN_TOO_OLD');
  });
  it('после появления даты заново проверяет свежесть сигнала', async () => {
    signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    signal.token.poolCreatedAt = new Date(Date.now() - 60_000);
    signal.signaledAt = new Date(Date.now() - 40_000);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.decisionCode).toBe('DECISION_DEADLINE_EXCEEDED');
  });
  it('после появления даты остановленный агент не входит', async () => {
    signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    signal.token.poolCreatedAt = new Date(Date.now() - 60_000);
    controlEnabled = false;
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('RECEIVED');
  });
});

// Independent review's cooldown reproduction, using the real metadata service.
afterEach(() => vi.useRealTimers());
const metadataService = () => import('../services/paper-token-metadata.js');
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
describe('worker with real metadata admission', () => {
  it('occupied slot → six seconds → actual request → exactly one entry, including redelivery', async () => {
    vi.useFakeTimers(); signal.token.poolCreatedAt = null as any;
    const { requestPaperTokenMetadata: request } = await metadataService();
    expect(await request('another-token', 'SOLANA', 'another-mint', Date.now() + 30_000)).toBe('accepted');
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toMatchObject({state:'RECEIVED', decisionCode:'WAITING_FOR_TOKEN_METADATA'});
    expect(metadata.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6_000);
    metadata.fetch.mockResolvedValue({poolCreatedAt: new Date(Date.now() - 60_000)});
    await processPaperAgentSignal(signal.id); await drain();
    expect(metadata.fetch).toHaveBeenCalledTimes(2);
    await processPaperAgentSignal(signal.id); await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN'); expect(successfulCreates).toBe(1);
    expect(notifications.filter(n => n.eventType === 'PAPER_BUY')).toHaveLength(1);
    tokenPrice = 2; await processOpenPaperPositions(new Date());
    expect(storedRun.state).toBe('PAPER_CLOSED');
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_CLOSED');
    expect(notifications.filter(n => n.eventType === 'PAPER_BUY')).toHaveLength(1);
  });
  it('deadline expires before both slots free: no request and no reopening historical decision', async () => {
    vi.useFakeTimers(); signal.token.poolCreatedAt = null as any;
    const { requestPaperTokenMetadata: request } = await metadataService();
    await request('a','SOLANA','a',Date.now()+30_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await request('b','BNB','b',Date.now()+30_000);
    signal.signaledAt = new Date(Date.now()-25_000);
    signal.receivedAt = new Date(Date.now()-24_900);
    await processPaperAgentSignal(signal.id);
    expect(metadata.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(6_000);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('SKIPPED'); const decidedAt = storedRun.decidedAt;
    signal.token.poolCreatedAt = new Date(Date.now()-60_000);
    await processPaperAgentSignal(signal.id);
    expect(metadata.fetch).toHaveBeenCalledTimes(2); expect(storedRun.decidedAt).toEqual(decidedAt);
  });
  it('restart during unfinished admission: persisted lease prevents duplicate, then permits one recovery', async () => {
    vi.useFakeTimers(); signal.token.poolCreatedAt = null as any;
    await processPaperAgentSignal(signal.id);
    expect(metadata.fetch).toHaveBeenCalledTimes(1);
    vi.resetModules();
    const restarted = await import('./paper-agent.js');
    restarted.setPaperSignalSourceProbe(okxUp);
    await restarted.processPaperAgentSignal(signal.id);
    expect(metadata.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(16_000);
    metadata.fetch.mockResolvedValue({poolCreatedAt:new Date(Date.now()-60_000)});
    await restarted.processPaperAgentSignal(signal.id); await drain();
    expect(metadata.fetch).toHaveBeenCalledTimes(2);
    await restarted.processPaperAgentSignal(signal.id);
    await processPaperAgentSignal(signal.id);
    expect(storedRun.state).toBe('PAPER_OPEN'); expect(successfulCreates).toBe(1);
  });
  it('provider rate slot is unavailable: no fetch; later worker pass really starts it', async () => {
    vi.useFakeTimers(); signal.token.poolCreatedAt = null as any; metadata.reserve.mockReturnValue(false);
    await processPaperAgentSignal(signal.id); expect(metadata.fetch).not.toHaveBeenCalled();
    metadata.reserve.mockReturnValue(true); await vi.advanceTimersByTimeAsync(6_000);
    await processPaperAgentSignal(signal.id); expect(metadata.fetch).toHaveBeenCalledTimes(1);
  });
});
