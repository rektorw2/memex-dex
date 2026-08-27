import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OkxSignal } from '@memex/core';

type ExistingSignalFixture = {
  id: string;
  tokenId: string | null;
  ingestOrigin: string | null;
  chain: string;
};

let existingSignal: ExistingSignalFixture | null = null;
let existingToken: Record<string, any> | null = null;
let createdTokenData: Record<string, any> | null = null;
let updatedTokenData: Record<string, any> | null = null;
let createdSignals: Array<Record<string, any>> = [];
const markedHot: string[] = [];
const queuedSignals: Array<{ id: string; duplicate: boolean }> = [];
const signalUpdates: Array<Record<string, any>> = [];
let transactionRaceWinner: ExistingSignalFixture | null = null;

vi.mock('../lib/prisma.js', () => {
  const tx = {
    token: {
      findUnique: async () => existingToken,
      create: async ({ data }: { data: Record<string, any> }) => {
        createdTokenData = data;
        existingToken = {
          id: 'token-created',
          symbol: data.symbol,
          name: data.name,
          logoUrl: data.logoUrl,
          priceUpdatedAt: data.priceUpdatedAt,
        };
        return existingToken;
      },
      update: async ({ data }: { data: Record<string, any> }) => {
        updatedTokenData = data;
        return { ...existingToken, ...data };
      },
    },
    okxSignal: {
      create: async ({ data }: { data: Record<string, any> }) => {
        createdSignals.push(data);
        return { id: `signal-${createdSignals.length}`, ...data };
      },
    },
  };

  return {
    prisma: {
      okxSignal: {
        findUnique: async () => existingSignal,
        update: async ({ data }: { data: Record<string, any> }) => {
          signalUpdates.push(data);
          if (existingSignal) existingSignal = { ...existingSignal, ...data };
          return existingSignal;
        },
      },
      $transaction: async (fn: (client: typeof tx) => unknown) => {
        if (transactionRaceWinner) {
          existingSignal = transactionRaceWinner;
          throw Object.assign(new Error('unique conflict'), { code: 'P2002' });
        }
        return fn(tx);
      },
    },
  };
});

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../services/okx-market.js', () => ({
  isOkxConfigured: () => true,
  fetchLatestSignals: async () => [],
}));

vi.mock('../services/okx-ws-client.js', () => ({
  OkxWalletWebSocketClient: class {
    start() {}
    stop() {}
    isHealthy() { return true; }
  },
}));

vi.mock('./hot-tokens.js', () => ({
  markHot: (id: string) => markedHot.push(id),
}));

vi.mock('./paper-agent.js', () => ({
  queuePaperAgentSignal: (id: string, duplicate = false) => queuedSignals.push({ id, duplicate }),
}));

vi.mock('./candle-builder.js', () => ({ requestCandlesSoon: vi.fn() }));

const { ingestOkxSignal, isRestReconciliationDue } = await import('./okx-signal-ingest.js');

const signal: OkxSignal = {
  providerKey: 'okx-signal:one',
  chain: 'SOLANA',
  address: 'Gem111111111111111111111111111111111111111',
  symbol: 'GEM',
  name: 'Gem',
  logoUrl: null,
  signaledAt: new Date('2026-08-23T05:00:00.000Z'),
  priceUsd: 0.001,
  marketCapUsd: 80_000,
  holders: 420,
  top10HolderPct: 18,
  walletTypes: ['smart_money'],
  triggerWalletAddresses: ['Wallet111'],
  triggerWalletCount: 3,
  amountUsd: 1_200,
  soldRatioPct: 0,
};

beforeEach(() => {
  existingSignal = null;
  existingToken = null;
  createdTokenData = null;
  updatedTokenData = null;
  createdSignals = [];
  markedHot.length = 0;
  queuedSignals.length = 0;
  signalUpdates.length = 0;
  transactionRaceWinner = null;
});

describe('импорт OKX Signal', () => {
  it('не превращает внутренний timer в частый REST polling', () => {
    const minute = 60_000;
    expect(isRestReconciliationDue(5_000, 0, minute)).toBe(false);
    expect(isRestReconciliationDue(55_000, 0, minute)).toBe(false);
    expect(isRestReconciliationDue(60_000, 0, minute)).toBe(true);
    expect(isRestReconciliationDue(65_000, 60_000, minute)).toBe(false);
    expect(isRestReconciliationDue(120_000, 60_000, minute)).toBe(true);
  });

  it('создаёт новый токен скрытым для Рынка, но сразу сохраняет событие GEMS', async () => {
    expect(await ingestOkxSignal(signal, 'WEBSOCKET_LIVE')).toBe('created');

    expect(createdTokenData).toMatchObject({
      chain: 'SOLANA',
      address: signal.address,
      symbol: 'GEM',
      source: 'okx_signal',
      isHidden: true,
      isVerified: false,
    });
    expect(createdSignals).toHaveLength(1);
    expect(createdSignals[0]).toMatchObject({
      providerKey: signal.providerKey,
      tokenId: 'token-created',
      source: 'okx_websocket',
      ingestOrigin: 'WEBSOCKET_LIVE',
      paperAgentIngestCode: 'QUEUED_LIVE',
      peakPriceUsd: expect.anything(),
      peakObservedAt: signal.signaledAt,
    });
    expect(createdSignals[0]?.peakPriceUsd.toNumber()).toBe(signal.priceUsd);
    expect(markedHot).toEqual(['token-created']);
    expect(queuedSignals).toEqual([{ id: 'signal-1', duplicate: false }]);
  });

  it('не отбрасывает сигнал для уже заблокированного токена', async () => {
    existingToken = {
      id: 'blocked-token',
      symbol: 'GEM',
      name: 'Gem',
      logoUrl: null,
      priceUpdatedAt: null,
      isHidden: true,
      riskLevel: 'blocked',
      liquidityUsd: 0,
    };

    expect(await ingestOkxSignal(signal, 'REST_BACKFILL')).toBe('created');
    expect(updatedTokenData).not.toBeNull();
    expect(createdSignals).toHaveLength(1);
    expect(createdSignals[0]?.tokenId).toBe('blocked-token');
    expect(queuedSignals).toEqual([]);
  });

  it('дедуплицирует пересечение WebSocket и REST по providerKey', async () => {
    existingSignal = {
      id: 'signal-known', tokenId: 'known-token', ingestOrigin: 'WEBSOCKET_LIVE', chain: 'SOLANA',
    };

    expect(await ingestOkxSignal(signal, 'REST_RECONCILIATION')).toBe('duplicate');
    expect(createdTokenData).toBeNull();
    expect(createdSignals).toHaveLength(0);
    expect(markedHot).toEqual(['known-token']);
    expect(signalUpdates).toEqual([]);
    expect(queuedSignals).toEqual([]);
  });

  it('повторный вход в тот же токен остаётся отдельным событием', async () => {
    await ingestOkxSignal(signal, 'WEBSOCKET_LIVE');
    await ingestOkxSignal(
      { ...signal, providerKey: 'okx-signal:two', signaledAt: new Date('2026-08-23T05:01:00Z') },
      'WEBSOCKET_LIVE',
    );

    expect(createdSignals.map((row) => row.providerKey)).toEqual([
      'okx-signal:one',
      'okx-signal:two',
    ]);
  });

  it('повышает REST backfill до live один раз и не создаёт новый сигнал', async () => {
    existingSignal = {
      id: 'signal-known', tokenId: 'known-token', ingestOrigin: 'REST_BACKFILL', chain: 'SOLANA',
    };
    expect(await ingestOkxSignal(signal, 'WEBSOCKET_LIVE')).toBe('duplicate');
    expect(signalUpdates).toEqual([{ ingestOrigin: 'WEBSOCKET_LIVE', paperAgentIngestCode: 'QUEUED_LIVE' }]);
    expect(queuedSignals).toEqual([{ id: 'signal-known', duplicate: true }]);
  });

  it('после P2002 перечитывает победителя гонки и не теряет live-повышение', async () => {
    transactionRaceWinner = {
      id: 'signal-race', tokenId: 'known-token', ingestOrigin: 'REST_BACKFILL', chain: 'SOLANA',
    };

    expect(await ingestOkxSignal(signal, 'WEBSOCKET_LIVE')).toBe('duplicate');
    expect(createdSignals).toEqual([]);
    expect(signalUpdates).toEqual([{
      ingestOrigin: 'WEBSOCKET_LIVE', paperAgentIngestCode: 'QUEUED_LIVE',
    }]);
    expect(queuedSignals).toEqual([{ id: 'signal-race', duplicate: true }]);
  });

  it('оставляет не-Solana сигнал в GEMS, но не ставит его агенту', async () => {
    const bnb = { ...signal, chain: 'BNB' as const, providerKey: 'okx-signal:bnb' };
    expect(await ingestOkxSignal(bnb, 'WEBSOCKET_LIVE')).toBe('created');
    expect(createdSignals[0]).toMatchObject({
      chain: 'BNB', paperAgentIngestCode: 'FILTERED_UNSUPPORTED_NETWORK',
    });
    expect(queuedSignals).toEqual([]);
  });
});
