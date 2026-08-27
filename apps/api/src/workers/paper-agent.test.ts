import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma as P } from '@prisma/client';
import { PAPER_AGENT_STRATEGIES } from '@memex/core';

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
  if (typeof where.state === 'string') return storedRun.state === where.state;
  if (where.state?.in) return where.state.in.includes(storedRun.state);
  return true;
}

const prismaMock = {
  $transaction: vi.fn(async (work: (tx: any) => Promise<unknown>) => work(prismaMock)),
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
  okxSignal: {
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
    create: vi.fn(async ({ data }: any) => {
      if (storedRun) throw Object.assign(new Error('duplicate'), { code: 'P2002' });
      successfulCreates++;
      storedRun = {
        id: 'run-1',
        ...data,
        strategy: {
          key: baseline.key,
          version: baseline.version,
          label: baseline.label,
          config: baseline,
        },
        updatedAt: new Date(),
      };
      return { id: storedRun.id };
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
    findMany: vi.fn(async () => [{ id: 'token-1', priceUsd: new P.Decimal(tokenPrice) }]),
  },
};

vi.mock('../lib/prisma.js', () => ({ prisma: prismaMock }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { processPaperAgentSignal, processOpenPaperPositions } = await import('./paper-agent.js');

beforeEach(() => {
  storedRun = null;
  tokenPrice = 1;
  successfulCreates = 0;
  notifications.length = 0;
  controlEnabled = true;
  signalChain = 'SOLANA';
  signalOrigin = 'WEBSOCKET_LIVE';
  ingestUpdates.length = 0;
  vi.clearAllMocks();
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
    expect(storedRun.signalOrigin).toBe('WEBSOCKET_LIVE');
    expect(storedRun.providerDeliveryLatencyMs).toBe(100);
    expect(storedRun.agentDecisionLatencyMs).toBeGreaterThanOrEqual(0);
    expect(storedRun.endToEndLatencyMs).toBeGreaterThanOrEqual(5_000);
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({ eventType: 'PAPER_BUY', eventKey: 'run-1:PAPER_BUY:v2' });
  });

  it('два параллельных обработчика не создают две позиции', async () => {
    await Promise.all([processPaperAgentSignal(signal.id), processPaperAgentSignal(signal.id)]);

    expect(storedRun.state).toBe('PAPER_OPEN');
    expect(successfulCreates).toBe(1);
    expect(storedRun.entryQuantity.toNumber()).toBeGreaterThan(0);
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

  it.each(['BASE', 'BNB', 'ETHEREUM'])('фильтрует %s до создания strategy runs', async (chain) => {
    signalChain = chain;
    await processPaperAgentSignal(signal.id);
    expect(storedRun).toBeNull();
    expect(successfulCreates).toBe(0);
    expect(ingestUpdates).toEqual([{ paperAgentIngestCode: 'FILTERED_UNSUPPORTED_NETWORK' }]);
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
