import { PublicKey } from '@solana/web3.js';
import { depositKey } from '@memex/core';
import type {
  SolanaCommitment,
  SolanaDepositEventSource,
  SolanaDepositReadBatch,
  SolanaDepositSourceEvent,
} from './solana-deposit-pipeline.js';

const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const CANONICAL_USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const FINALIZED_CONFIRMATIONS = 32;

export interface SolanaWatchedDestination {
  /** Address shown to the user and used as the internal ownership boundary. */
  ownerAddress: string;
  /** Owner plus token accounts whose signatures must be scanned. */
  scanAddresses: readonly string[];
  /**
   * Highest slot this destination has already been scanned through.
   *
   * `null` means "never scanned". The global checkpoint cannot answer
   * for a wallet created after it: scanning only the shared overlap
   * would step straight over a deposit that landed while the address
   * was not yet in the book.
   */
  scannedThroughSlot: bigint | null;
}

export interface SolanaDepositAddressBook {
  listActiveDestinations(): Promise<readonly SolanaWatchedDestination[]>;
  /**
   * Remember how far a destination has been inspected.
   *
   * Bookkeeping, not money: the cursor can only lower the floor for
   * addresses the shared checkpoint does not cover yet, so writing it
   * early is safe even if the cycle later fails.
   */
  recordScannedThrough(ownerAddresses: readonly string[], slot: bigint): Promise<void>;
}

export interface SolanaRpcClient {
  call<T>(method: string, params: readonly unknown[]): Promise<T>;
}

export class SolanaRpcRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = 'SolanaRpcRequestError';
  }
}

interface RpcEnvelope<T> {
  result?: T;
  error?: { code?: number };
}

/** JSON-RPC transport that never includes the endpoint or provider body in errors. */
export class FetchSolanaRpcClient implements SolanaRpcClient {
  private requestId = 0;

  constructor(
    private readonly endpoint: string,
    private readonly timeoutMs = 10_000,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    timeout.unref?.();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.requestId, method, params }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new SolanaRpcRequestError(
          `SOLANA_RPC_HTTP_${response.status}`,
          response.status === 408 || response.status === 429 || response.status >= 500,
        );
      }
      const envelope = await response.json() as RpcEnvelope<T>;
      if (envelope.error) {
        const rpcCode = Number.isInteger(envelope.error.code) ? envelope.error.code : 'UNKNOWN';
        throw new SolanaRpcRequestError(`SOLANA_RPC_ERROR_${rpcCode}`, true);
      }
      if (!Object.prototype.hasOwnProperty.call(envelope, 'result')) {
        throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_RESPONSE', false);
      }
      return envelope.result as T;
    } catch (error: unknown) {
      if (error instanceof SolanaRpcRequestError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SolanaRpcRequestError('SOLANA_RPC_TIMEOUT', true);
      }
      throw new SolanaRpcRequestError('SOLANA_RPC_NETWORK_ERROR', true);
    } finally {
      clearTimeout(timeout);
    }
  }
}

interface SignatureRow {
  signature: string;
  slot: number;
  err: unknown;
}

export interface SignatureStatus {
  confirmations: number | null;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  err: unknown;
}

export interface SolanaRpcDepositSourceOptions {
  signaturePageSize?: number;
  maxPagesPerAddress?: number;
  maxTransactionsPerCycle?: number;
  transactionConcurrency?: number;
  /**
   * How far back a never-scanned destination is inspected.
   *
   * Bounded on purpose: unbounded history would either exhaust the
   * page budget or quietly stop mid-way. If the window cannot be
   * covered, the cycle fails instead of pretending the address is clean.
   */
  newAddressLookbackSlots?: number;
}

/**
 * Read-only chain adapter. It discovers incoming SOL and SPL transfers but has
 * no database or crediting authority; ownership is resolved again by the
 * repository before a balance can change.
 */
export class SolanaRpcDepositEventSource implements SolanaDepositEventSource {
  private readonly signaturePageSize: number;
  private readonly maxPagesPerAddress: number;
  private readonly maxTransactionsPerCycle: number;
  private readonly transactionConcurrency: number;
  private readonly newAddressLookbackSlots: bigint;

  constructor(
    private readonly rpc: SolanaRpcClient,
    private readonly addresses: SolanaDepositAddressBook,
    options: SolanaRpcDepositSourceOptions = {},
  ) {
    this.signaturePageSize = boundedInt(options.signaturePageSize, 100, 1, 1_000);
    this.maxPagesPerAddress = boundedInt(options.maxPagesPerAddress, 10, 1, 100);
    this.maxTransactionsPerCycle = boundedInt(options.maxTransactionsPerCycle, 250, 1, 5_000);
    this.transactionConcurrency = boundedInt(options.transactionConcurrency, 8, 1, 32);
    this.newAddressLookbackSlots = BigInt(
      boundedInt(options.newAddressLookbackSlots, 216_000, 1, 10_000_000),
    );
  }

  async readAfterSlot(afterSlot: bigint): Promise<SolanaDepositReadBatch> {
    const headSlot = toSafeSlot(await this.rpc.call<unknown>('getSlot', [{ commitment: 'confirmed' }]));
    if (headSlot <= afterSlot) return { events: [], scannedThroughSlot: headSlot };

    const watches = await this.normalizedWatches();
    if (watches.length === 0) return { events: [], scannedThroughSlot: headSlot };

    /*
     * Каждый адрес получает собственный нижний край.
     *
     * Общий checkpoint отвечает только за адреса, которые были в
     * книге, когда он двигался. Кошелёк, заведённый позже, до сих
     * пор не просматривался ни разу: сканировать его с общего края
     * значит перешагнуть через уже пришедший перевод.
     */
    const newAddressFloor = headSlot > this.newAddressLookbackSlots
      ? headSlot - this.newAddressLookbackSlots
      : -1n;
    const signatures = new Map<string, bigint>();
    let lowestFloor = afterSlot;
    const scannedByAddress = new Map<string, bigint>();

    for (const watch of watches) {
      const known = watch.scannedThroughSlot ?? newAddressFloor;
      const floor = known < afterSlot ? known : afterSlot;
      if (floor < lowestFloor) lowestFloor = floor;
      for (const scanAddress of watch.scanAddresses) {
        const cached = scannedByAddress.get(scanAddress);
        // Один и тот же токен-аккаунт может принадлежать только одному
        // владельцу, но нижние края у владельцев разные: берём меньший.
        if (cached != null && cached <= floor) continue;
        for (const row of await this.signaturesAfter(scanAddress, floor, headSlot)) {
          if (row.err == null) signatures.set(row.signature, BigInt(row.slot));
        }
        scannedByAddress.set(scanAddress, floor);
      }
    }
    if (signatures.size > this.maxTransactionsPerCycle) {
      throw new SolanaRpcRequestError('SOLANA_RPC_CYCLE_LIMIT_EXCEEDED', true);
    }

    const events = await this.eventsForSignatures([...signatures.keys()], watches, true);
    await this.addresses.recordScannedThrough(
      watches.map((watch) => watch.ownerAddress),
      headSlot,
    );
    return {
      events: events.filter((event) => event.slot > lowestFloor && event.slot <= headSlot),
      scannedThroughSlot: headSlot,
    };
  }

  async readByEventKeys(eventKeys: readonly string[]): Promise<SolanaDepositSourceEvent[]> {
    const requested = new Set(eventKeys);
    if (requested.size === 0) return [];
    const signatures = unique([...requested].map(signatureFromEventKey));
    if (signatures.length > this.maxTransactionsPerCycle) {
      throw new SolanaRpcRequestError('SOLANA_RPC_REFRESH_LIMIT_EXCEEDED', true);
    }
    const events = await this.eventsForSignatures(signatures, await this.normalizedWatches(), false);
    return events.filter((event) => requested.has(depositKey(event.signature, event.instructionIndex)));
  }

  private async normalizedWatches(): Promise<SolanaWatchedDestination[]> {
    const rows = await this.addresses.listActiveDestinations();
    const byOwner = new Map<string, { scans: Set<string>; cursor: bigint | null }>();
    for (const row of rows) {
      assertSolanaAddress(row.ownerAddress);
      const entry = byOwner.get(row.ownerAddress) ?? { scans: new Set<string>(), cursor: row.scannedThroughSlot };
      for (const address of row.scanAddresses) {
        assertSolanaAddress(address);
        entry.scans.add(address);
      }
      entry.scans.add(row.ownerAddress);
      // Две записи об одном владельце с разными курсорами: доверяем
      // меньшему. Больший означал бы, что часть истории не смотрели.
      if (row.scannedThroughSlot == null) entry.cursor = null;
      else if (entry.cursor != null && row.scannedThroughSlot < entry.cursor) {
        entry.cursor = row.scannedThroughSlot;
      }
      byOwner.set(row.ownerAddress, entry);
    }
    return [...byOwner.entries()].map(([ownerAddress, entry]) => ({
      ownerAddress,
      scanAddresses: [...entry.scans],
      scannedThroughSlot: entry.cursor,
    }));
  }

  private async signaturesAfter(
    address: string,
    afterSlot: bigint,
    headSlot: bigint,
  ): Promise<SignatureRow[]> {
    const found: SignatureRow[] = [];
    let before: string | undefined;
    for (let page = 0; page < this.maxPagesPerAddress; page++) {
      const config: Record<string, unknown> = {
        commitment: 'confirmed',
        limit: this.signaturePageSize,
      };
      if (before) config.before = before;
      const raw = await this.rpc.call<unknown>('getSignaturesForAddress', [address, config]);
      const rows = signatureRows(raw);
      let reachedBoundary = rows.length < this.signaturePageSize;
      for (const row of rows) {
        const slot = BigInt(row.slot);
        if (slot <= afterSlot) {
          reachedBoundary = true;
          continue;
        }
        if (slot <= headSlot) found.push(row);
      }
      if (reachedBoundary) return found;
      const nextBefore = rows.at(-1)?.signature;
      if (!nextBefore || nextBefore === before) {
        throw new SolanaRpcRequestError('SOLANA_RPC_PAGINATION_STALLED', true);
      }
      before = nextBefore;
    }
    throw new SolanaRpcRequestError('SOLANA_RPC_SCAN_WINDOW_EXHAUSTED', true);
  }

  private async eventsForSignatures(
    signatures: readonly string[],
    watches: readonly SolanaWatchedDestination[],
    failOnUnavailable: boolean,
  ): Promise<SolanaDepositSourceEvent[]> {
    if (signatures.length === 0 || watches.length === 0) return [];
    const statuses = await this.signatureStatuses(signatures);
    const transactions = await mapLimit(signatures, this.transactionConcurrency, async (signature) => ({
      signature,
      transaction: await this.rpc.call<unknown>('getTransaction', [
        signature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ]),
    }));
    const owners = new Set(watches.map((watch) => watch.ownerAddress));
    const watched = new Set(watches.flatMap((watch) => [...watch.scanAddresses]));
    const events: SolanaDepositSourceEvent[] = [];
    for (const item of transactions) {
      const status = statuses.get(item.signature);
      if (!status) {
        if (failOnUnavailable) {
          throw new SolanaRpcRequestError('SOLANA_RPC_SIGNATURE_STATUS_UNAVAILABLE', true);
        }
        continue;
      }
      if (status.err != null) continue;
      if (item.transaction == null) {
        if (failOnUnavailable) {
          throw new SolanaRpcRequestError('SOLANA_RPC_TRANSACTION_UNAVAILABLE', true);
        }
        continue;
      }
      events.push(
        ...parseSolanaDepositTransfers(item.signature, item.transaction, status, owners, watched),
      );
    }
    return events.sort(compareEvents);
  }

  private async signatureStatuses(signatures: readonly string[]): Promise<Map<string, SignatureStatus>> {
    const statuses = new Map<string, SignatureStatus>();
    for (let offset = 0; offset < signatures.length; offset += 256) {
      const batch = signatures.slice(offset, offset + 256);
      const raw = await this.rpc.call<unknown>('getSignatureStatuses', [batch, { searchTransactionHistory: true }]);
      const values = signatureStatusValues(raw);
      if (values.length !== batch.length) {
        throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_STATUSES', false);
      }
      batch.forEach((signature, index) => {
        const status = values[index];
        if (status) statuses.set(signature, status);
      });
    }
    return statuses;
  }
}

/** Owner plus canonical USDC ATA. The derivation is deterministic and makes no network call. */
export function scanAddressesForOwner(ownerAddress: string): string[] {
  const owner = new PublicKey(ownerAddress);
  const [usdcAta] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), CANONICAL_USDC_MINT.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
  return [owner.toBase58(), usdcAta.toBase58()];
}

/**
 * Кодирование позиции инструкции в один индекс.
 *
 * Множитель нужен, чтобы внешняя инструкция и её вложенные не
 * пересеклись по номеру. Ноль внутренней части означает саму
 * внешнюю инструкцию.
 */
const INNER_INDEX_SPAN = 4096;

export function positionalInstructionIndex(outerIndex: number, innerIndex: number | null): number {
  if (innerIndex != null && innerIndex >= INNER_INDEX_SPAN - 1) {
    throw new SolanaRpcRequestError('SOLANA_RPC_INSTRUCTION_INDEX_OVERFLOW', false);
  }
  const index = outerIndex * INNER_INDEX_SPAN + (innerIndex == null ? 0 : innerIndex + 1);
  if (!Number.isSafeInteger(index)) {
    throw new SolanaRpcRequestError('SOLANA_RPC_INSTRUCTION_INDEX_OVERFLOW', false);
  }
  return index;
}

export function parseSolanaDepositTransfers(
  signature: string,
  rawTransaction: unknown,
  status: SignatureStatus,
  watchedOwners: ReadonlySet<string>,
  watchedAccounts: ReadonlySet<string> = watchedOwners,
): SolanaDepositSourceEvent[] {
  const transaction = record(rawTransaction, 'SOLANA_RPC_MALFORMED_TRANSACTION');
  const slot = toSafeSlot(transaction.slot);
  const tx = record(transaction.transaction, 'SOLANA_RPC_MALFORMED_TRANSACTION');
  const message = record(tx.message, 'SOLANA_RPC_MALFORMED_TRANSACTION');
  /*
   * `meta: null` — разрешённый ответ узла, а не испорченный JSON.
   * Он означает «метаданных нет», и без них нельзя ни узнать
   * владельца токен-аккаунта, ни убедиться, что транзакция удалась.
   * Отдельный код нужен, чтобы дежурный отличал отсутствие данных
   * от сломанного провайдера.
   */
  if (transaction.meta == null) {
    throw new SolanaRpcRequestError('SOLANA_RPC_TRANSACTION_META_MISSING', true);
  }
  const meta = record(transaction.meta, 'SOLANA_RPC_MALFORMED_TRANSACTION');
  if (meta.err != null) return [];
  /*
   * В кодировке jsonParsed `accountKeys` уже содержит адреса,
   * подгруженные из lookup-таблиц (`source: "lookupTable"`), поэтому
   * отдельная склейка с `meta.loadedAddresses` не нужна — этого поля
   * в jsonParsed попросту нет. Но если версионная транзакция пришла
   * без разобранных ключей, индексы токен-балансов указывать некуда.
   */
  const accountKeys = requiredArray(message.accountKeys, 'SOLANA_RPC_MALFORMED_TRANSACTION').map(accountKey);
  const lookups = optionalArray(message.addressTableLookups);
  const tokenAccounts = tokenAccountFacts(meta, accountKeys);
  const outer = requiredArray(message.instructions, 'SOLANA_RPC_MALFORMED_TRANSACTION');
  const innerByParent = new Map<number, unknown[]>();
  for (const groupRaw of optionalArray(meta.innerInstructions)) {
    const group = record(groupRaw, 'SOLANA_RPC_MALFORMED_TRANSACTION');
    const index = nonNegativeInt(group.index, 'SOLANA_RPC_MALFORMED_TRANSACTION');
    innerByParent.set(index, requiredArray(group.instructions, 'SOLANA_RPC_MALFORMED_TRANSACTION'));
  }

  const commitment = commitmentOf(status);
  const confirmations = confirmationCount(status, commitment);
  const blockhash = typeof message.recentBlockhash === 'string' ? message.recentBlockhash : null;
  const events: SolanaDepositSourceEvent[] = [];
  const inspect = (instruction: unknown, outerIndex: number, innerIndex: number | null) => {
    const transfer = parsedTransfer(instruction, tokenAccounts, watchedAccounts, lookups.length > 0);
    if (!transfer) return;
    if (!watchedOwners.has(transfer.destination)) return;
    events.push({
      signature,
      /*
       * Индекс — позиция инструкции, а не порядковый номер найденного
       * перевода. Счётчик найденного зависит от того, что удалось
       * разобрать: стоит узлу вернуть токен-балансы иначе, и все
       * последующие переводы в той же транзакции получают новые
       * номера, то есть новые ключи идемпотентности. Один и тот же
       * перевод был бы зачислен второй раз.
       */
      instructionIndex: positionalInstructionIndex(outerIndex, innerIndex),
      slot,
      blockhash,
      network: 'solana',
      mint: transfer.mint,
      destination: transfer.destination,
      rawAmount: transfer.rawAmount,
      confirmations,
      commitment,
    });
  };
  outer.forEach((instruction, index) => {
    inspect(instruction, index, null);
    (innerByParent.get(index) ?? []).forEach((inner, innerIndex) => {
      inspect(inner, index, innerIndex);
    });
  });
  return events;
}

interface ParsedTransfer {
  mint: string | null;
  destination: string;
  rawAmount: bigint;
}

interface TokenAccountFact {
  owner: string;
  mint: string;
}

function parsedTransfer(
  rawInstruction: unknown,
  tokenAccounts: ReadonlyMap<string, TokenAccountFact>,
  watchedAccounts: ReadonlySet<string>,
  hasAddressTableLookups: boolean,
): ParsedTransfer | null {
  /*
   * Частично разобранная инструкция (без поля `parsed`) — штатный
   * ответ jsonParsed для программ без парсера. Переводом она быть
   * не может: и системная программа, и обе токен-программы у узла
   * разбираются всегда.
   */
  if (!isRecord(rawInstruction) || !isRecord(rawInstruction.parsed)) return null;
  const program = rawInstruction.program;
  const type = rawInstruction.parsed.type;
  const info = rawInstruction.parsed.info;
  if (!isRecord(info) || typeof info.destination !== 'string') return null;

  if (program === 'system' && (type === 'transfer' || type === 'transferWithSeed')) {
    const lamports = unsignedIntegerString(info.lamports);
    return lamports == null ? null : {
      mint: null,
      destination: info.destination,
      rawAmount: BigInt(lamports),
    };
  }

  if ((program === 'spl-token' || program === 'spl-token-2022') &&
      (type === 'transfer' || type === 'transferChecked')) {
    const fact = tokenAccounts.get(info.destination);
    if (!fact) {
      /*
       * Владельца токен-аккаунта берём только из метаданных: в самой
       * инструкции его нет. Если получатель — один из наших
       * наблюдаемых счетов, а факта о нём не нашлось, значит перевод
       * возможно наш, но доказать этого нельзя. Молчаливый пропуск
       * здесь означал бы, что деньги пришли, а на балансе их нет
       * и в журнале тоже.
       */
      if (watchedAccounts.has(info.destination)) {
        throw new SolanaRpcRequestError('SOLANA_RPC_TOKEN_ACCOUNT_UNRESOLVED', true);
      }
      // Чужой токен-аккаунт: неразрешимость его владельца нас
      // не касается — если только ключи не подгружены из lookup-таблицы,
      // где промах индекса мог скрыть и наш счёт.
      if (hasAddressTableLookups) {
        throw new SolanaRpcRequestError('SOLANA_RPC_TOKEN_ACCOUNT_UNRESOLVED', true);
      }
      return null;
    }
    const rawAmount = unsignedIntegerString(info.amount) ??
      (isRecord(info.tokenAmount) ? unsignedIntegerString(info.tokenAmount.amount) : null);
    const mint = typeof info.mint === 'string' ? info.mint : fact.mint;
    if (rawAmount == null) {
      throw new SolanaRpcRequestError('SOLANA_RPC_TOKEN_AMOUNT_UNREADABLE', true);
    }
    return { mint, destination: fact.owner, rawAmount: BigInt(rawAmount) };
  }
  return null;
}

function tokenAccountFacts(meta: Record<string, unknown>, accountKeys: readonly string[]) {
  const facts = new Map<string, TokenAccountFact>();
  for (const balance of [
    ...optionalArray(meta.preTokenBalances),
    ...optionalArray(meta.postTokenBalances),
  ]) {
    if (!isRecord(balance)) continue;
    const index = typeof balance.accountIndex === 'number' ? balance.accountIndex : -1;
    const account = accountKeys[index];
    // `owner` и `programId` в токен-балансе необязательны. Запись без
    // владельца ничего не доказывает, поэтому в факты не попадает;
    // если такой счёт окажется нашим, разбор выше остановит цикл.
    if (!account || typeof balance.owner !== 'string' || typeof balance.mint !== 'string') continue;
    facts.set(account, { owner: balance.owner, mint: balance.mint });
  }
  return facts;
}

function commitmentOf(status: SignatureStatus): SolanaCommitment {
  if (status.confirmationStatus === 'finalized') return 'finalized';
  if (status.confirmationStatus === 'confirmed') return 'confirmed';
  return 'processed';
}

function confirmationCount(status: SignatureStatus, commitment: SolanaCommitment): number {
  if (commitment === 'finalized') return FINALIZED_CONFIRMATIONS;
  return typeof status.confirmations === 'number' && Number.isSafeInteger(status.confirmations)
    ? Math.max(0, status.confirmations)
    : 0;
}

function signatureRows(value: unknown): SignatureRow[] {
  return requiredArray(value, 'SOLANA_RPC_MALFORMED_SIGNATURES').map((rowRaw) => {
    const row = record(rowRaw, 'SOLANA_RPC_MALFORMED_SIGNATURES');
    if (typeof row.signature !== 'string') {
      throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_SIGNATURES', false);
    }
    return {
      signature: row.signature,
      slot: Number(toSafeSlot(row.slot)),
      err: row.err,
    };
  });
}

function signatureStatusValues(value: unknown): Array<SignatureStatus | null> {
  const response = record(value, 'SOLANA_RPC_MALFORMED_STATUSES');
  return requiredArray(response.value, 'SOLANA_RPC_MALFORMED_STATUSES').map((raw) => {
    if (raw == null) return null;
    const status = record(raw, 'SOLANA_RPC_MALFORMED_STATUSES');
    const confirmationStatus = status.confirmationStatus;
    if (confirmationStatus !== undefined && confirmationStatus !== 'processed' &&
        confirmationStatus !== 'confirmed' && confirmationStatus !== 'finalized') {
      throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_STATUSES', false);
    }
    const confirmations = status.confirmations;
    if (confirmations !== null && confirmations !== undefined &&
        (!Number.isSafeInteger(confirmations) || Number(confirmations) < 0)) {
      throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_STATUSES', false);
    }
    return {
      confirmations: typeof confirmations === 'number' ? confirmations : null,
      confirmationStatus,
      err: status.err,
    };
  });
}

function signatureFromEventKey(eventKey: string): string {
  const separator = eventKey.lastIndexOf(':');
  if (separator <= 0 || !/^\d+$/.test(eventKey.slice(separator + 1))) {
    throw new SolanaRpcRequestError('SOLANA_DEPOSIT_EVENT_KEY_INVALID', false);
  }
  return eventKey.slice(0, separator);
}

function accountKey(value: unknown): string {
  if (typeof value === 'string') return value;
  if (isRecord(value) && typeof value.pubkey === 'string') return value.pubkey;
  throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_TRANSACTION', false);
}

function assertSolanaAddress(value: string): void {
  try {
    void new PublicKey(value);
  } catch {
    throw new SolanaRpcRequestError('SOLANA_DEPOSIT_ADDRESS_INVALID', false);
  }
}

function toSafeSlot(value: unknown): bigint {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SolanaRpcRequestError('SOLANA_RPC_SLOT_INVALID', false);
  }
  return BigInt(value);
}

function nonNegativeInt(value: unknown, code: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new SolanaRpcRequestError(code, false);
  }
  return value;
}

function unsignedIntegerString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null;
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new SolanaRpcRequestError(code, false);
  return value;
}

function requiredArray(value: unknown, code: string): unknown[] {
  if (!Array.isArray(value)) throw new SolanaRpcRequestError(code, false);
  return value;
}

function optionalArray(value: unknown): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new SolanaRpcRequestError('SOLANA_RPC_MALFORMED_TRANSACTION', false);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function boundedInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value == null) return fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`integer option must be between ${min} and ${max}`);
  }
  return value;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function compareEvents(a: SolanaDepositSourceEvent, b: SolanaDepositSourceEvent): number {
  if (a.slot === b.slot) return a.instructionIndex - b.instructionIndex;
  return a.slot < b.slot ? -1 : 1;
}

async function mapLimit<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}
