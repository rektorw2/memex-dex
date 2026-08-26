/**
 * Помещается ли число в колонку базы.
 *
 * Postgres не обрезает переполнение, а отвергает запись целиком:
 * `numeric field overflow`. Одно поле, вышедшее за границу, роняет
 * весь `update`, и вместе с ним теряются все остальные поля токена —
 * цена, ликвидность, объём. Токен перестаёт обновляться вовсе, а
 * в журнале видно только ошибку про «precision 12, scale 4», по
 * которой не понять, какое поле виновато.
 *
 * Особенно это касается меметокенов. Изменение цены за сутки у них
 * не ограничено ничем: токен, стоивший 10⁻¹⁵, при выходе на бирже
 * даёт рост в сотни миллионов процентов. Число настоящее, но в
 * колонку `Decimal(12, 4)` оно не влезает.
 *
 * Правило здесь одно и оно неочевидное: непомещающееся значение
 * становится null, а не обрезается до максимума. Обрезание записало
 * бы 99 999 999,9999 % — число, которого не было, и отличить его
 * от настоящего потом нечем. null означает «не знаем», и это
 * правда: представить это значение в имеющейся колонке мы не можем.
 */

/** Границы, встречающиеся в схеме. Имена по смыслу, а не по цифрам. */
export const DECIMAL_COLUMN = {
  /** priceChange24h, poolAgeHours, кратности. */
  percent: { precision: 12, scale: 4 },
  /** lpBurnedPct, topHolderPct — доли от нуля до ста. */
  share: { precision: 8, scale: 4 },
  /** Денежные величины. */
  money: { precision: 24, scale: 8 },
} as const;

/**
 * Помещается ли число в numeric(precision, scale).
 *
 * Проверка идёт после округления до нужного числа знаков — именно
 * так поступает Postgres, и значение 99 999 999,99996 округляется
 * им до 100 000 000, то есть до переполнения. Проверять до
 * округления значило бы пропустить ровно пограничный случай.
 */
export function fitsDecimal(value: number, precision: number, scale: number): boolean {
  if (!Number.isFinite(value)) return false;

  const limit = 10 ** (precision - scale);
  const rounded = Math.round(value * 10 ** scale) / 10 ** scale;

  return Math.abs(rounded) < limit;
}

/**
 * Значение, пригодное для записи, либо null.
 *
 * Ни исключения, ни обрезания: вызывающий получает либо число,
 * которое точно запишется, либо честное «неизвестно».
 */
export function decimalOrNull(
  value: number | null | undefined,
  column: { precision: number; scale: number },
): number | null {
  if (value == null) return null;
  return fitsDecimal(value, column.precision, column.scale) ? value : null;
}

/**
 * Изменение цены за сутки, пригодное для записи.
 *
 * Отдельная обёртка, потому что это самое частое место переполнения
 * во всём проекте: у свежего меметокена рост измеряется не десятками
 * процентов, а порядками.
 */
export function priceChangeOrNull(value: number | null | undefined): number | null {
  return decimalOrNull(value, DECIMAL_COLUMN.percent);
}

/**
 * Доля в процентах от нуля до ста.
 *
 * Значение вне этого диапазона — не «большая доля», а признак того,
 * что провайдер прислал базисные пункты или долю единицы вместо
 * процентов. Записывать его нельзя ни в каком виде: 10 000 в колонке
 * «процент сожжённой ликвидности» будет прочитано как полная
 * безопасность.
 */
export function sharePctOrNull(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return decimalOrNull(value, DECIMAL_COLUMN.share);
}

// ───────────────────── Экономическая сделка кошелька ────────────────────────

/**
 * Колонки `WalletEconomicTrade`.
 *
 * Значения приходят от провайдера строками и раньше оборачивались
 * в `Decimal` напрямую. `Decimal` границ колонки не знает — их знает
 * только Postgres, и узнаёт о нарушении он в момент записи:
 *
 *     22003: numeric field overflow
 *     A field with precision 40, scale 18 must round to an absolute
 *     value less than 10^22
 *
 * Падала при этом вся вставка, а вместе с ней прерывался обход
 * кошелька: одна битая строка провайдера стоила всех остальных.
 */
export const TRADE_COLUMN = {
  /** `amount` — количество токена. */
  amount: { precision: 40, scale: 18 },
  /** `valueUsd`, `marketCapUsd`, `providerPnlUsd`. */
  money: { precision: 30, scale: 10 },
  /** `price` — цена за единицу. */
  price: { precision: 40, scale: 20 },
} as const;

/** Почему сделка отклонена. Код, а не текст: он уходит в счётчик. */
export type TradeFitReason =
  | 'AMOUNT_OUT_OF_RANGE'
  | 'VALUE_OUT_OF_RANGE'
  | 'PRICE_OUT_OF_RANGE'
  | 'AMOUNT_NOT_A_NUMBER'
  | 'VALUE_NOT_A_NUMBER'
  | 'PRICE_NOT_A_NUMBER';

export interface TradeFitResult {
  /** Сделку можно записывать. */
  ok: boolean;
  /** Код причины отказа. Заполнен только при `ok === false`. */
  reason: TradeFitReason | null;
  /**
   * Необязательные поля, которые не поместились и станут `null`.
   *
   * Политика здесь другая, чем у обязательных, и это осознанно.
   * Капитализация и PnL провайдера — сведения о сделке, а не сама
   * сделка: без них строка остаётся верной, а `null` дальше по цепочке
   * честно читается как «база неизвестна» и выводит исход из оценки.
   * Отбрасывать из-за них всю сделку значило бы терять факт покупки
   * ради необязательной подробности.
   */
  droppedOptional: string[];
}

/**
 * Число из строки провайдера.
 *
 * Пустое и нечисловое — не ноль, а `null`.
 *
 * Ограничение, о котором надо знать: `Number` хранит около семнадцати
 * значащих цифр, а колонка `numeric(40, 18)` допускает двадцать две
 * до запятой. У самой границы проверка поэтому неточна и ошибается
 * в сторону отказа. Это безопасная сторона: Postgres на пределе тоже
 * откажет, а разница в одну единицу последнего разряда у величины
 * порядка 10^22 на решение о сделке не влияет.
 */
function numeric(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null;

  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Помещается ли сделка в колонки таблицы.
 *
 * ─── Чего здесь нет ─────────────────────────────────────────────────
 *
 * Обрезания до максимума. Записать вместо непомещающегося количества
 * `10^22 - 1` значит придумать финансовую величину, которой не было,
 * и отличить её потом от настоящей будет нечем. Отказ честнее.
 *
 * Экспоненциальная запись, `NaN` и `Infinity` тоже сюда попадают:
 * провайдер присылает строки, и `"1e300"` внешне ничем не отличается
 * от нормального числа.
 */
export function fitEconomicTrade(trade: {
  amount: string | number | null | undefined;
  valueUsd: string | number | null | undefined;
  price: string | number | null | undefined;
  marketCapUsd?: string | number | null;
  providerPnlUsd?: string | number | null;
}): TradeFitResult {
  const droppedOptional: string[] = [];

  const required = [
    ['amount', trade.amount, TRADE_COLUMN.amount, 'AMOUNT'],
    ['valueUsd', trade.valueUsd, TRADE_COLUMN.money, 'VALUE'],
    ['price', trade.price, TRADE_COLUMN.price, 'PRICE'],
  ] as const;

  for (const [, raw, column, prefix] of required) {
    const value = numeric(raw);

    // Отсутствующее обязательное поле — это не переполнение,
    // и различать их в счётчике полезно: первое означает пробел
    // у провайдера, второе — величину вне нашей схемы.
    if (value == null) {
      return {
        ok: false,
        reason: `${prefix}_NOT_A_NUMBER` as TradeFitReason,
        droppedOptional,
      };
    }

    if (!fitsDecimal(value, column.precision, column.scale)) {
      return {
        ok: false,
        reason: `${prefix}_OUT_OF_RANGE` as TradeFitReason,
        droppedOptional,
      };
    }
  }

  for (const [name, raw] of [
    ['marketCapUsd', trade.marketCapUsd],
    ['providerPnlUsd', trade.providerPnlUsd],
  ] as const) {
    if (raw == null || raw === '') continue;

    const value = numeric(raw);

    if (value == null || !fitsDecimal(value, TRADE_COLUMN.money.precision, TRADE_COLUMN.money.scale)) {
      droppedOptional.push(name);
    }
  }

  return { ok: true, reason: null, droppedOptional };
}
