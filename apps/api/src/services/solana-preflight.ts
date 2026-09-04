import {
  evaluateScanBudget,
  suggestBootstrapSlot,
  type ScanBudgetResult,
  type BootstrapSlotResult,
} from '@memex/core';
import { SolanaRpcRequestError, type SolanaRpcClient } from './solana-rpc-deposit-source.js';

/**
 * Проверка узла перед включением приёма депозитов.
 *
 * Только чтение. Кошелёк не создаётся, SOL не отправляется, ничего
 * не подписывается, в базу не пишется ни строки. Единственный
 * результат — отчёт о том, годится ли узел.
 *
 * Главный вопрос проверки не «отвечает ли URL», а «та ли это сеть».
 * URL ничего не доказывает: платный endpoint выглядит одинаково для
 * devnet и mainnet, а имя хоста задаёт провайдер. Отличает сети
 * genesis hash — первый блок, которого не подделать конфигурацией.
 *
 * Второй вопрос — не «работает ли метод», а «работает ли он
 * достаточно быстро и стабильно». Узел, отвечающий за восемь секунд,
 * формально исправен, но приём депозитов на нём будет отставать от
 * цепочки постоянно. Поэтому у каждой проверки измеряется задержка,
 * а отказы различаются по причине: таймаут, предел частоты,
 * отсутствие архива и испорченный ответ требуют разных действий.
 */

export type SolanaNetworkName = 'devnet' | 'testnet' | 'mainnet-beta';

/**
 * Известные genesis hash.
 *
 * ВНИМАНИЕ: значения взяты не из официальной документации — Solana
 * их там не публикует. Перед включением приёма подтвердите своё
 * значение командой `solana genesis-hash --url <endpoint>` и при
 * расхождении задайте `SOLANA_EXPECTED_GENESIS_HASH`.
 *
 * Ошибка в константе безопасна в одну сторону: проверка сравнивает
 * наблюдённый хеш с ожидаемым для выбранной сети, поэтому неверная
 * константа может только запретить работу, но не разрешить работу
 * с mainnet вместо devnet.
 */
export const KNOWN_GENESIS_HASHES: Readonly<Record<SolanaNetworkName, string>> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  testnet: '4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY',
};

export type PreflightCheckName =
  | 'HEALTH'
  | 'GENESIS'
  | 'SLOT_CONFIRMED'
  | 'SLOT_FINALIZED'
  | 'COMMITMENT_LAG'
  | 'SIGNATURES_FOR_ADDRESS'
  | 'SIGNATURE_STATUSES'
  | 'GET_TRANSACTION'
  | 'HISTORY_CAPABILITY';

export type PreflightOutcome = 'PASS' | 'FAIL' | 'SKIPPED';

/**
 * Причина отказа.
 *
 * Разные причины требуют разных действий: таймаут лечится другим
 * узлом, предел частоты — платным тарифом, отсутствие архива —
 * узлом с историей, испорченный ответ — жалобой провайдеру.
 * Один общий код «не сработало» не позволяет выбрать ни одно.
 */
export type PreflightFailureKind =
  | 'TIMEOUT'
  | 'RATE_LIMITED'
  | 'HISTORY_UNSUPPORTED'
  | 'MALFORMED_RESPONSE'
  | 'UNAUTHORIZED'
  | 'UNAVAILABLE'
  | 'NETWORK_MISMATCH'
  | 'UNEXPECTED_VALUE';

export interface PreflightCheck {
  name: PreflightCheckName;
  outcome: PreflightOutcome;
  /** Машинный код. Никогда не URL, не ключ и не тело ответа. */
  code: string | null;
  kind: PreflightFailureKind | null;
  /** Безопасная деталь: число или короткий признак. */
  detail: string | null;
  /** Задержка вызова в миллисекундах. Null — вызова не было. */
  latencyMs: number | null;
}

export interface PreflightReport {
  /** Имя сети, а не адрес: URL может содержать API-ключ. */
  network: SolanaNetworkName;
  ok: boolean;
  checks: PreflightCheck[];
  /** Отставание confirmed от finalized в слотах. Null — не измерено. */
  commitmentLagSlots: number | null;
  /** Расчёт бюджета просмотра, если он запрашивался. */
  budget: ScanBudgetResult | null;
  /** Предложение первого слота, если оно запрашивалось. */
  bootstrap: BootstrapSlotResult | null;
}

export interface PreflightOptions {
  network: SolanaNetworkName;
  /** Ожидаемый genesis hash. Пусто — берём из встроенного списка. */
  expectedGenesisHash?: string | null;
  /**
   * Нужна ли история.
   *
   * Приём депозитов ищет транзакции по адресу за прошедшие слоты,
   * поэтому узел без архива будет отвечать «нет такой» на транзакции,
   * которые есть. Для сверки это выглядит как исчезновение.
   */
  requireHistory?: boolean;
  /** Адрес для пробного чтения. Только чтение чужой публичной истории. */
  probeAddress?: string;
  /** Порог задержки, выше которого узел считается непригодным. */
  maxLatencyMs?: number;
  /** Параметры расчёта бюджета и первого слота. */
  planning?: {
    lookbackSlots: number;
    pageSize: number;
    maxPages: number;
    expectedSignaturesPerHour: number;
  };
  /** Часы. Вынесены наружу, чтобы замер задержки был проверяемым. */
  now?: () => number;
}

/** Адрес системной программы: существует в любой сети, никому не принадлежит. */
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

const DEFAULT_MAX_LATENCY_MS = 5_000;

export async function runSolanaPreflight(
  rpc: SolanaRpcClient,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const checks: PreflightCheck[] = [];
  const expected = options.expectedGenesisHash?.trim() || KNOWN_GENESIS_HASHES[options.network];
  const probeAddress = options.probeAddress ?? SYSTEM_PROGRAM;
  const maxLatencyMs = options.maxLatencyMs ?? DEFAULT_MAX_LATENCY_MS;
  const now = options.now ?? (() => Date.now());
  const budget = options.planning ? evaluateScanBudget(options.planning) : null;

  const call = async <T>(fn: () => Promise<T>) => attempt(fn, now);

  const health = await call(() => rpc.call<unknown>('getHealth', []));
  checks.push(health.ok
    ? verdict('HEALTH', String(health.value), health.latencyMs, maxLatencyMs)
    : fail('HEALTH', health.code, health.kind, health.latencyMs));

  const genesis = await call(() => rpc.call<unknown>('getGenesisHash', []));
  if (!genesis.ok) {
    checks.push(fail('GENESIS', genesis.code, genesis.kind, genesis.latencyMs));
    // Без подтверждённой сети остальные проверки бессмысленны:
    // они бы проверяли работоспособность неизвестно чего.
    return report(options.network, checks, null, budget, null);
  }
  const observed = typeof genesis.value === 'string' ? genesis.value : '';
  if (observed !== expected) {
    /*
     * Отдельный код для случая «это mainnet, а ждали не его».
     * Самая вероятная ошибка оператора — оставить боевой URL в
     * переменной, поменяв только имя сети.
     */
    const isMainnet = observed === KNOWN_GENESIS_HASHES['mainnet-beta'];
    checks.push(fail(
      'GENESIS',
      isMainnet && options.network !== 'mainnet-beta'
        ? 'SOLANA_PREFLIGHT_MAINNET_ENDPOINT_REFUSED'
        : 'SOLANA_PREFLIGHT_GENESIS_MISMATCH',
      'NETWORK_MISMATCH',
      genesis.latencyMs,
    ));
    return report(options.network, checks, null, budget, null);
  }
  checks.push(verdict('GENESIS', 'matches', genesis.latencyMs, maxLatencyMs));

  const confirmed = await call(() => rpc.call<unknown>('getSlot', [{ commitment: 'confirmed' }]));
  checks.push(confirmed.ok && isSlot(confirmed.value)
    ? verdict('SLOT_CONFIRMED', String(confirmed.value), confirmed.latencyMs, maxLatencyMs)
    : fail(
        'SLOT_CONFIRMED',
        confirmed.ok ? 'SOLANA_PREFLIGHT_SLOT_INVALID' : confirmed.code,
        confirmed.ok ? 'UNEXPECTED_VALUE' : confirmed.kind,
        confirmed.latencyMs,
      ));

  const finalized = await call(() => rpc.call<unknown>('getSlot', [{ commitment: 'finalized' }]));
  checks.push(finalized.ok && isSlot(finalized.value)
    ? verdict('SLOT_FINALIZED', String(finalized.value), finalized.latencyMs, maxLatencyMs)
    : fail(
        'SLOT_FINALIZED',
        finalized.ok ? 'SOLANA_PREFLIGHT_SLOT_INVALID' : finalized.code,
        finalized.ok ? 'UNEXPECTED_VALUE' : finalized.kind,
        finalized.latencyMs,
      ));

  /*
   * Отставание confirmed от finalized.
   *
   * Депозит зачисляется только по finalized, поэтому это отставание —
   * прямая задержка, которую увидит человек, приславший деньги.
   * Отрицательное значение означает, что узел отдаёт finalized выше
   * confirmed, то есть отвечает неконсистентно.
   */
  let lag: number | null = null;
  if (confirmed.ok && finalized.ok && isSlot(confirmed.value) && isSlot(finalized.value)) {
    lag = Number(confirmed.value) - Number(finalized.value);
    checks.push(lag >= 0
      ? pass('COMMITMENT_LAG', `${lag}`, null)
      : fail('COMMITMENT_LAG', 'SOLANA_PREFLIGHT_COMMITMENT_INCONSISTENT', 'UNEXPECTED_VALUE', null));
  }

  const signatures = await call(() => rpc.call<unknown>('getSignaturesForAddress', [
    probeAddress,
    { commitment: 'confirmed', limit: 1 },
  ]));
  const signatureRows = signatures.ok && Array.isArray(signatures.value) ? signatures.value : null;
  checks.push(signatureRows
    ? verdict('SIGNATURES_FOR_ADDRESS', String(signatureRows.length), signatures.latencyMs, maxLatencyMs)
    : fail(
        'SIGNATURES_FOR_ADDRESS',
        signatures.ok ? 'SOLANA_PREFLIGHT_MALFORMED_SIGNATURES' : signatures.code,
        signatures.ok ? 'MALFORMED_RESPONSE' : signatures.kind,
        signatures.latencyMs,
      ));

  const bootstrap = options.planning && finalized.ok && isSlot(finalized.value)
    ? suggestBootstrapSlot({
        finalizedSlot: Number(finalized.value),
        lookbackSlots: options.planning.lookbackSlots,
        budget: options.planning,
      })
    : null;

  const probeSignature = firstSignature(signatureRows);
  if (!probeSignature) {
    // Пропущено честно: без подписи проверять нечего, и выдавать
    // это за успех значит обещать возможность, которую не проверяли.
    checks.push(skipped('SIGNATURE_STATUSES', 'NO_PROBE_SIGNATURE'));
    checks.push(skipped('GET_TRANSACTION', 'NO_PROBE_SIGNATURE'));
    if (options.requireHistory) checks.push(skipped('HISTORY_CAPABILITY', 'NO_PROBE_SIGNATURE'));
    return report(options.network, checks, lag, budget, bootstrap);
  }

  const statuses = await call(() => rpc.call<unknown>('getSignatureStatuses', [
    [probeSignature],
    { searchTransactionHistory: false },
  ]));
  checks.push(statuses.ok
    ? verdict('SIGNATURE_STATUSES', 'available', statuses.latencyMs, maxLatencyMs)
    : fail('SIGNATURE_STATUSES', statuses.code, statuses.kind, statuses.latencyMs));

  const transaction = await call(() => rpc.call<unknown>('getTransaction', [
    probeSignature,
    { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
  ]));
  checks.push(transaction.ok
    ? verdict(
        'GET_TRANSACTION',
        transaction.value == null ? 'null' : 'object',
        transaction.latencyMs,
        maxLatencyMs,
      )
    : fail('GET_TRANSACTION', transaction.code, transaction.kind, transaction.latencyMs));

  if (options.requireHistory) {
    /*
     * `searchTransactionHistory: true` — та самая возможность, без
     * которой сверка примет отсутствие архива за исчезновение
     * транзакции и поднимет ложную тревогу.
     */
    const history = await call(() => rpc.call<unknown>('getSignatureStatuses', [
      [probeSignature],
      { searchTransactionHistory: true },
    ]));
    checks.push(history.ok
      ? verdict('HISTORY_CAPABILITY', 'available', history.latencyMs, maxLatencyMs)
      : fail(
          'HISTORY_CAPABILITY',
          history.code,
          // Отказ именно этого вызова почти всегда означает узел без
          // архива, а не общую недоступность.
          history.kind === 'UNAVAILABLE' ? 'HISTORY_UNSUPPORTED' : history.kind,
          history.latencyMs,
        ));
  }

  return report(options.network, checks, lag, budget, bootstrap);
}

function report(
  network: SolanaNetworkName,
  checks: PreflightCheck[],
  commitmentLagSlots: number | null,
  budget: ScanBudgetResult | null,
  bootstrap: BootstrapSlotResult | null,
): PreflightReport {
  // Пропущенная проверка не считается пройденной, но и не валит
  // отчёт: она честно помечена как непроверенная.
  const checksOk = checks.every((check) => check.outcome !== 'FAIL');
  const budgetOk = budget == null || budget.status === 'FITS';
  return { network, ok: checksOk && budgetOk, checks, commitmentLagSlots, budget, bootstrap };
}

/** Успех с оглядкой на задержку: медленный узел исправен, но непригоден. */
function verdict(
  name: PreflightCheckName,
  detail: string,
  latencyMs: number,
  maxLatencyMs: number,
): PreflightCheck {
  if (latencyMs > maxLatencyMs) {
    return {
      name,
      outcome: 'FAIL',
      code: 'SOLANA_PREFLIGHT_TOO_SLOW',
      kind: 'TIMEOUT',
      detail: null,
      latencyMs,
    };
  }
  return pass(name, detail, latencyMs);
}

function pass(name: PreflightCheckName, detail: string | null, latencyMs: number | null): PreflightCheck {
  return { name, outcome: 'PASS', code: null, kind: null, detail, latencyMs };
}

function fail(
  name: PreflightCheckName,
  code: string,
  kind: PreflightFailureKind | null,
  latencyMs: number | null,
): PreflightCheck {
  return { name, outcome: 'FAIL', code, kind, detail: null, latencyMs };
}

function skipped(name: PreflightCheckName, code: string): PreflightCheck {
  return { name, outcome: 'SKIPPED', code, kind: null, detail: null, latencyMs: null };
}

type Attempt<T> =
  | { ok: true; value: T; latencyMs: number }
  | { ok: false; code: string; kind: PreflightFailureKind; latencyMs: number };

async function attempt<T>(call: () => Promise<T>, now: () => number): Promise<Attempt<T>> {
  const started = now();
  try {
    const value = await call();
    return { ok: true, value, latencyMs: Math.max(0, now() - started) };
  } catch (error: unknown) {
    // В код попадает только классификация ошибки. Ни URL, ни ключ,
    // ни тело ответа провайдера в отчёт не проникают.
    return {
      ok: false,
      code: error instanceof SolanaRpcRequestError ? error.code : 'SOLANA_PREFLIGHT_CALL_FAILED',
      kind: classify(error),
      latencyMs: Math.max(0, now() - started),
    };
  }
}

/** Причина отказа по коду транспорта. Догадок нет, только разбор кода. */
export function classify(error: unknown): PreflightFailureKind {
  if (!(error instanceof SolanaRpcRequestError)) return 'UNAVAILABLE';
  const code = error.code;
  if (code === 'SOLANA_RPC_TIMEOUT') return 'TIMEOUT';
  if (code === 'SOLANA_RPC_HTTP_429') return 'RATE_LIMITED';
  if (code === 'SOLANA_RPC_HTTP_401' || code === 'SOLANA_RPC_HTTP_403') return 'UNAUTHORIZED';
  if (code === 'SOLANA_RPC_MALFORMED_RESPONSE' || code.startsWith('SOLANA_RPC_MALFORMED')) {
    return 'MALFORMED_RESPONSE';
  }
  /*
   * -32602 «Invalid params» и -32601 «Method not found» на запросе
   * с историей означают узел без архива, а не сломанный узел.
   */
  if (code === 'SOLANA_RPC_ERROR_-32602' || code === 'SOLANA_RPC_ERROR_-32601') {
    return 'HISTORY_UNSUPPORTED';
  }
  return 'UNAVAILABLE';
}

function isSlot(value: unknown): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function firstSignature(rows: unknown[] | null): string | null {
  const first = rows?.[0];
  if (first != null && typeof first === 'object' && 'signature' in first) {
    const signature = (first as { signature: unknown }).signature;
    if (typeof signature === 'string' && signature.length > 0) return signature;
  }
  return null;
}
