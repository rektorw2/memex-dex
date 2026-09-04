import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  assetByMint,
  assetByMintForNetwork,
  devnetTestAsset,
  DEVNET_TEST_TOKEN_SYMBOL,
  SOLANA_DEPOSIT_ASSETS,
} from '@memex/core';
import {
  runSolanaPreflight,
  classify,
  KNOWN_GENESIS_HASHES,
  type PreflightCheckName,
  type PreflightReport,
} from './solana-preflight.js';
import { runSolanaDepositDryRun } from './solana-deposit-dry-run.js';
import {
  parseSolanaDepositTransfers,
  positionalInstructionIndex,
  scanAddressesForOwner,
  SolanaRpcRequestError,
  type SignatureStatus,
  type SolanaRpcClient,
} from './solana-rpc-deposit-source.js';

/**
 * Проверка devnet-контура на формах ответов, которые Solana отдаёт
 * на самом деле.
 *
 * Фикстуры собраны по официальной документации JSON-RPC, а не по
 * нашему представлению о ней: моки, написанные по представлению,
 * подтверждают представление, а не формат.
 */

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const [OWNER_ADDRESS, USDC_ATA] = scanAddressesForOwner(OWNER);
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SECRET_URL = 'https://rpc.example.com/v1/?api-key=super-secret-value';

const FINALIZED: SignatureStatus = {
  confirmations: null,
  confirmationStatus: 'finalized',
  err: null,
};

/**
 * Исходник без комментариев.
 *
 * Контрактный тест, читающий файл целиком, склонен обвинять
 * объяснение вместо кода: в шапке модуля как раз и перечислено то,
 * чего он не делает.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const owners = new Set([OWNER_ADDRESS!]);
const watched = new Set([OWNER_ADDRESS!, USDC_ATA!]);

class FakeRpc implements SolanaRpcClient {
  readonly calls: string[] = [];
  constructor(
    private readonly answer: (method: string, params: readonly unknown[]) => unknown,
    private readonly delayMs = 0,
  ) {}
  async call<T>(method: string, params: readonly unknown[]): Promise<T> {
    this.calls.push(method);
    const value = this.answer(method, params);
    if (value instanceof Error) throw value;
    return value as T;
  }
  get latency(): number {
    return this.delayMs;
  }
}

const healthyDevnet = (over: Record<string, unknown> = {}) =>
  new FakeRpc((method) => {
    if (method in over) return over[method];
    switch (method) {
      case 'getHealth': return 'ok';
      case 'getGenesisHash': return KNOWN_GENESIS_HASHES.devnet;
      case 'getSlot': return 400_000_000;
      case 'getSignaturesForAddress': return [{ signature: 'probe', slot: 1, err: null }];
      case 'getSignatureStatuses': return { value: [FINALIZED] };
      case 'getTransaction': return { slot: 1 };
      default: return null;
    }
  });

const outcome = (report: PreflightReport, name: PreflightCheckName) =>
  report.checks.find((check) => check.name === name);

// ═════════════════════════ 1. Preflight ══════════════════════════════════════

describe('preflight: задержка', () => {
  /** Часы, прибавляющие фиксированный шаг на каждый вызов. */
  const steppedClock = (stepMs: number) => {
    let t = 0;
    return () => (t += stepMs) - stepMs;
  };

  it('задержка измеряется для каждого вызова', async () => {
    const report = await runSolanaPreflight(healthyDevnet(), {
      network: 'devnet',
      now: steppedClock(50),
    });

    for (const check of report.checks) {
      if (check.outcome === 'SKIPPED' || check.name === 'COMMITMENT_LAG') continue;
      expect(check.latencyMs, check.name).not.toBeNull();
    }
  });

  it('медленный узел признаётся непригодным, хотя он исправен', async () => {
    // Узел, отвечающий за восемь секунд, формально работает, но
    // приём депозитов на нём будет отставать от цепочки постоянно.
    const report = await runSolanaPreflight(healthyDevnet(), {
      network: 'devnet',
      now: steppedClock(8_000),
      maxLatencyMs: 5_000,
    });

    expect(report.ok).toBe(false);
    expect(outcome(report, 'HEALTH')?.code).toBe('SOLANA_PREFLIGHT_TOO_SLOW');
  });

  it('быстрый узел проходит', async () => {
    const report = await runSolanaPreflight(healthyDevnet(), {
      network: 'devnet',
      now: steppedClock(20),
      maxLatencyMs: 5_000,
    });

    expect(report.ok).toBe(true);
  });
});

describe('preflight: классификация отказов', () => {
  const table: Array<[string, string]> = [
    ['SOLANA_RPC_TIMEOUT', 'TIMEOUT'],
    ['SOLANA_RPC_HTTP_429', 'RATE_LIMITED'],
    ['SOLANA_RPC_HTTP_401', 'UNAUTHORIZED'],
    ['SOLANA_RPC_HTTP_403', 'UNAUTHORIZED'],
    ['SOLANA_RPC_MALFORMED_RESPONSE', 'MALFORMED_RESPONSE'],
    ['SOLANA_RPC_MALFORMED_STATUSES', 'MALFORMED_RESPONSE'],
    ['SOLANA_RPC_ERROR_-32602', 'HISTORY_UNSUPPORTED'],
    ['SOLANA_RPC_HTTP_500', 'UNAVAILABLE'],
  ];

  for (const [code, kind] of table) {
    it(`${code} → ${kind}`, () => {
      // Разные причины требуют разных действий: другой узел, платный
      // тариф, узел с архивом, жалоба провайдеру. Общее «не сработало»
      // не позволяет выбрать ни одно.
      expect(classify(new SolanaRpcRequestError(code, true))).toBe(kind);
    });
  }

  it('чужая ошибка не выдаётся за известную', () => {
    expect(classify(new Error('boom'))).toBe('UNAVAILABLE');
  });

  it('отказ архива классифицируется отдельно от общей недоступности', async () => {
    const node = new FakeRpc((method, params) => {
      if (method === 'getGenesisHash') return KNOWN_GENESIS_HASHES.devnet;
      if (method === 'getHealth') return 'ok';
      if (method === 'getSlot') return 1;
      if (method === 'getSignaturesForAddress') return [{ signature: 'probe', slot: 1, err: null }];
      if (method === 'getTransaction') return { slot: 1 };
      if (method === 'getSignatureStatuses') {
        const config = params[1] as { searchTransactionHistory?: boolean };
        if (config?.searchTransactionHistory) {
          return new SolanaRpcRequestError('SOLANA_RPC_HTTP_500', true);
        }
        return { value: [FINALIZED] };
      }
      return null;
    });

    const report = await runSolanaPreflight(node, { network: 'devnet', requireHistory: true });

    expect(outcome(report, 'HISTORY_CAPABILITY')?.kind).toBe('HISTORY_UNSUPPORTED');
  });
});

describe('preflight: сеть и отставание', () => {
  it('ожидаемая devnet принимается', async () => {
    expect((await runSolanaPreflight(healthyDevnet(), { network: 'devnet' })).ok).toBe(true);
  });

  it('mainnet вместо devnet отклоняется своим кодом', async () => {
    const report = await runSolanaPreflight(
      healthyDevnet({ getGenesisHash: KNOWN_GENESIS_HASHES['mainnet-beta'] }),
      { network: 'devnet' },
    );

    expect(report.ok).toBe(false);
    expect(outcome(report, 'GENESIS')?.code).toBe('SOLANA_PREFLIGHT_MAINNET_ENDPOINT_REFUSED');
    expect(outcome(report, 'GENESIS')?.kind).toBe('NETWORK_MISMATCH');
  });

  it('отставание confirmed от finalized измеряется', async () => {
    let call = 0;
    const node = new FakeRpc((method) => {
      if (method === 'getGenesisHash') return KNOWN_GENESIS_HASHES.devnet;
      if (method === 'getHealth') return 'ok';
      // Первый getSlot — confirmed, второй — finalized.
      if (method === 'getSlot') return call++ === 0 ? 1_000 : 968;
      if (method === 'getSignaturesForAddress') return [];
      return null;
    });

    const report = await runSolanaPreflight(node, { network: 'devnet' });

    expect(report.commitmentLagSlots).toBe(32);
  });

  it('finalized выше confirmed — неконсистентный узел', async () => {
    let call = 0;
    const node = new FakeRpc((method) => {
      if (method === 'getGenesisHash') return KNOWN_GENESIS_HASHES.devnet;
      if (method === 'getHealth') return 'ok';
      if (method === 'getSlot') return call++ === 0 ? 900 : 1_000;
      if (method === 'getSignaturesForAddress') return [];
      return null;
    });

    const report = await runSolanaPreflight(node, { network: 'devnet' });

    expect(outcome(report, 'COMMITMENT_LAG')?.outcome).toBe('FAIL');
  });

  it('нехватка бюджета просмотра валит отчёт', async () => {
    const report = await runSolanaPreflight(healthyDevnet(), {
      network: 'devnet',
      planning: {
        lookbackSlots: 216_000, pageSize: 10, maxPages: 2, expectedSignaturesPerHour: 500,
      },
    });

    expect(report.budget?.status).toBe('INSUFFICIENT_SCAN_BUDGET');
    expect(report.ok).toBe(false);
  });

  it('первый слот предлагается от finalized', async () => {
    const report = await runSolanaPreflight(healthyDevnet(), {
      network: 'devnet',
      planning: {
        lookbackSlots: 9_000, pageSize: 100, maxPages: 10, expectedSignaturesPerHour: 10,
      },
    });

    expect(report.bootstrap?.status).toBe('OK');
    expect(report.bootstrap?.suggestedSlot).toBe(400_000_000 - 9_000);
  });
});

// ═════════════════════ 2. Секреты не выходят наружу ══════════════════════════

describe('endpoint и ключ не покидают процесс', () => {
  it('адрес узла не попадает в отчёт preflight', async () => {
    const node = new FakeRpc(() => {
      throw new Error(`connect ECONNREFUSED ${SECRET_URL}`);
    });

    const serialized = JSON.stringify(await runSolanaPreflight(node, { network: 'devnet' }));

    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('rpc.example.com');
    expect(serialized).not.toMatch(/https?:\/\//);
  });

  it('адрес узла не попадает в сводку холостого прогона', async () => {
    const node = new FakeRpc(() => {
      throw new SolanaRpcRequestError('SOLANA_RPC_TIMEOUT', true);
    });

    const summary = await runSolanaDepositDryRun(node, 'devnet', {
      address: OWNER,
      fromSlot: 1n,
    });

    expect(JSON.stringify(summary)).not.toMatch(/https?:\/\/|api-key/);
  });

  it('транспорт не кладёт endpoint в текст ошибки', () => {
    const source = readFileSync(
      new URL('./solana-rpc-deposit-source.ts', import.meta.url), 'utf8',
    );
    const transport = source.slice(source.indexOf('class FetchSolanaRpcClient'));
    const throws = transport.match(/new SolanaRpcRequestError\([^)]*\)/g) ?? [];

    expect(throws.length).toBeGreaterThan(0);
    for (const line of throws) {
      expect(line).not.toContain('this.endpoint');
      expect(line).not.toContain('response.url');
    }
  });

  it('скрипт запуска печатает имя сети, а не адрес', () => {
    const script = readFileSync(
      new URL('../../scripts/solana-deposit-preflight.ts', import.meta.url), 'utf8',
    );
    const prints = script.match(/console\.log\([^;]*\)/gs) ?? [];

    for (const line of prints) {
      expect(line).not.toContain('endpoint');
      expect(line).not.toContain('SOLANA_PREFLIGHT_RPC_URL');
    }
  });
});

// ═══════════════════ 3. Холостой прогон ничего не пишет ══════════════════════

describe('холостой прогон', () => {
  const depositNode = () => new FakeRpc((method, params) => {
    if (method === 'getSlot') return 500;
    if (method === 'getSignaturesForAddress') {
      return params[0] === OWNER_ADDRESS ? [{ signature: 'sig-1', slot: 400, err: null }] : [];
    }
    if (method === 'getSignatureStatuses') return { value: [FINALIZED] };
    if (method === 'getTransaction') return solTransaction(400);
    return null;
  });

  it('считает переводы и диапазон', async () => {
    const summary = await runSolanaDepositDryRun(depositNode(), 'devnet', {
      address: OWNER,
      fromSlot: 100n,
    });

    expect(summary.solTransfers).toBe(1);
    expect(summary.signatures).toBe(1);
    expect(summary.scannedThroughSlot).toBe('500');
    expect(summary.failureCode).toBeNull();
  });

  it('сумма отдаётся строкой без потери точности', async () => {
    // u64 не помещается в число с плавающей точкой, а округление
    // суммы в отчёте о деньгах — плохое начало.
    const huge = 18_446_744_073_709_551_615n;
    const node = new FakeRpc((method, params) => {
      if (method === 'getSlot') return 500;
      if (method === 'getSignaturesForAddress') {
        return params[0] === OWNER_ADDRESS ? [{ signature: 'sig-1', slot: 400, err: null }] : [];
      }
      if (method === 'getSignatureStatuses') return { value: [FINALIZED] };
      if (method === 'getTransaction') return solTransaction(400, huge.toString());
      return null;
    });

    const summary = await runSolanaDepositDryRun(node, 'devnet', { address: OWNER, fromSlot: 1n });

    expect(summary.largestRawAmount).toBe('18446744073709551615');
    // Доказательство, что потеря была бы настоящей: через Number это
    // же значение превращается в 18446744073709552000.
    expect(String(Number('18446744073709551615'))).not.toBe('18446744073709551615');
  });

  it('ошибка не превращается в ноль переводов', async () => {
    const node = new FakeRpc(() => {
      throw new SolanaRpcRequestError('SOLANA_RPC_PAGINATION_STALLED', true);
    });

    const summary = await runSolanaDepositDryRun(node, 'devnet', { address: OWNER, fromSlot: 1n });

    // «Ноль переводов» и «прочитать не удалось» — разные ответы.
    expect(summary.failureCode).toBe('SOLANA_RPC_PAGINATION_STALLED');
  });

  it('модуль не умеет писать в базу', () => {
    /*
     * Комментарии вырезаются перед проверкой.
     *
     * Без этого тест обвиняет собственную документацию: в шапке
     * модуля перечислено ровно то, чего он не делает, — `Deposit`,
     * `LedgerEntry`, `Balance`. Совпадение с текстом объяснения
     * не является совпадением с кодом.
     */
    const code = withoutComments(
      readFileSync(new URL('./solana-deposit-dry-run.ts', import.meta.url), 'utf8'),
    );

    // Не «мы не вызываем запись», а «записать нечем».
    expect(code).not.toMatch(/prisma|PrismaClient|balances\.|LedgerEntry|creditFinalized/);
  });

  it('курсор адреса не сохраняется', () => {
    const source = withoutComments(
      readFileSync(new URL('./solana-deposit-dry-run.ts', import.meta.url), 'utf8'),
    );
    const method = source.slice(source.indexOf('async recordScannedThrough'));

    // Записать курсор отсюда значит объявить диапазон просмотренным
    // тем циклом, который никого не зачислял.
    expect(method.slice(0, method.indexOf('}'))).not.toMatch(/prisma|upsert|update/);
  });

  it('userId от источника не принимается', () => {
    const code = withoutComments(
      readFileSync(new URL('./solana-deposit-dry-run.ts', import.meta.url), 'utf8'),
    );

    expect(code).not.toMatch(/userId/);
  });
});

// ═════════════════════ 4. Формы ответов из документации ══════════════════════

function solTransaction(slot: number, lamports: string = '5000000') {
  return {
    slot,
    transaction: {
      message: {
        accountKeys: [{ pubkey: OWNER_ADDRESS!, source: 'transaction' }],
        instructions: [{
          program: 'system',
          programId: '11111111111111111111111111111111',
          parsed: { type: 'transfer', info: { destination: OWNER_ADDRESS!, lamports } },
        }],
        recentBlockhash: 'hash-a',
      },
    },
    meta: { err: null, innerInstructions: [], postTokenBalances: [] },
  };
}

describe('формы ответов Solana', () => {
  it('versioned-транзакция с lookup-таблицей разбирается', () => {
    /*
     * В jsonParsed `accountKeys` уже содержит адреса из lookup-таблиц
     * с пометкой source: "lookupTable", а `meta.loadedAddresses`
     * в этой кодировке отсутствует. Отдельная склейка не нужна.
     */
    const raw = {
      slot: 100,
      version: 0,
      transaction: {
        message: {
          accountKeys: [
            { pubkey: 'Static111', source: 'transaction' },
            { pubkey: USDC_ATA!, source: 'lookupTable' },
          ],
          addressTableLookups: [
            { accountKey: 'table', writableIndexes: [4], readonlyIndexes: [] },
          ],
          instructions: [{
            program: 'spl-token',
            parsed: {
              type: 'transferChecked',
              info: { destination: USDC_ATA!, mint: USDC, tokenAmount: { amount: '1000000' } },
            },
          }],
          recentBlockhash: 'hash-a',
        },
      },
      meta: {
        err: null,
        innerInstructions: [],
        postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: OWNER_ADDRESS! }],
      },
    };

    const events = parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched);

    expect(events).toHaveLength(1);
    expect(events[0]!.destination).toBe(OWNER_ADDRESS);
  });

  it('legacy-транзакция разбирается так же', () => {
    const events = parseSolanaDepositTransfers(
      'sig', { ...solTransaction(100), version: 'legacy' }, FINALIZED, owners, watched,
    );

    expect(events).toHaveLength(1);
  });

  it('u64 на верхней границе не теряет точности', () => {
    const max = '18446744073709551615';
    const events = parseSolanaDepositTransfers(
      'sig', solTransaction(100, max), FINALIZED, owners, watched,
    );

    // Через Number это значение стало бы 18446744073709552000.
    expect(events[0]!.rawAmount).toBe(18_446_744_073_709_551_615n);
    expect(events[0]!.rawAmount.toString()).toBe(max);
  });

  it('transaction: null не выдаётся за отсутствие перевода', () => {
    expect(() => parseSolanaDepositTransfers('sig', null, FINALIZED, owners, watched))
      .toThrow(SolanaRpcRequestError);
  });

  it('meta: null получает свой код', () => {
    expect(() => parseSolanaDepositTransfers(
      'sig', { ...solTransaction(100), meta: null }, FINALIZED, owners, watched,
    )).toThrowError(expect.objectContaining({ code: 'SOLANA_RPC_TRANSACTION_META_MISSING' }));
  });

  it('transfer и transferChecked оба распознаются', () => {
    for (const type of ['transfer', 'transferChecked']) {
      const raw = {
        slot: 100,
        transaction: {
          message: {
            accountKeys: [{ pubkey: USDC_ATA!, source: 'transaction' }],
            instructions: [{
              program: 'spl-token',
              parsed: { type, info: { destination: USDC_ATA!, mint: USDC, amount: '7' } },
            }],
            recentBlockhash: 'h',
          },
        },
        meta: {
          err: null, innerInstructions: [],
          postTokenBalances: [{ accountIndex: 0, mint: USDC, owner: OWNER_ADDRESS! }],
        },
      };
      expect(parseSolanaDepositTransfers('sig', raw, FINALIZED, owners, watched), type)
        .toHaveLength(1);
    }
  });

  it('одна подпись через owner и token account даёт один набор событий', () => {
    // Дедупликация по подписи: иначе один перевод был бы зачислен
    // столько раз, сколько наших адресов его увидело.
    const events = parseSolanaDepositTransfers(
      'sig', solTransaction(100), FINALIZED, owners, watched,
    );
    const keys = events.map((e) => `${e.signature}:${e.instructionIndex}`);

    expect(new Set(keys).size).toBe(keys.length);
  });

  it('индексы позиционные и не зависят от числа находок', () => {
    expect(positionalInstructionIndex(0, null)).toBe(0);
    expect(positionalInstructionIndex(1, null)).toBeGreaterThan(positionalInstructionIndex(0, 4094));
  });
});

// ═══════════════════════ 5. Тестовый токен devnet ════════════════════════════

describe('тестовый токен devnet', () => {
  const TEST_MINT = 'DevnetTestMint1111111111111111111111111111';

  it('в devnet распознаётся', () => {
    const asset = devnetTestAsset({ network: 'devnet', mint: TEST_MINT, decimals: 6 });
    expect(asset?.mint).toBe(TEST_MINT);
  });

  it('называется своим именем, а не USDC', () => {
    // Если он выглядит как USDC, через неделю никто не вспомнит,
    // что это подделка для проверки разбора.
    const asset = devnetTestAsset({ network: 'devnet', mint: TEST_MINT, decimals: 6 });
    expect(asset?.symbol).toBe(DEVNET_TEST_TOKEN_SYMBOL);
    expect(asset?.symbol).not.toMatch(/USDC/i);
  });

  it('в mainnet не распознаётся ни при каком значении', () => {
    for (const network of ['mainnet-beta', 'testnet', 'production', '']) {
      expect(devnetTestAsset({ network, mint: TEST_MINT, decimals: 6 }), network).toBeNull();
    }
  });

  it('не может носить адрес настоящего USDC', () => {
    expect(devnetTestAsset({ network: 'devnet', mint: USDC, decimals: 6 })).toBeNull();
  });

  it('боевой список остаётся неизменным', () => {
    expect(SOLANA_DEPOSIT_ASSETS.map((a) => a.symbol)).toEqual(['SOL', 'USDC']);
    expect(SOLANA_DEPOSIT_ASSETS.some((a) => a.symbol === DEVNET_TEST_TOKEN_SYMBOL)).toBe(false);
  });

  it('обычный поиск по mint тестовый токен не находит', () => {
    expect(assetByMint(TEST_MINT)).toBeNull();
  });

  it('поиск с учётом сети находит его только в devnet', () => {
    const devnet = { network: 'devnet', mint: TEST_MINT, decimals: 6 };
    const mainnet = { network: 'mainnet-beta', mint: TEST_MINT, decimals: 6 };

    expect(assetByMintForNetwork(TEST_MINT, devnet)?.symbol).toBe(DEVNET_TEST_TOKEN_SYMBOL);
    expect(assetByMintForNetwork(TEST_MINT, mainnet)).toBeNull();
  });

  it('боевые активы находятся в любой сети', () => {
    const devnet = { network: 'devnet', mint: TEST_MINT, decimals: 6 };
    expect(assetByMintForNetwork(USDC, devnet)?.symbol).toBe('USDC');
    expect(assetByMintForNetwork(null, devnet)?.symbol).toBe('SOL');
  });
});
