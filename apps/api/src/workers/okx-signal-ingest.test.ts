import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OkxSignal } from '@memex/core';

let existingSignal: { tokenId: string | null } | null = null;
let existingToken: Record<string, any> | null = null;
let createdTokenData: Record<string, any> | null = null;
let updatedTokenData: Record<string, any> | null = null;
let createdSignals: Array<Record<string, any>> = [];
const markedHot: string[] = [];

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
      okxSignal: { findUnique: async () => existingSignal },
      $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx),
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

const { ingestOkxSignal } = await import('./okx-signal-ingest.js');

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
});

describe('импорт OKX Signal', () => {
  it('создаёт новый токен скрытым для Рынка, но сразу сохраняет событие GEMS', async () => {
    expect(await ingestOkxSignal(signal, 'okx_websocket')).toBe('created');

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
      peakPriceUsd: expect.anything(),
      peakObservedAt: signal.signaledAt,
    });
    expect(createdSignals[0]?.peakPriceUsd.toNumber()).toBe(signal.priceUsd);
    expect(markedHot).toEqual(['token-created']);
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

    expect(await ingestOkxSignal(signal, 'okx_rest')).toBe('created');
    expect(updatedTokenData).not.toBeNull();
    expect(createdSignals).toHaveLength(1);
    expect(createdSignals[0]?.tokenId).toBe('blocked-token');
  });

  it('дедуплицирует пересечение WebSocket и REST по providerKey', async () => {
    existingSignal = { tokenId: 'known-token' };

    expect(await ingestOkxSignal(signal, 'okx_rest')).toBe('duplicate');
    expect(createdTokenData).toBeNull();
    expect(createdSignals).toHaveLength(0);
    expect(markedHot).toEqual(['known-token']);
  });

  it('повторный вход в тот же токен остаётся отдельным событием', async () => {
    await ingestOkxSignal(signal, 'okx_websocket');
    await ingestOkxSignal(
      { ...signal, providerKey: 'okx-signal:two', signaledAt: new Date('2026-08-23T05:01:00Z') },
      'okx_websocket',
    );

    expect(createdSignals.map((row) => row.providerKey)).toEqual([
      'okx-signal:one',
      'okx-signal:two',
    ]);
  });
});
