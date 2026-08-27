import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySolanaExecutionRepository,
  reconcileSolanaTransaction,
  reconcileSolanaTransactionBounded,
  submitSolanaTransaction,
  type SolanaExecutionTransport,
} from './solana-transaction-orchestrator.js';

function repo(over = {}) {
  return new InMemorySolanaExecutionRepository({
    id: 'tx-1', state: 'SIGNED', idempotencyKey: 'operation-1', signature: null,
    broadcastAttempts: 0, lastValidBlockHeight: 100, version: 0, ...over,
  });
}

function transport(over: Partial<SolanaExecutionTransport> = {}): SolanaExecutionTransport {
  return {
    currentBlockHeight: vi.fn(async () => 90),
    submitOnce: vi.fn(async () => ({ kind: 'accepted' as const, signature: 'sig-1' })),
    transactionStatus: vi.fn(async () => ({ state: 'confirmed' as const })),
    ...over,
  };
}

describe('Solana transaction orchestrator', () => {
  it('expires before broadcast when blockhash is no longer valid', async () => {
    const t = transport({ currentBlockHeight: vi.fn(async () => 101) });
    expect(await submitSolanaTransaction({ id: 'tx-1', repository: repo(), transport: t })).toBe('EXPIRED');
    expect(t.submitOnce).not.toHaveBeenCalled();
  });

  it('stores unknown RPC result as AMBIGUOUS', async () => {
    const r = repo();
    const t = transport({ submitOnce: vi.fn(async () => ({ kind: 'unknown' as const, signature: 'sig-1' })) });
    expect(await submitSolanaTransaction({ id: 'tx-1', repository: r, transport: t })).toBe('AMBIGUOUS');
    expect((await r.load('tx-1')).broadcastAttempts).toBe(1);
  });

  it('forbids repeat broadcast after an ambiguous result', async () => {
    const r = repo();
    const t = transport({ submitOnce: vi.fn(async () => ({ kind: 'unknown' as const, signature: 'sig-1' })) });
    await submitSolanaTransaction({ id: 'tx-1', repository: r, transport: t });
    await expect(submitSolanaTransaction({ id: 'tx-1', repository: r, transport: t })).rejects.toThrow('RECONCILE_SIGNATURE_FIRST');
    expect(t.submitOnce).toHaveBeenCalledTimes(1);
  });

  it('recovers AMBIGUOUS by signature and stores actual finalized fill', async () => {
    const r = repo({ state: 'AMBIGUOUS', signature: 'sig-1', broadcastAttempts: 1 });
    const t = transport({ transactionStatus: vi.fn(async () => ({ state: 'finalized' as const, fill: { inputRaw: '100', outputRaw: '91', feeLamports: 5000n } })) });
    expect(await reconcileSolanaTransaction({ id: 'tx-1', repository: r, transport: t })).toBe('FINALIZED');
    expect((r.records.get('tx-1') as any).actualFill).toEqual({ inputRaw: '100', outputRaw: '91', feeLamports: 5000n });
  });

  it('bounds confirmation polling and never rebroadcasts while reconciling', async () => {
    const repository = repo({ state: 'SUBMITTED', signature: 'sig-1', broadcastAttempts: 1 });
    const statuses = [
      { state: 'missing' as const },
      { state: 'confirmed' as const },
      { state: 'finalized' as const, fill: { inputRaw: '10', outputRaw: '20', feeLamports: 5n } },
    ];
    const submitOnce = vi.fn();
    const wait = vi.fn(async () => undefined);
    const transport = {
      currentBlockHeight: vi.fn(async () => 1),
      submitOnce,
      transactionStatus: vi.fn(async () => statuses.shift()!),
    };
    const state = await reconcileSolanaTransactionBounded({
      id: 'tx-1', repository, transport, maxAttempts: 3, wait,
    });
    expect(state).toBe('FINALIZED');
    expect(transport.transactionStatus).toHaveBeenCalledTimes(3);
    expect(submitOnce).not.toHaveBeenCalled();
    expect(wait).toHaveBeenCalledTimes(2);
  });
});
