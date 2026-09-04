import { describe, expect, it, vi } from 'vitest';
import {
  FetchSolanaRpcClient,
  SolanaRpcDepositEventSource,
  SolanaRpcRequestError,
  parseSolanaDepositTransfers,
  positionalInstructionIndex,
  scanAddressesForOwner,
  type SolanaDepositAddressBook,
  type SolanaRpcClient,
} from './solana-rpc-deposit-source.js';

const OWNER = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOURCE_TOKEN_ACCOUNT = '5C5YH1J4dJrSL8fEurRsmuFYyzZnfBMRWZkK2hPdKDZP';

function transaction(owner = OWNER) {
  const [, ata] = scanAddressesForOwner(owner);
  return {
    slot: 110,
    transaction: {
      message: {
        recentBlockhash: 'safe-blockhash',
        accountKeys: [owner, ata, SOURCE_TOKEN_ACCOUNT],
        instructions: [
          { program: 'system', parsed: { type: 'transfer', info: { destination: owner, lamports: 10_000_000 } } },
          {
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: { destination: ata, mint: USDC, tokenAmount: { amount: '5000000' } },
            },
          },
          {
            program: 'spl-token',
            parsed: { type: 'transfer', info: { destination: ata, amount: '2000000' } },
          },
        ],
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      preTokenBalances: [],
      postTokenBalances: [{ accountIndex: 1, owner, mint: USDC }],
    },
  };
}

class FakeRpc implements SolanaRpcClient {
  readonly calls: Array<{ method: string; params: readonly unknown[] }> = [];

  constructor(private readonly handler: (method: string, params: readonly unknown[]) => unknown) {}

  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.calls.push({ method, params });
    return this.handler(method, params) as T;
  }
}

function addressBook(
  owner = OWNER,
  scannedThroughSlot: bigint | null = 0n,
): SolanaDepositAddressBook {
  return {
    async listActiveDestinations() {
      return [{ ownerAddress: owner, scanAddresses: scanAddressesForOwner(owner), scannedThroughSlot }];
    },
    async recordScannedThrough() {},
  };
}

describe('Solana RPC deposit source', () => {
  it('derives the canonical USDC ATA without a network request', () => {
    const addresses = scanAddressesForOwner(OWNER);
    expect(addresses).toHaveLength(2);
    expect(addresses[0]).toBe(OWNER);
    expect(addresses[1]).not.toBe(OWNER);
    expect(scanAddressesForOwner(OWNER)).toEqual(addresses);
  });

  it('parses SOL and multiple USDC transfers with stable per-transaction indexes', () => {
    const events = parseSolanaDepositTransfers(
      'signature-1',
      transaction(),
      { confirmations: null, confirmationStatus: 'finalized', err: null },
      new Set([OWNER]),
    );
    expect(events.map((event) => ({
      index: event.instructionIndex,
      mint: event.mint,
      destination: event.destination,
      amount: event.rawAmount,
      commitment: event.commitment,
      confirmations: event.confirmations,
    }))).toEqual([
      // Индекс — позиция инструкции в транзакции, а не порядковый
      // номер найденного перевода. Порядковый номер сдвигался бы,
      // стоит одному соседнему переводу перестать разбираться, и тот
      // же перевод получил бы новый ключ идемпотентности.
      { index: positionalInstructionIndex(0, null), mint: null, destination: OWNER, amount: 10_000_000n, commitment: 'finalized', confirmations: 32 },
      { index: positionalInstructionIndex(1, null), mint: USDC, destination: OWNER, amount: 5_000_000n, commitment: 'finalized', confirmations: 32 },
      { index: positionalInstructionIndex(2, null), mint: USDC, destination: OWNER, amount: 2_000_000n, commitment: 'finalized', confirmations: 32 },
    ]);
  });

  it('deduplicates a signature observed through owner and token account scans', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'getSlot') return 120;
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'signature-1', slot: 110, err: null }];
      }
      if (method === 'getSignatureStatuses') {
        return { value: [{ confirmations: null, confirmationStatus: 'finalized', err: null }] };
      }
      if (method === 'getTransaction') return transaction();
      throw new Error(`unexpected ${method}`);
    });
    const source = new SolanaRpcDepositEventSource(rpc, addressBook());

    const batch = await source.readAfterSlot(100n);

    expect(batch.scannedThroughSlot).toBe(120n);
    expect(batch.events).toHaveLength(3);
    expect(rpc.calls.filter(({ method }) => method === 'getTransaction')).toHaveLength(1);
  });

  it('advances the scanned head when no wallet has a transaction', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'getSlot') return 777;
      if (method === 'getSignaturesForAddress') return [];
      throw new Error(`unexpected ${method}`);
    });
    const source = new SolanaRpcDepositEventSource(rpc, addressBook());

    await expect(source.readAfterSlot(700n)).resolves.toEqual({
      events: [],
      scannedThroughSlot: 777n,
    });
  });

  it('fails the complete scan when a discovered transaction is temporarily unavailable', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'getSlot') return 120;
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'signature-1', slot: 110, err: null }];
      }
      if (method === 'getSignatureStatuses') {
        return { value: [{ confirmations: 3, confirmationStatus: 'confirmed', err: null }] };
      }
      if (method === 'getTransaction') return null;
      throw new Error(`unexpected ${method}`);
    });
    const source = new SolanaRpcDepositEventSource(rpc, addressBook());

    await expect(source.readAfterSlot(100n)).rejects.toMatchObject({
      code: 'SOLANA_RPC_TRANSACTION_UNAVAILABLE',
      retryable: true,
    });
  });

  it('refreshes only the requested transfer from a pending transaction', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'getSignatureStatuses') {
        return { value: [{ confirmations: 12, confirmationStatus: 'confirmed', err: null }] };
      }
      if (method === 'getTransaction') return transaction();
      throw new Error(`unexpected ${method}`);
    });
    const source = new SolanaRpcDepositEventSource(rpc, addressBook());

    const thirdTransfer = positionalInstructionIndex(2, null);
    const events = await source.readByEventKeys([`signature-1:${thirdTransfer}`]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      signature: 'signature-1',
      instructionIndex: thirdTransfer,
      confirmations: 12,
      commitment: 'confirmed',
    });
  });

  it('fails closed when pagination cannot reach the checkpoint', async () => {
    const rpc = new FakeRpc((method) => {
      if (method === 'getSlot') return 120;
      if (method === 'getSignaturesForAddress') {
        return [{ signature: 'signature-1', slot: 110, err: null }];
      }
      throw new Error(`unexpected ${method}`);
    });
    const source = new SolanaRpcDepositEventSource(rpc, addressBook(), {
      signaturePageSize: 1,
      maxPagesPerAddress: 1,
    });

    await expect(source.readAfterSlot(100n)).rejects.toMatchObject({
      code: 'SOLANA_RPC_SCAN_WINDOW_EXHAUSTED',
    });
  });

  it('rejects an invalid database-owned address before calling transaction APIs', async () => {
    const rpc = new FakeRpc((method) => method === 'getSlot' ? 120 : []);
    const source = new SolanaRpcDepositEventSource(rpc, {
      async listActiveDestinations() {
        return [{ ownerAddress: 'not-solana', scanAddresses: ['not-solana'], scannedThroughSlot: 0n }];
      },
      async recordScannedThrough() {},
    });

    await expect(source.readAfterSlot(100n)).rejects.toMatchObject({
      code: 'SOLANA_DEPOSIT_ADDRESS_INVALID',
      retryable: false,
    });
  });
});

describe('Fetch Solana RPC client', () => {
  it('redacts the endpoint and provider response from HTTP errors', async () => {
    const fetcher = vi.fn(async () => new Response('provider leaked details', { status: 503 }));
    const rpc = new FetchSolanaRpcClient(
      'https://rpc.example.test/?api-key=super-secret',
      1_000,
      fetcher,
    );

    const error = await rpc.call('getSlot', []).catch((caught) => caught);

    expect(error).toBeInstanceOf(SolanaRpcRequestError);
    expect(error).toMatchObject({ code: 'SOLANA_RPC_HTTP_503', retryable: true });
    expect(String(error)).not.toContain('super-secret');
    expect(String(error)).not.toContain('provider leaked details');
  });
});
