import {
  BLOCKHASH_MAX_AGE_MS,
  checkBlockhash,
  type BlockhashFacts,
} from '@memex/core';
import { KNOWN_GENESIS_HASHES } from './solana-preflight.js';
import { SolanaRpcRequestError, type SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Свежий blockhash для сборки транзакции.
 *
 * Раньше в проверочном пути стояла заглушка — тридцать двоек. Она
 * была честной: намерение с ней нельзя ни подписать осмысленно, ни
 * отправить. Но заглушка не проверяет ничего, а нам нужно убедиться,
 * что подпись строится над настоящим сообщением настоящей сети.
 *
 * Три правила, из которых состоит этот модуль.
 *
 * **Сеть проверяется до значения.** Genesis hash сверяется раньше,
 * чем берётся blockhash: значение из другой сети синтаксически
 * неотличимо от нужного, и подпись выйдет под транзакцией, которой
 * в devnet никогда не было.
 *
 * **Кэш короче сетевого окна.** Solana держит blockhash ограниченное
 * число блоков; подписывать на самой границе значит рассчитывать,
 * что между проверкой и подписью не пройдёт ни одного блока.
 *
 * **Без разрешения подписывать в сеть не ходим.** Выключённый контур
 * не должен обращаться к RPC вообще: лишний трафик от выключённой
 * функции — это и счёт от провайдера, и след там, где его не ждут.
 */

export class BlockhashError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'BlockhashError';
  }
}

export interface BlockhashProviderOptions {
  network: string;
  /** Разрешение обращаться к сети. Выключено — не ходим вовсе. */
  signingEnabled: boolean;
  now?: () => number;
}

export class SolanaBlockhashProvider {
  private cached: BlockhashFacts | null = null;
  /** Подтверждена ли сеть. Проверяется один раз на клиент. */
  private networkVerified = false;

  constructor(
    private readonly rpc: SolanaRpcClient | null,
    private readonly options: BlockhashProviderOptions,
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /**
   * Подтверждение сети.
   *
   * Только devnet. Боевая сеть отвергается здесь, а не флагом выше:
   * запрет, живущий в единственном месте, переживает рефакторинг
   * вызывающего.
   */
  private async verifyNetwork(): Promise<void> {
    if (this.networkVerified) return;
    if (this.options.network !== 'devnet') throw new BlockhashError('BLOCKHASH_NETWORK_FORBIDDEN');
    if (!this.rpc) throw new BlockhashError('BLOCKHASH_RPC_NOT_CONFIGURED');

    let genesis: unknown;
    try {
      genesis = await this.rpc.call<unknown>('getGenesisHash', []);
    } catch (error: unknown) {
      // Наружу выходит код, а не сообщение: в нём может быть адрес.
      throw new BlockhashError(
        error instanceof SolanaRpcRequestError ? error.code : 'BLOCKHASH_RPC_UNAVAILABLE',
      );
    }

    if (genesis !== KNOWN_GENESIS_HASHES.devnet) {
      /*
       * Отдельный код для боевого узла: самая вероятная ошибка
       * оператора — оставить mainnet-адрес, поменяв только имя сети.
       */
      throw new BlockhashError(
        genesis === KNOWN_GENESIS_HASHES['mainnet-beta']
          ? 'BLOCKHASH_MAINNET_REFUSED'
          : 'BLOCKHASH_GENESIS_MISMATCH',
      );
    }
    this.networkVerified = true;
  }

  /**
   * Blockhash и высота, после которой он мёртв.
   *
   * Кэш переиспользуется только внутри безопасного окна: сэкономить
   * вызов ценой подписи под мёртвым значением — плохая сделка.
   */
  async fetch(): Promise<BlockhashFacts> {
    if (!this.options.signingEnabled) throw new BlockhashError('BLOCKHASH_SIGNING_DISABLED');

    const fresh = checkBlockhash({
      facts: this.cached,
      nowMs: this.now(),
      expectedNetwork: this.options.network,
      currentBlockHeight: null,
    });
    if (fresh === 'OK' && this.cached) return this.cached;

    await this.verifyNetwork();

    let response: unknown;
    try {
      response = await this.rpc!.call<unknown>('getLatestBlockhash', [
        { commitment: 'finalized' },
      ]);
    } catch (error: unknown) {
      throw new BlockhashError(
        error instanceof SolanaRpcRequestError ? error.code : 'BLOCKHASH_RPC_UNAVAILABLE',
      );
    }

    const value = extractValue(response);
    const blockhash = typeof value.blockhash === 'string' ? value.blockhash : '';
    const height = value.lastValidBlockHeight;

    if (!blockhash) throw new BlockhashError('BLOCKHASH_MALFORMED');
    /*
     * Высота хранится строкой.
     *
     * Она растёт за пределы точного целого в JavaScript, и
     * округление здесь означало бы подпись под значением, срок
     * которого мы посчитали неверно.
     */
    if (typeof height !== 'number' || !Number.isSafeInteger(height) || height < 0) {
      throw new BlockhashError('BLOCKHASH_HEIGHT_INVALID');
    }

    this.cached = {
      blockhash,
      lastValidBlockHeight: String(height),
      network: this.options.network,
      fetchedAtMs: this.now(),
    };
    return this.cached;
  }

  /** Сбросить кэш. Нужен после ошибки и в тестах. */
  invalidate(): void {
    this.cached = null;
  }

  get cacheAgeMs(): number | null {
    return this.cached ? this.now() - this.cached.fetchedAtMs : null;
  }

  get maxAgeMs(): number {
    return BLOCKHASH_MAX_AGE_MS;
  }
}

function extractValue(response: unknown): Record<string, unknown> {
  if (response == null || typeof response !== 'object') {
    throw new BlockhashError('BLOCKHASH_MALFORMED');
  }
  const envelope = response as Record<string, unknown>;
  // У `getLatestBlockhash` полезная часть лежит в `value`.
  const value = envelope.value ?? envelope;
  if (value == null || typeof value !== 'object') throw new BlockhashError('BLOCKHASH_MALFORMED');
  return value as Record<string, unknown>;
}
