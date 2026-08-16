/**
 * История DEX-сделок кошелька — единственный источник точных чисел.
 *
 * Это ответ на конкретную ловушку. Лента отслеживания и WebSocket
 * дают направление, токен, цену и количество котировочного токена,
 * но не дают количество купленного. Соблазн посчитать его как
 * `quoteTokenAmount / tokenPrice` очень велик и совершенно неверен:
 * это разные валюты, и результат зависит от того, в чём выражена
 * цена. Одна такая подстановка портит среднюю себестоимость,
 * размер позиции, зафиксированный результат, долю удачных сделок
 * и итоговую оценку — всё сразу и незаметно.
 *
 * Поэтому разделение жёсткое:
 *
 *   лента отслеживания → быстрый сигнал для интерфейса;
 *   история DEX        → точные числа для расчёта позиций.
 *
 * Второе правило — числа не проходят через Number. Количество токена
 * с восемнадцатью знаками после запятой в double теряет точность
 * молча, и обнаруживается это как расхождение остатка на копейки,
 * которое накапливается. Строки хранятся строками и передаются
 * в Decimal там, где считают.
 */

import type { ChainKey } from './token-registry.js';
import { normalizeAddress } from './token-registry.js';
import { chainFromIndex, okxStr, okxInt } from './okx-model.js';
import { okxMillis } from './okx-wallet-model.js';
import { canonicalDecimal } from './ledger-completeness.js';

/** Виды операций в истории. */
export const DEX_HISTORY_TYPE = {
  buy: '1',
  sell: '2',
  transferIn: '3',
  transferOut: '4',
} as const;

/**
 * Только покупки и продажи попадают в расчёт позиций.
 *
 * Переводы — это перемещение уже имеющегося, а не сделка. Считать
 * приход переводом покупкой значит приписать кошельку цену входа,
 * которой не было; дальше любой рост выглядит прибылью.
 */
export const LEDGER_TYPES: string[] = [DEX_HISTORY_TYPE.buy, DEX_HISTORY_TYPE.sell];

export function isLedgerType(type: string | null): boolean {
  return type != null && LEDGER_TYPES.includes(type);
}

/**
 * Каноническая сделка.
 *
 * Числа хранятся строками намеренно — см. пояснение в шапке модуля.
 * Преобразование в число делается там, где считают, и осознанно.
 */
export interface CanonicalTrade {
  /** Устойчивый ключ. История не отдаёт хеш транзакции. */
  key: string;
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  tokenSymbol: string | null;
  side: 'BUY' | 'SELL';
  /** Количество токена. Точное, из истории. */
  amount: string;
  valueUsd: string;
  price: string;
  marketCapUsd: string | null;
  /** Результат по версии OKX. Хранится для сверки, в расчёт не идёт. */
  providerPnlUsd: string | null;
  tradedAt: number;
}

export interface HistoryPage {
  trades: CanonicalTrade[];
  /** Непрозрачная строка для следующей страницы. */
  cursor: string | null;
  /** Что и почему отброшено — чтобы фильтр можно было проверить. */
  skipped: Record<string, number>;
}

/**
 * Ключ канонической сделки.
 *
 * История не возвращает хеш транзакции, поэтому ключ собирается
 * из того, что делает сделку уникальной. Символ токена в ключ
 * не входит: он не уникален и меняется — идентификатором служит
 * только адрес контракта.
 */
export function canonicalKey(t: {
  chain: ChainKey;
  wallet: string;
  tokenAddress: string;
  side: string;
  tradedAt: number;
  amount: string;
  valueUsd: string;
  price: string;
}): string {
  // Числа приводятся к единому виду перед склейкой. Строки «1»,
  // «1.0» и «1.000000» обозначают одно значение, и без канонизации
  // одна сделка, пришедшая дважды с разным форматированием,
  // создала бы две записи — а с ними удвоенный объём позиции.
  return [
    t.chain,
    t.wallet,
    t.tokenAddress,
    t.side,
    Math.trunc(t.tradedAt),
    canonicalDecimal(t.amount),
    canonicalDecimal(t.valueUsd),
    canonicalDecimal(t.price),
  ].join('|');
}

/** Разбор страницы истории. */
export function parseHistoryPage(
  raw: unknown,
  ctx: { chain: ChainKey; wallet: string },
): HistoryPage {
  const skipped: Record<string, number> = {};
  const skip = (why: string) => {
    skipped[why] = (skipped[why] ?? 0) + 1;
  };

  const page = Array.isArray(raw) ? raw[0] : raw;
  if (page == null || typeof page !== 'object') {
    return { trades: [], cursor: null, skipped: { malformed: 1 } };
  }

  const p = page as Record<string, unknown>;
  const rows = Array.isArray(p.transactionList) ? p.transactionList : [];

  const wallet = normalizeAddress(ctx.chain, ctx.wallet);
  const trades: CanonicalTrade[] = [];

  for (const row of rows) {
    if (row == null || typeof row !== 'object') {
      skip('malformed_row');
      continue;
    }

    const r = row as Record<string, unknown>;
    const type = okxStr(r.type, 4);

    if (!isLedgerType(type)) {
      // Переводы считаются отдельно и в расчёт позиций не идут.
      skip(type === '3' || type === '4' ? 'transfer' : 'unknown_type');
      continue;
    }

    const token = okxStr(r.tokenContractAddress, 128);
    const tradedAt = okxMillis(r.time);

    if (!token || tradedAt == null) {
      skip('missing_key_fields');
      continue;
    }

    // Числа берутся как строки: приведение к double здесь потеряло бы
    // точность на количествах с восемнадцатью знаками.
    const amount = okxStr(r.amount, 64);
    const valueUsd = okxStr(r.valueUsd, 64);
    const price = okxStr(r.price, 64);

    if (!amount || !valueUsd || !price) {
      // Без точного количества сделка в расчёт не идёт. Подставлять
      // приблизительное значение нельзя — это и есть та ошибка,
      // ради устранения которой существует этот модуль.
      skip('missing_amounts');
      continue;
    }

    const normToken = normalizeAddress(ctx.chain, token);
    const side: 'BUY' | 'SELL' = type === DEX_HISTORY_TYPE.buy ? 'BUY' : 'SELL';

    trades.push({
      key: canonicalKey({
        chain: ctx.chain,
        wallet,
        tokenAddress: normToken,
        side,
        tradedAt,
        amount,
        valueUsd,
        price,
      }),
      chain: ctx.chain,
      wallet,
      tokenAddress: normToken,
      tokenSymbol: okxStr(r.tokenSymbol, 32),
      side,
      amount,
      valueUsd,
      price,
      marketCapUsd: okxStr(r.marketCap, 64),
      providerPnlUsd: okxStr(r.pnlUsd, 64),
      tradedAt,
    });
  }

  return {
    trades,
    // Курсор непрозрачен: разбирать его нельзя, только передавать
    // обратно как есть.
    cursor: okxStr(p.cursor, 256),
    skipped,
  };
}

/**
 * Упорядочивание перед пересчётом позиции.
 *
 * Сортировка по времени, а при совпадении — по ключу. Второе условие
 * обязательно: две сделки в одном блоке имеют одинаковое время,
 * и без устойчивого порядка пересчёт давал бы разный результат
 * при разном порядке получения. А он должен давать один и тот же
 * всегда — иначе средняя себестоимость зависела бы от того,
 * в каком порядке пришли страницы истории.
 */
export function sortForLedger(trades: CanonicalTrade[]): CanonicalTrade[] {
  return [...trades].sort((a, b) => {
    if (a.tradedAt !== b.tradedAt) return a.tradedAt - b.tradedAt;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

/** Убрать повторы по ключу, сохранив порядок. */
export function dedupeCanonical(trades: CanonicalTrade[]): CanonicalTrade[] {
  const seen = new Set<string>();
  const out: CanonicalTrade[] = [];

  for (const t of trades) {
    if (seen.has(t.key)) continue;
    seen.add(t.key);
    out.push(t);
  }

  return out;
}
