import { describe, expect, it } from 'vitest';
import { reconcileSolanaDeposits } from './solana-deposit-reconciliation.js';

const chain = (over: Record<string, unknown> = {}) => ({
  eventKey: 'sig-1:0', destination: 'wallet-1', rawAmount: '1000000', state: 'FINALIZED' as const,
  ...over,
});
const credit = (over: Record<string, unknown> = {}) => ({
  eventKey: 'sig-1:0', destination: 'wallet-1', rawAmount: '1000000', ...over,
});
describe('Solana deposit reconciliation', () => {
  it('accepts an exact finalized/ledger match', () => {
    expect(reconcileSolanaDeposits([chain()], [credit()])).toEqual([]);
  });

  it('reports a finalized transfer missing from the ledger', () => {
    expect(reconcileSolanaDeposits([chain()], [])).toMatchObject([
      { eventKey: 'sig-1:0', kind: 'MISSING_CREDIT', actual: null },
    ]);
  });

  it('reports amount divergence instead of mutating money', () => {
    expect(reconcileSolanaDeposits([chain()], [credit({ rawAmount: '999999' })])).toMatchObject([
      { eventKey: 'sig-1:0', kind: 'AMOUNT_MISMATCH' },
    ]);
  });

  it('reports an orphan credit and reorg after credit', () => {
    expect(reconcileSolanaDeposits([], [credit()])).toMatchObject([{ kind: 'ORPHAN_CREDIT' }]);
    expect(reconcileSolanaDeposits([chain({ state: 'REORGED' })], [credit()])).toMatchObject([
      { kind: 'REORG_AFTER_CREDIT' },
    ]);
  });
});
