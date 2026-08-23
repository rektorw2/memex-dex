import { describe, expect, it } from 'vitest';
import { tokenBatchBody } from './okx-market.js';

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
