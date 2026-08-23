import { beforeEach, describe, expect, it, vi } from 'vitest';

const provider = vi.hoisted(() => ({
  configured: true,
  fetchHotTokens: vi.fn(),
  fetchPriceInfo: vi.fn(),
  safeCall: vi.fn(),
}));

vi.mock('./okx-market.js', () => ({
  isOkxConfigured: () => provider.configured,
  fetchHotTokens: provider.fetchHotTokens,
  fetchPriceInfo: provider.fetchPriceInfo,
  safeCall: provider.safeCall,
}));

import {
  checkRoundTrip,
  fetchOkxTokenDetail,
  fetchOkxTokens,
  quotePath,
} from './okx.js';

beforeEach(() => {
  provider.configured = true;
  provider.fetchHotTokens.mockReset();
  provider.fetchPriceInfo.mockReset();
  provider.safeCall.mockReset();
});

describe('контракт OKX v6', () => {
  it('строит котировку только через v6 и exactIn', () => {
    const path = quotePath('8453', '0xeeee', '0xtoken', '4000');
    const url = new URL(`https://web3.okx.com${path}`);

    expect(url.pathname).toBe('/api/v6/dex/aggregator/quote');
    expect(url.searchParams.get('chainIndex')).toBe('8453');
    expect(url.searchParams.get('fromTokenAddress')).toBe('0xeeee');
    expect(url.searchParams.get('toTokenAddress')).toBe('0xtoken');
    expect(url.searchParams.get('amount')).toBe('4000');
    expect(url.searchParams.get('swapMode')).toBe('exactIn');
    expect(path).not.toContain('/api/v5/');
  });

  it('получает список радара из v6 market-клиента', async () => {
    provider.fetchHotTokens.mockResolvedValue([
      {
        chain: 'BASE',
        address: '0xabc',
        symbol: 'ABC',
        name: 'Alpha',
        decimals: 18,
        logoUrl: 'https://img.test/a.png',
        priceUsd: 1.25,
        liquidityUsd: 50_000,
        volume24hUsd: 100_000,
        marketCapUsd: 2_000_000,
      },
    ]);

    const rows = await fetchOkxTokens('BASE');

    expect(provider.fetchHotTokens).toHaveBeenCalledWith('BASE', {
      limit: 100,
      liquidityMin: 0,
    });
    expect(rows[0]).toMatchObject({
      address: '0xabc',
      liquidityUsd: 50_000,
      fdvUsd: 2_000_000,
    });
  });

  it('получает подробности пакетным POST v6 через общий клиент', async () => {
    provider.fetchPriceInfo.mockResolvedValue({
      prices: new Map([
        ['BASE:0xabc', {
          chain: 'BASE',
          address: '0xAbC',
          priceUsd: 2,
          marketCapUsd: 3_000_000,
          liquidityUsd: 75_000,
          holders: 10,
          totalSupply: null,
          change: { m5: null, h1: null, h4: null, h24: 5 },
          volume: { m5: null, h1: null, h4: null, h24: 125_000 },
          txs24h: 20,
        }],
      ]),
      report: {},
    });

    const detail = await fetchOkxTokenDetail('BASE', '0xabc');

    expect(provider.fetchPriceInfo).toHaveBeenCalledWith(
      [{ chain: 'BASE', address: '0xabc' }],
      { fresh: true },
    );
    expect(detail).toEqual({
      priceUsd: 2,
      liquidityUsd: 75_000,
      volume24hUsd: 125_000,
      fdvUsd: 3_000_000,
    });
  });

  it('делает обе стороны проверки выхода через v6', async () => {
    provider.safeCall
      .mockResolvedValueOnce([{ toTokenAmount: '1000000' }])
      .mockResolvedValueOnce([{ toTokenAmount: '38000000000000000' }]);

    const result = await checkRoundTrip('BASE', '0xtoken', 100);

    expect(result.canBuy).toBe(true);
    expect(result.canSell).toBe(true);
    expect(result.returnRatio).toBeCloseTo(0.95);
    expect(provider.safeCall).toHaveBeenCalledTimes(2);

    for (const [, path] of provider.safeCall.mock.calls) {
      expect(path).toContain('/api/v6/dex/aggregator/quote');
      expect(path).not.toContain('/api/v5/');
    }
  });
});
