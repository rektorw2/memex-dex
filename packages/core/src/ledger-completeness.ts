/**
 * Полнота истории и позиции, которым нельзя верить.
 *
 * История DEX отдаёт не больше тысячи записей и в обратном порядке —
 * от свежих к старым. Для активного кошелька это означает, что самая
 * ранняя покупка может остаться за пределами окна, и мы увидим
 * продажу токена, покупки которого не видели.
 *
 * Такая продажа — ловушка. Без известной себестоимости её легко
 * посчитать прибылью целиком: продал на тысячу, вложил ноль, значит
 * заработал тысячу. Кошелёк с обрезанной историей превращается
 * в гения, причём тем увереннее, чем длиннее его история — то есть
 * ровно наоборот тому, как должно быть.
 *
 * Поэтому здесь два понятия.
 *
 * Осиротевшая продажа — продажа без предшествующей покупки в известном
 * окне. Она не считается ни выигрышем, ни проигрышем и не участвует
 * в оценке вовсе.
 *
 * Обрезанная история — признак того, что окно упёрлось в потолок
 * провайдера. При нём нельзя утверждать, что позиции полны, даже
 * если осиротевших продаж не нашлось: следующая страница могла бы
 * их добавить.
 */

import type { CanonicalTrade } from './okx-dex-history.js';

export type HistoryStatus =
  | 'complete'
  | 'partial'
  | 'truncated'
  | 'provider_lag'
  | 'failed';

/** Потолок записей у провайдера. Больше он не отдаёт при любых запросах. */
export const PROVIDER_MAX_RECORDS = 1000;

export interface HistoryCoverage {
  status: HistoryStatus;
  recordsFetched: number;
  pagesFetched: number;
  /** Упёрлись в потолок провайдера. */
  maxRowsReached: boolean;
  /** Курсор исчерпан — история закончилась естественно. */
  cursorExhausted: boolean;
  earliestSyncedAt: number | null;
  latestSyncedAt: number | null;
  reason: string | null;
}

export interface CoverageInput {
  trades: CanonicalTrade[];
  pagesFetched: number;
  cursorExhausted: boolean;
  /** Достигнут внутренний предел страниц. */
  pageLimitReached: boolean;
  /** Курсор повторился — провайдер зациклился. */
  cursorRepeated?: boolean;
  /** Запрос оборвался ошибкой. */
  failed?: boolean;
  /** Нижняя граница запрошенного окна. */
  requestedBegin?: number | null;
}

/**
 * Оценка полноты выгрузки.
 *
 * Порядок проверок — от самого определённого к самому мягкому:
 * сбой важнее обрезания, обрезание важнее неполноты.
 */
export function assessCoverage(input: CoverageInput): HistoryCoverage {
  const times = input.trades.map((t) => t.tradedAt);

  const base = {
    recordsFetched: input.trades.length,
    pagesFetched: input.pagesFetched,
    maxRowsReached: input.trades.length >= PROVIDER_MAX_RECORDS,
    cursorExhausted: input.cursorExhausted,
    earliestSyncedAt: times.length > 0 ? Math.min(...times) : null,
    latestSyncedAt: times.length > 0 ? Math.max(...times) : null,
  };

  if (input.failed) {
    return { ...base, status: 'failed', reason: 'Запрос истории прервался ошибкой' };
  }

  if (input.cursorRepeated) {
    return {
      ...base,
      status: 'truncated',
      reason: 'Провайдер повторил курсор — дальше страницы не отдаёт',
    };
  }

  if (base.maxRowsReached && !input.cursorExhausted) {
    return {
      ...base,
      status: 'truncated',
      reason: `Достигнут потолок в ${PROVIDER_MAX_RECORDS} записей, история продолжается`,
    };
  }

  if (input.pageLimitReached && !input.cursorExhausted) {
    return {
      ...base,
      status: 'truncated',
      reason: 'Достигнут внутренний предел страниц',
    };
  }

  // Курсор не исчерпан и потолок не достигнут — выгрузка оборвалась
  // на полпути по другой причине.
  if (!input.cursorExhausted) {
    return { ...base, status: 'partial', reason: 'Выгрузка не дошла до конца истории' };
  }

  return { ...base, status: 'complete', reason: null };
}

// ─────────────────────── Осиротевшие продажи ────────────────────────────────

export interface TokenCompleteness {
  tokenAddress: string;
  /** Есть продажи без предшествующих покупок в известном окне. */
  hasOrphanSell: boolean;
  /** Себестоимость неизвестна — позиция в оценку не идёт. */
  incompleteCostBasis: boolean;
  /** Сколько токена продано сверх известных покупок. */
  unexplainedSoldAmount: string | null;
  reason: string | null;
}

/**
 * Проверка себестоимости по каждому токену.
 *
 * Считается по количеству, а не по числу сделок: продать половину
 * купленного — норма, продать больше, чем видели купленным, —
 * признак того, что часть покупок за пределами окна.
 *
 * Сравнение идёт в строках через сравнение по разрядам, а не через
 * число: количества с восемнадцатью знаками в double теряют точность,
 * и позиция, закрытая ровно в ноль, начинала бы выглядеть
 * незакрытой на пылинку.
 */
export function checkCompleteness(trades: CanonicalTrade[]): TokenCompleteness[] {
  const byToken = new Map<string, CanonicalTrade[]>();

  for (const t of trades) {
    const list = byToken.get(t.tokenAddress) ?? [];
    list.push(t);
    byToken.set(t.tokenAddress, list);
  }

  const out: TokenCompleteness[] = [];

  for (const [tokenAddress, list] of byToken) {
    const ordered = [...list].sort((a, b) => a.tradedAt - b.tradedAt);

    let bought = 0n;
    let sold = 0n;
    let orphan = false;

    for (const t of ordered) {
      const amount = toScaled(t.amount);

      if (t.side === 'BUY') {
        bought += amount;
        continue;
      }

      sold += amount;

      // Продажа раньше любой покупки либо сверх купленного.
      if (sold > bought) orphan = true;
    }

    const excess = sold > bought ? sold - bought : 0n;

    out.push({
      tokenAddress,
      hasOrphanSell: orphan,
      incompleteCostBasis: orphan,
      unexplainedSoldAmount: excess > 0n ? fromScaled(excess) : null,
      reason: orphan
        ? 'Продано больше, чем видели купленным — часть покупок вне доступной истории'
        : null,
    });
  }

  return out;
}

/**
 * Токены, пригодные для оценки.
 *
 * Позиция с неизвестной себестоимостью исключается целиком:
 * посчитать её частично нельзя — неизвестна именно цена входа,
 * то есть то, из чего складывается результат.
 */
export function scorableTokens(completeness: TokenCompleteness[]): Set<string> {
  return new Set(
    completeness.filter((c) => !c.incompleteCostBasis).map((c) => c.tokenAddress),
  );
}

/** Доля токенов с полной историей. Показывается в состоянии источника. */
export function coveragePercent(completeness: TokenCompleteness[]): number | null {
  if (completeness.length === 0) return null;
  const ok = completeness.filter((c) => !c.incompleteCostBasis).length;
  return Math.round((ok / completeness.length) * 100);
}

// ─────────────────── Канонизация десятичных чисел ───────────────────────────

/** Разрядов после запятой при сравнении количеств. */
const SCALE = 18;

/**
 * Строка в целое с фиксированной точностью.
 *
 * Через BigInt, а не через Number: количество токена с восемнадцатью
 * знаками в double округляется молча, и сравнение «продано столько же,
 * сколько куплено» начинает давать ложные расхождения.
 */
export function toScaled(value: string, scale = SCALE): bigint {
  const s = value.trim();
  if (!s) return 0n;

  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;

  const [whole = '0', frac = ''] = body.split('.');
  const padded = (frac + '0'.repeat(scale)).slice(0, scale);

  // Нечисловой мусор даёт ноль, а не исключение: одна кривая строка
  // не должна ронять пересчёт всего кошелька.
  if (!/^\d*$/.test(whole) || !/^\d*$/.test(padded)) return 0n;

  const result = BigInt(whole || '0') * 10n ** BigInt(scale) + BigInt(padded || '0');
  return negative ? -result : result;
}

export function fromScaled(value: bigint, scale = SCALE): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;

  const divisor = 10n ** BigInt(scale);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(scale, '0').replace(/0+$/, '');

  return `${negative ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/**
 * Единое представление числа для построения ключа.
 *
 * Строки «1», «1.0» и «1.000000» обозначают одно значение, и без
 * приведения к общему виду одна и та же сделка, пришедшая дважды
 * с разным форматированием, создала бы две записи — а вместе с ними
 * удвоенный объём позиции.
 */
export function canonicalDecimal(value: string): string {
  return fromScaled(toScaled(value));
}
