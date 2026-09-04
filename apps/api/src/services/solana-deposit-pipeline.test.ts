import { describe, expect, it } from 'vitest';
import {
  InMemorySolanaDepositRepository,
  MockSolanaDepositEventSource,
  processSolanaDepositCycle,
  type SolanaDepositSourceEvent,
} from './solana-deposit-pipeline.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function event(over: Partial<SolanaDepositSourceEvent> = {}): SolanaDepositSourceEvent {
  return {
    signature: 'sig-1', instructionIndex: 0, slot: 100n, blockhash: 'block-1',
    network: 'solana', mint: USDC, destination: DEST, rawAmount: 5_000_000n,
    confirmations: 32, commitment: 'finalized', ...over,
  };
}

async function run(events: SolanaDepositSourceEvent[], repo = new InMemorySolanaDepositRepository(), workerId = 'worker-1') {
  repo.registerDestination({
    expectedDestination: DEST,
    walletId: 'wallet-1',
    userId: 'user-1',
    tokenId: 'usdc-token',
  });
  return {
    result: await processSolanaDepositCycle({ source: new MockSolanaDepositEventSource(events), repository: repo, workerId }),
    repo,
  };
}

describe('Solana deposit pipeline', () => {
  it('credits one finalized canonical transfer atomically', async () => {
    const { result, repo } = await run([event()]);
    expect(result.credited).toBe(1);
    expect(repo.deposits.size).toBe(1);
    expect(repo.balances.get('user-1:usdc-token')).toBe(5_000_000n);
    expect(repo.ledger.get('user-1:usdc-token')).toBe(5_000_000n);
  });

  it('deduplicates repeated delivery of the same event', async () => {
    const repo = new InMemorySolanaDepositRepository();
    await run([event()], repo);
    const second = await run([event()], repo);
    expect(second.result.duplicates).toBe(1);
    expect(repo.deposits.size).toBe(1);
    expect(repo.balances.get('user-1:usdc-token')).toBe(5_000_000n);
  });

  it('credits two transfers from one transaction independently', async () => {
    const { result, repo } = await run([event(), event({ instructionIndex: 1, rawAmount: 2_000_000n })]);
    expect(result.credited).toBe(2);
    expect([...repo.deposits.keys()].sort()).toEqual(['sig-1:0', 'sig-1:1']);
    expect(repo.balances.get('user-1:usdc-token')).toBe(7_000_000n);
  });

  it.each([
    ['fake USDC mint', { mint: 'FakeUsdcMint' }, 'UNKNOWN_ASSET'],
    ['wrong network', { network: 'ethereum' }, 'WRONG_NETWORK'],
    ['below minimum', { rawAmount: 999_999n }, 'BELOW_MINIMUM'],
  ])('rejects %s', async (_label, over, code) => {
    const { result, repo } = await run([event(over as Partial<SolanaDepositSourceEvent>)]);
    expect(result.rejected).toBe(1);
    expect(repo.events.get('sig-1:0')?.rejectCode).toBe(code);
    expect(repo.balances.size).toBe(0);
  });

  it('does not trust the event source with ownership and rejects an unknown destination', async () => {
    const repo = new InMemorySolanaDepositRepository();
    const result = await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([event({ destination: 'unknown-wallet' })]),
      repository: repo,
      workerId: 'worker-1',
    });
    expect(result.rejected).toBe(1);
    expect(repo.events.get('sig-1:0')?.rejectCode).toBe('WRONG_DESTINATION');
    expect(repo.balances.size).toBe(0);
  });

  it('waits for confirmations and finality', async () => {
    const { result, repo } = await run([event({ confirmations: 4, commitment: 'confirmed' })]);
    expect(result.pending).toBe(1);
    expect(repo.events.get('sig-1:0')?.state).toBe('AWAITING_CONFIRMATIONS');
    expect(repo.deposits.size).toBe(0);
  });

  it('does not credit a confirmed but not finalized event', async () => {
    const { result, repo } = await run([event({ commitment: 'confirmed' })]);
    expect(result.pending).toBe(1);
    expect(repo.events.get('sig-1:0')?.state).toBe('CONFIRMED');
  });

  it('recovers after restart using a persistent checkpoint with overlap', async () => {
    const repo = new InMemorySolanaDepositRepository();
    await run([event({ slot: 100n })], repo, 'worker-a');
    const next = await run([event({ slot: 100n }), event({ signature: 'sig-2', slot: 101n })], repo, 'worker-b');
    expect(next.result.credited).toBe(1);
    expect(next.result.duplicates).toBe(1);
    expect(next.result.checkpoint).toBe(101n);
  });

  it('advances the checkpoint across an empty fully scanned range', async () => {
    const repo = new InMemorySolanaDepositRepository();
    const result = await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([], 500n),
      repository: repo,
      workerId: 'worker-a',
    });
    expect(result.observed).toBe(0);
    expect(result.checkpoint).toBe(500n);
    expect(await repo.checkpoint('solana-deposits-v1')).toBe(500n);
  });

  it('uses an explicit first-run bootstrap slot without historical backfill', async () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.registerDestination({
      expectedDestination: DEST, walletId: 'wallet-1', userId: 'user-1', tokenId: 'usdc-token',
    });
    const result = await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([
        event({ signature: 'old', slot: 90n }),
        event({ signature: 'new', slot: 110n }),
      ], 120n),
      repository: repo,
      workerId: 'worker-a',
      initialStartSlot: 100n,
    });
    expect(result.credited).toBe(1);
    expect([...repo.deposits.keys()]).toEqual(['new:0']);
    expect(result.checkpoint).toBe(120n);
  });

  it('refreshes a pending signature even after the checkpoint moved beyond overlap', async () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.registerDestination({
      expectedDestination: DEST, walletId: 'wallet-1', userId: 'user-1', tokenId: 'usdc-token',
    });
    await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([
        event({ slot: 1n, confirmations: 1, commitment: 'processed' }),
        event({ signature: 'sig-later', slot: 200n }),
      ]),
      repository: repo,
      workerId: 'worker-a',
    });
    expect(repo.events.get('sig-1:0')?.state).toBe('AWAITING_CONFIRMATIONS');
    await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([event({ slot: 1n, confirmations: 32, commitment: 'finalized' })]),
      repository: repo,
      workerId: 'worker-b',
    });
    expect(repo.events.get('sig-1:0')?.state).toBe('CREDITED');
  });

  it('allows only one of two concurrent workers to own the checkpoint', async () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.registerDestination({
      expectedDestination: DEST, walletId: 'wallet-1', userId: 'user-1', tokenId: 'usdc-token',
    });
    const source = new MockSolanaDepositEventSource([event()]);
    const [a, b] = await Promise.all([
      processSolanaDepositCycle({ source, repository: repo, workerId: 'a' }),
      processSolanaDepositCycle({ source, repository: repo, workerId: 'b' }),
    ]);
    expect([a.acquired, b.acquired].filter(Boolean)).toHaveLength(1);
    expect(repo.deposits.size).toBe(1);
  });

  it('records a manual-review discrepancy for reorg after credit', async () => {
    const repo = new InMemorySolanaDepositRepository();
    await run([event()], repo);
    const rolledBack = await run([event({ commitment: 'reorged' })], repo);
    expect(rolledBack.result.reviewRequired).toBe(1);
    expect(await repo.reconciliationIssues()).toEqual([{ eventKey: 'sig-1:0', kind: 'REORG_AFTER_CREDIT' }]);
  });

  it('does not partially mutate deposit, ledger or balance on atomic failure', async () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.failAtomicCreditFor = 'sig-1:0';
    await expect(run([event()], repo)).rejects.toThrow('SIMULATED_ATOMIC_FAILURE');
    expect(repo.deposits.size).toBe(0);
    expect(repo.ledger.size).toBe(0);
    expect(repo.balances.size).toBe(0);
  });

  it('does not advance the checkpoint and releases the lease after an incomplete scan', async () => {
    const repo = new InMemorySolanaDepositRepository();
    const source = {
      async readAfterSlot() {
        throw new Error('SOLANA_RPC_SCAN_WINDOW_EXHAUSTED');
      },
      async readByEventKeys() {
        return [];
      },
    };
    await expect(processSolanaDepositCycle({
      source,
      repository: repo,
      workerId: 'worker-a',
    })).rejects.toThrow('SOLANA_RPC_SCAN_WINDOW_EXHAUSTED');
    expect(await repo.checkpoint('solana-deposits-v1')).toBe(0n);
    await expect(repo.acquireCheckpointLease(
      'solana-deposits-v1',
      'worker-b',
      new Date(),
      30_000,
    )).resolves.toBe(true);
  });
});
