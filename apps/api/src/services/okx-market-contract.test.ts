import { describe, expect, it } from 'vitest';
import {
  parseOkxTokenCandles,
  tokenBatchBody,
  tokenCandlePath,
} from './okx-market.js';

describe('POST-тело OKX Market v6', () => {
  it('отправляет массив без несуществующей обёртки tokens', () => {
    const body = tokenBatchBody([
      { chain: 'BASE', address: '0xAbCd' },
      { chain: 'SOLANA', address: 'SoLaNaMint' },
    ]);

    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([
      { chainIndex: '8453', tokenContractAddress: '0xabcd' },
      { chainIndex: '501', tokenContractAddress: 'SoLaNaMint' },
    ]);
    expect(body).not.toHaveProperty('tokens');
  });

  it('не отправляет неподдерживаемую сеть', () => {
    expect(tokenBatchBody([{ chain: 'ROBINHOOD', address: '0xabc' }])).toEqual([]);
  });
});

describe('GET-контракт свечей OKX Market v6', () => {
  it.each([
    ['5m', '5m'],
    ['15m', '15m'],
    ['1h', '1H'],
    ['4h', '4H'],
    ['1d', '1Dutc'],
  ])('переводит интервал %s в bar=%s', (interval, bar) => {
    const path = tokenCandlePath('SOLANA', 'SoLaNaMint', interval, 100);
    const url = new URL(path!, 'https://web3.okx.com');

    expect(url.searchParams.get('bar')).toBe(bar);
  });

  it('сохраняет регистр Solana mint и переводит наши интервалы в bar OKX', () => {
    const path = tokenCandlePath('SOLANA', 'SoLaNaMint', '4h', 1_000);
    const url = new URL(path!, 'https://web3.okx.com');

    expect(url.pathname).toBe('/api/v6/dex/market/candles');
    expect(url.searchParams.get('chainIndex')).toBe('501');
    expect(url.searchParams.get('tokenContractAddress')).toBe('SoLaNaMint');
    expect(url.searchParams.get('bar')).toBe('4H');
    expect(url.searchParams.get('limit')).toBe('299');
  });

  it('передаёт курсор старых свечей через параметр after в миллисекундах', () => {
    const path = tokenCandlePath('SOLANA', 'SoLaNaMint', '5m', 100, 1_725_000_000_000);
    const url = new URL(path!, 'https://web3.okx.com');

    expect(url.searchParams.get('after')).toBe('1725000000000');
    expect(url.searchParams.has('before')).toBe(false);
  });

  it('использует UTC для дневной свечи и lowercase для EVM', () => {
    const path = tokenCandlePath('BASE', '0xAbCd', '1d', 100);
    const url = new URL(path!, 'https://web3.okx.com');

    expect(url.searchParams.get('tokenContractAddress')).toBe('0xabcd');
    expect(url.searchParams.get('bar')).toBe('1Dutc');
  });

  it('разбирает ответ, отбрасывает повреждённое и сортирует от старого к новому', () => {
    const result = parseOkxTokenCandles([
      ['2000', '2', '2.5', '1.8', '2.2', '100', '220', '0'],
      ['broken', '2', '2', '2', '2', '1', '1', '1'],
      ['1000', '1', '1.4', '0.9', '1.2', '50', '60', '1'],
    ]);

    expect(result).toEqual([
      {
        openTime: new Date(1_000),
        open: 1,
        high: 1.4,
        low: 0.9,
        close: 1.2,
        volumeUsd: 60,
      },
      {
        openTime: new Date(2_000),
        open: 2,
        high: 2.5,
        low: 1.8,
        close: 2.2,
        volumeUsd: 220,
      },
    ]);
  });
});
