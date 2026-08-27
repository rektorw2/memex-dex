import { describe, expect, it } from 'vitest';
import { rawAmountToDecimal } from './prisma-solana-deposit-repository.js';

describe('rawAmountToDecimal', () => {
  it('converts SOL and USDC base units without floating point', () => {
    expect(rawAmountToDecimal(10_000_000n, 9)).toBe('0.010000000');
    expect(rawAmountToDecimal(1_000_001n, 6)).toBe('1.000001');
  });

  it('preserves very large exact values', () => {
    expect(rawAmountToDecimal(123456789012345678901n, 6)).toBe('123456789012345.678901');
  });

  it('rejects negative raw values', () => {
    expect(() => rawAmountToDecimal(-1n, 6)).toThrow('must not be negative');
  });
});
