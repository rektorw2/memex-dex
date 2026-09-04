import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  InMemorySolanaDepositRepository,
  MockSolanaDepositEventSource,
  processSolanaDepositCycle,
  type SolanaDepositSourceEvent,
} from './solana-deposit-pipeline.js';
import {
  parseSolanaDepositTransfers,
  positionalInstructionIndex,
  SolanaRpcDepositEventSource,
  SolanaRpcRequestError,
  scanAddressesForOwner,
  type SolanaDepositAddressBook,
  type SolanaRpcClient,
  type SignatureStatus,
} from './solana-rpc-deposit-source.js';

/**
 * Разрывы, найденные при аудите незакоммиченного источника.
 *
 * Каждый тест здесь описывает конкретный способ потерять или удвоить
 * чужие деньги, а не абстрактное «должно работать».
 */

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const [OWNER_ADDRESS, USDC_ATA] = scanAddressesForOwner(OWNER);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const FINALIZED: SignatureStatus = {
  confirmations: null,
  confirmationStatus: 'finalized',
  err: null,
};

function transaction(instructions: unknown[], over: Record<string, unknown> = {}) {
  return {
    slot: 100,
    transaction: {
      message: {
        accountKeys: [{ pubkey: USDC_ATA!, source: 'transaction' }],
        instructions,
        recentBlockhash: 'hash-a',
      },
    },
    meta: {
      err: null,
      innerInstructions: [],
      postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: OWNER_ADDRESS }],
    },
    ...over,
  };
}

const solTransfer = (destination: string, lamports = 5_000_000) => ({
  program: 'system',
  programId: '11111111111111111111111111111111',
  parsed: { type: 'transfer', info: { destination, lamports } },
});

const usdcTransfer = (destination: string, amount = '1000000') => ({
  program: 'spl-token',
  programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  parsed: { type: 'transferChecked', info: { destination, mint: USDC, tokenAmount: { amount } } },
});

const owners = new Set([OWNER_ADDRESS!]);
const watched = new Set([OWNER_ADDRESS!, USDC_ATA!]);

// ─────────────────── Стабильность ключа идемпотентности ──────────────────────

describe('индекс инструкции', () => {
  it('позиционный, а не порядковый номер найденного перевода', async () => {
    const two = parseSolanaDepositTransfers(
      'sig',
      transaction([solTransfer('чужой-адрес'), solTransfer(OWNER_ADDRESS!)]),
      FINALIZED,
      owners,
      watched,
    );
    // Первая инструкция чужая, но позицию нашей не сдвигает: индекс
    // считается от места в транзакции, а не от числа находок.
    expect(two[0]!.instructionIndex).toBe(positionalInstructionIndex(1, null));
  });

  it('не меняется, когда соседний перевод перестал разбираться', () => {
    // Именно это и удваивало бы зачисление: тот же перевод получил бы
    // новый ключ и прошёл бы мимо проверки на дубль.
    const withNeighbour = parseSolanaDepositTransfers(
      'sig',
      transaction([solTransfer('чужой'), solTransfer(OWNER_ADDRESS!)]),
      FINALIZED, owners, watched,
    );
    const withoutNeighbour = parseSolanaDepositTransfers(
      'sig',
      transaction([{ program: 'vote', parsed: {} }, solTransfer(OWNER_ADDRESS!)]),
      FINALIZED, owners, watched,
    );

    expect(withNeighbour[0]!.instructionIndex).toBe(withoutNeighbour[0]!.instructionIndex);
  });

  it('внешняя и вложенная инструкции не сталкиваются по номеру', () => {
    expect(positionalInstructionIndex(0, null)).not.toBe(positionalInstructionIndex(0, 0));
    expect(positionalInstructionIndex(0, 0)).not.toBe(positionalInstructionIndex(1, null));
  });

  it('два перевода одному владельцу остаются различимы', () => {
    const events = parseSolanaDepositTransfers(
      'sig',
      transaction([solTransfer(OWNER_ADDRESS!), solTransfer(OWNER_ADDRESS!, 7_000_000)]),
      FINALIZED, owners, watched,
    );

    expect(events).toHaveLength(2);
    expect(events[0]!.instructionIndex).not.toBe(events[1]!.instructionIndex);
  });

  it('вложенный перевод находится и нумеруется отдельно', () => {
    const raw = transaction([{ program: 'jupiter', parsed: { type: 'route', info: {} } }], {
      meta: {
        err: null,
        innerInstructions: [{ index: 0, instructions: [solTransfer(OWNER_ADDRESS!)] }],
        postTokenBalances: [],
      },
    });
    const events = parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched);

    expect(events).toHaveLength(1);
    expect(events[0]!.instructionIndex).toBe(positionalInstructionIndex(0, 0));
  });

  it('переполнение номера вложенной инструкции — ошибка, а не тихий перенос', () => {
    expect(() => positionalInstructionIndex(0, 5000)).toThrow(SolanaRpcRequestError);
  });
});

// ───────────────────── Отсутствие данных против нуля ─────────────────────────

describe('неполные данные транзакции', () => {
  it('meta=null останавливает разбор своим кодом', () => {
    expect(() =>
      parseSolanaDepositTransfers('sig', transaction([], { meta: null }), FINALIZED, owners, watched),
    ).toThrowError(expect.objectContaining({ code: 'SOLANA_RPC_TRANSACTION_META_MISSING' }));
  });

  it('нераспознанный владелец нашего токен-счёта останавливает цикл', () => {
    // Молчаливый пропуск означал бы: деньги пришли, а на балансе
    // их нет и в журнале тоже.
    const raw = transaction([usdcTransfer(USDC_ATA!)], {
      meta: { err: null, innerInstructions: [], postTokenBalances: null },
    });

    expect(() => parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched))
      .toThrowError(expect.objectContaining({ code: 'SOLANA_RPC_TOKEN_ACCOUNT_UNRESOLVED' }));
  });

  it('токен-баланс без владельца не считается доказательством', () => {
    const raw = transaction([usdcTransfer(USDC_ATA!)], {
      meta: {
        err: null,
        innerInstructions: [],
        // `owner` в токен-балансе необязателен по документации.
        postTokenBalances: [{ accountIndex: 0, mint: USDC }],
      },
    });

    expect(() => parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched))
      .toThrow(SolanaRpcRequestError);
  });

  it('чужой неразрешимый токен-счёт нас не касается', () => {
    const raw = transaction([usdcTransfer('чужой-ата')], {
      meta: { err: null, innerInstructions: [], postTokenBalances: [] },
    });

    expect(parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched)).toEqual([]);
  });

  it('но при lookup-таблицах даже чужой промах останавливает цикл', () => {
    // Промах индекса при подгруженных адресах мог скрыть и наш счёт.
    const raw = transaction([usdcTransfer('чужой-ата')], {
      transaction: {
        message: {
          accountKeys: [{ pubkey: USDC_ATA!, source: 'lookupTable' }],
          addressTableLookups: [{ accountKey: 'table', writableIndexes: [1], readonlyIndexes: [] }],
          instructions: [usdcTransfer('чужой-ата')],
          recentBlockhash: 'hash-a',
        },
      },
      meta: { err: null, innerInstructions: [], postTokenBalances: [] },
    });

    expect(() => parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched))
      .toThrowError(expect.objectContaining({ code: 'SOLANA_RPC_TOKEN_ACCOUNT_UNRESOLVED' }));
  });

  it('нечитаемая сумма останавливает цикл, а не пропускает перевод', () => {
    const raw = transaction([{
      program: 'spl-token',
      parsed: { type: 'transfer', info: { destination: USDC_ATA!, amount: 'не-число' } },
    }]);

    expect(() => parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched))
      .toThrowError(expect.objectContaining({ code: 'SOLANA_RPC_TOKEN_AMOUNT_UNREADABLE' }));
  });

  it('неудавшаяся транзакция переводов не даёт', () => {
    const raw = transaction([solTransfer(OWNER_ADDRESS!)], {
      meta: { err: { InstructionError: [0, 'Custom'] }, innerInstructions: [], postTokenBalances: [] },
    });

    expect(parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched)).toEqual([]);
  });
});

// ───────────────────── Новый адрес между двумя циклами ───────────────────────

/**
 * Узел с одним старым переводом на наш адрес.
 *
 * Перевод лежит в слоте ниже общего checkpoint, но выше окна
 * просмотра нового адреса: ровно в той дыре, куда проваливался
 * кошелёк, заведённый после того, как checkpoint ушёл вперёд.
 */
class ScriptedRpc implements SolanaRpcClient {
  readonly signatureRequests: Array<{ address: string; before?: string }> = [];
  constructor(
    private readonly headSlot: number,
    private readonly depositSlot: number | null = null,
  ) {}

  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    if (method === 'getSlot') return this.headSlot as T;
    if (method === 'getSignaturesForAddress') {
      this.signatureRequests.push({
        address: params[0] as string,
        before: (params[1] as { before?: string })?.before,
      });
      if (this.depositSlot == null || params[0] !== OWNER_ADDRESS) return [] as T;
      return [{ signature: 'old-deposit', slot: this.depositSlot, err: null }] as T;
    }
    if (method === 'getSignatureStatuses') {
      return { value: [{ confirmations: null, confirmationStatus: 'finalized', err: null }] } as T;
    }
    if (method === 'getTransaction') {
      return transaction([solTransfer(OWNER_ADDRESS!)], { slot: this.depositSlot }) as T;
    }
    return [] as T;
  }
}

function book(scannedThroughSlot: bigint | null): SolanaDepositAddressBook & { recorded: bigint[] } {
  const recorded: bigint[] = [];
  return {
    recorded,
    async listActiveDestinations() {
      return [{ ownerAddress: OWNER, scanAddresses: scanAddressesForOwner(OWNER), scannedThroughSlot }];
    },
    async recordScannedThrough(_addresses, slot) { recorded.push(slot); },
  };
}

describe('адрес, добавленный между циклами', () => {
  /** Перевод ниже общего края, но внутри окна нового адреса. */
  const OLD_DEPOSIT_SLOT = 900_000;
  const CHECKPOINT = 999_000n;

  it('никогда не сверявшийся адрес находит перевод ниже общего края', async () => {
    const source = new SolanaRpcDepositEventSource(
      new ScriptedRpc(1_000_000, OLD_DEPOSIT_SLOT),
      book(null),
      { newAddressLookbackSlots: 200_000 },
    );

    const batch = await source.readAfterSlot(CHECKPOINT);

    // Общий checkpoint отвечает только за адреса, бывшие в книге,
    // когда он двигался. Кошелёк, заведённый позже, с ним не
    // просматривался ни разу — и перевод провалился бы в дыру.
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]!.slot).toBe(BigInt(OLD_DEPOSIT_SLOT));
  });

  it('уже просмотренный адрес этот же перевод повторно не поднимает', async () => {
    const source = new SolanaRpcDepositEventSource(
      new ScriptedRpc(1_000_000, OLD_DEPOSIT_SLOT),
      book(999_500n),
      { newAddressLookbackSlots: 200_000 },
    );

    const batch = await source.readAfterSlot(CHECKPOINT);

    expect(batch.events).toEqual([]);
    expect(batch.scannedThroughSlot).toBe(1_000_000n);
  });

  it('после прохода курсор адреса записывается', async () => {
    const addresses = book(null);
    const source = new SolanaRpcDepositEventSource(new ScriptedRpc(500), addresses);

    await source.readAfterSlot(100n);
    expect(addresses.recorded).toEqual([500n]);
  });

  it('пустой диапазон не заставляет ходить в сеть', async () => {
    const rpc = new ScriptedRpc(100);
    const source = new SolanaRpcDepositEventSource(rpc, book(0n));

    const batch = await source.readAfterSlot(100n);
    expect(batch.events).toEqual([]);
    expect(rpc.signatureRequests).toEqual([]);
  });
});

// ──────────────────────── Защёлка в цикле зачисления ─────────────────────────

function finalizedEvent(slot: bigint): SolanaDepositSourceEvent {
  return {
    signature: `sig-${slot}`,
    instructionIndex: 0,
    slot,
    blockhash: 'hash',
    network: 'solana',
    mint: null,
    destination: 'Dest111',
    rawAmount: 1_000_000_000n,
    confirmations: 64,
    commitment: 'finalized',
  };
}

async function cycle(repo: InMemorySolanaDepositRepository, events: SolanaDepositSourceEvent[]) {
  return processSolanaDepositCycle({
    source: new MockSolanaDepositEventSource(events, 200n),
    repository: repo,
    workerId: 'worker-a',
    initialStartSlot: 0n,
  });
}

describe('защёлка безопасности останавливает зачисления', () => {
  const prepared = () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.registerDestination({
      walletId: 'w1', userId: 'u1', tokenId: 't1', expectedDestination: 'Dest111',
    });
    return repo;
  };

  it('в здоровом состоянии деньги зачисляются', async () => {
    const repo = prepared();
    const result = await cycle(repo, [finalizedEvent(150n)]);

    expect(result.credited).toBe(1);
    expect(result.heldBack).toBe(0);
  });

  it('в состоянии PAUSED зачисление не происходит', async () => {
    const repo = prepared();
    repo.safety = 'PAUSED';
    const result = await cycle(repo, [finalizedEvent(150n)]);

    expect(result.credited).toBe(0);
    expect(result.heldBack).toBe(1);
  });

  it('данные при этом не теряются', async () => {
    const repo = prepared();
    repo.safety = 'REVIEW_REQUIRED';
    await cycle(repo, [finalizedEvent(150n)]);

    // Событие сохранено финализированным: разбираться человеку будет
    // с чем, а не с пустотой.
    expect(repo.events.get('sig-150:0')?.state).toBe('FINALIZED');
    expect(repo.deposits.size).toBe(0);
    expect(repo.balances.size).toBe(0);
  });

  it('состояние читается до первой проводки, а не после', async () => {
    const repo = prepared();
    repo.safety = 'PAUSED';
    await cycle(repo, [finalizedEvent(150n), finalizedEvent(160n)]);

    expect(repo.deposits.size).toBe(0);
  });

  it('DEGRADED не останавливает: узел не видит, а не врёт', async () => {
    const repo = prepared();
    repo.safety = 'DEGRADED';

    expect((await cycle(repo, [finalizedEvent(150n)])).credited).toBe(1);
  });

  it('снятие защёлки не входит в интерфейс воркера', () => {
    const source = readFileSync(new URL('./solana-deposit-pipeline.ts', import.meta.url), 'utf8');

    // Опустить защёлку может только человек, и не отсюда.
    expect(source).not.toMatch(/clearSafety|lowerSafety|resetSafety|resumeFunding/);
  });
});

// ────────────────────────── Checkpoint не убегает ────────────────────────────

describe('граница просмотренного', () => {
  it('checkpoint не поднимается выше просмотренного края', async () => {
    const repo = new InMemorySolanaDepositRepository();
    repo.registerDestination({
      walletId: 'w1', userId: 'u1', tokenId: 't1', expectedDestination: 'Dest111',
    });
    // Событие из слота выше объявленного края: так возвращается
    // повторно прочитанная запись, пока голова цепочки ушла вперёд.
    const result = await processSolanaDepositCycle({
      source: new MockSolanaDepositEventSource([finalizedEvent(900n)], 200n),
      repository: repo,
      workerId: 'worker-a',
      initialStartSlot: 0n,
    });

    // Записать 900 значило бы объявить просмотренным диапазон
    // 200…900, в который никто не смотрел.
    expect(result.checkpoint).toBe(200n);
  });
});
