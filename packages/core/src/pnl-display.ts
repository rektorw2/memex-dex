/**
 * Как показывать результат сделки.
 *
 * Модуль появился из-за конкретной поломки: у покупки справа было
 * пустое место. Выглядело это как потерянные данные, хотя данных
 * там не было и быть не могло — у покупки нет зафиксированного
 * результата, пока не случилась продажа.
 *
 * Соблазн заполнить пустоту нулём очень велик и совершенно неверен.
 * «$0.00» читается как «сделка вышла в ноль», то есть как измеренный
 * результат. На деле это отсутствие измерения, и разница между
 * «результат ноль» и «результата ещё нет» для человека, принимающего
 * решение деньгами, решающая.
 *
 * Поэтому вместо числа и пустоты здесь состояние. Их пять, и каждое
 * означает свою причину:
 *
 *   available          — есть точная величина;
 *   open_position      — позиция открыта, фиксировать нечего;
 *   pending            — пересчёт ещё идёт;
 *   incomplete_history — покупка вне доступного окна истории;
 *   not_applicable     — показатель к этой строке неприменим.
 *
 * Отдельно `stale`: величина есть, но посчитана давно. Это не повод
 * её прятать, а повод пометить.
 *
 * Ни одно состояние не выводится из отсутствия числа. Отсутствие
 * числа — следствие, а не причина, и по нему нельзя отличить
 * «ещё считаем» от «истории не хватает».
 */

export type PnlState =
  | 'available'
  | 'open_position'
  | 'pending'
  | 'incomplete_history'
  | 'ambiguous'
  | 'stale'
  | 'not_applicable';

export interface PnlView {
  state: PnlState;
  /** Величина в долларах. Заполнена только при `available`. */
  valueUsd: number | null;
  /** Посчитано давно — величина верна на момент расчёта. */
  isStale: boolean;
  /** Знак: 1 — прибыль, -1 — убыток, 0 — ровно ноль. */
  sign: -1 | 0 | 1;
  /** Короткое пояснение для интерфейса. */
  label: string;
  /** Развёрнутое пояснение для подсказки. */
  hint: string;
}

/** Через сколько расчёт считается устаревшим. */
export const STALE_AFTER_MS = 15 * 60_000;

const HINTS = {
  realized: 'Реализованный PnL — результат завершённых продаж',
  unrealized: 'Нереализованный PnL — текущий результат открытой позиции',
  total: 'Общий PnL — сумма реализованного и нереализованного',
  open: 'Позиция ещё открыта: фиксировать нечего, пока токен не продан',
  pending:
    'Пересчёт ещё идёт: точное количество токена берётся из истории DEX, ' +
    'а она обновляется позже ленты',
  incomplete:
    'Недостаточно истории — покупка произошла раньше доступного периода, ' +
    'и себестоимость неизвестна',
  stale: 'Величина посчитана давно и могла измениться',
  stalePrice: 'Рыночная цена позиции устарела — live PnL временно не показывается',
  ambiguous: 'Несколько сделок подходят одинаково — выбрать одну без догадки нельзя',
} as const;

// ──────────────────────────── Построение вида ───────────────────────────────

export interface PnlInput {
  /** Величина. null означает «неизвестно», а не «ноль». */
  valueUsd: number | null | undefined;
  /** Событие ещё не перенесено в позиции. */
  isPending?: boolean;
  /** Себестоимость неизвестна: покупка вне окна истории. */
  hasIncompleteHistory?: boolean;
  /** Сделку нельзя однозначно сопоставить с канонической историей. */
  isAmbiguous?: boolean;
  /** Для открытой позиции есть только устаревшая рыночная цена. */
  isPriceStale?: boolean;
  /** Позиция открыта — для реализованного результата это норма. */
  isOpen?: boolean;
  /** Когда посчитано. */
  computedAt?: number | null;
  now?: number;
  kind?: 'realized' | 'unrealized' | 'total';
}

/**
 * Состояние показателя.
 *
 * Порядок проверок — от самой определённой причины к самой общей.
 * Неполная история важнее ожидания расчёта: пересчёт такой позиции
 * можно ждать сколько угодно, точнее она не станет.
 */
export function pnlView(input: PnlInput): PnlView {
  const kind = input.kind ?? 'realized';
  const now = input.now ?? Date.now();

  if (input.hasIncompleteHistory) {
    return {
      state: 'incomplete_history',
      valueUsd: null,
      isStale: false,
      sign: 0,
      label: 'Недостаточно истории',
      hint: HINTS.incomplete,
    };
  }

  if (input.isAmbiguous) {
    return {
      state: 'ambiguous',
      valueUsd: null,
      isStale: false,
      sign: 0,
      label: 'Неоднозначная сделка',
      hint: HINTS.ambiguous,
    };
  }

  if (input.isPriceStale) {
    return {
      state: 'stale',
      valueUsd: null,
      isStale: true,
      sign: 0,
      label: 'Цена устарела',
      hint: HINTS.stalePrice,
    };
  }

  if (input.isPending) {
    return {
      state: 'pending',
      valueUsd: null,
      isStale: false,
      sign: 0,
      label: 'PnL рассчитывается',
      hint: HINTS.pending,
    };
  }

  // Открытая позиция без величины — это не пропажа данных, а норма:
  // у покупки зафиксированного результата ещё нет.
  if (input.isOpen && !isUsable(input.valueUsd)) {
    return {
      state: 'open_position',
      valueUsd: null,
      isStale: false,
      sign: 0,
      label: 'Открытая позиция',
      hint: HINTS.open,
    };
  }

  if (!isUsable(input.valueUsd)) {
    return {
      state: 'not_applicable',
      valueUsd: null,
      isStale: false,
      sign: 0,
      label: '—',
      hint: 'Данных для этого показателя нет',
    };
  }

  const value = normalizeZero(input.valueUsd);

  return {
    state: 'available',
    valueUsd: value,
    isStale: input.computedAt != null && now - input.computedAt > STALE_AFTER_MS,
    sign: value > 0 ? 1 : value < 0 ? -1 : 0,
    label: formatSignedUsd(value),
    hint: kind === 'unrealized' ? HINTS.unrealized : kind === 'total' ? HINTS.total : HINTS.realized,
  };
}

/**
 * Годится ли величина к показу.
 *
 * NaN и бесконечность отсекаются здесь, а не при выводе: до строки
 * они доходят как «NaN» и «Infinity», и в столбце прибыли это
 * выглядит как сбой всего приложения.
 */
function isUsable(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Отрицательный ноль.
 *
 * `-0` в JavaScript существует и печатается как «−$0.00» — убыток
 * величиной ноль. Возникает он от округления мелкого минуса
 * и означает не убыток, а его отсутствие.
 */
function normalizeZero(value: number): number {
  return value === 0 ? 0 : value;
}

// ──────────────────────────── Общий результат ───────────────────────────────

/**
 * Сумма реализованного и нереализованного.
 *
 * Складывается, только когда обе части достоверны. Сложить известное
 * с неизвестным, подставив вместо второго ноль, значит выдать половину
 * ответа за целый — а решение по нему принимают такое же, как по
 * полному.
 */
export function totalPnl(realized: PnlView, unrealized: PnlView, now = Date.now()): PnlView {
  if (realized.state === 'incomplete_history' || unrealized.state === 'incomplete_history') {
    return pnlView({ valueUsd: null, hasIncompleteHistory: true, kind: 'total', now });
  }

  if (realized.state === 'pending' || unrealized.state === 'pending') {
    return pnlView({ valueUsd: null, isPending: true, kind: 'total', now });
  }

  if (realized.state !== 'available' || unrealized.state !== 'available') {
    return pnlView({ valueUsd: null, kind: 'total', now });
  }

  const sum = pnlView({
    valueUsd: realized.valueUsd! + unrealized.valueUsd!,
    kind: 'total',
    now,
  });

  // Сумма настолько же свежа, насколько устарела её худшая часть:
  // общий результат, собранный из вчерашнего и сегодняшнего, — это
  // вчерашний результат.
  return { ...sum, isStale: realized.isStale || unrealized.isStale };
}

// ───────────────────────────── Форматирование ───────────────────────────────

/** Порог, ниже которого сумма не отображается точной цифрой. */
export const CENT = 0.01;

/**
 * Сумма со знаком.
 *
 * Знак минуса — типографский (−), а не дефис: в моноширинном наборе
 * дефис визуально теряется рядом с цифрами, а спутать прибыль
 * с убытком здесь дороже всего.
 */
export function formatSignedUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';

  const abs = Math.abs(value);

  // Ноль без знака: «+$0.00» и «−$0.00» одинаково бессмысленны.
  if (abs === 0) return '$0.00';

  // Меньше цента — не «$0.00»: округление до нуля превращает
  // микроскопическую прибыль в её отсутствие.
  if (abs < CENT) return `${value > 0 ? '+' : '−'}<$0.01`;

  return `${value > 0 ? '+' : '−'}${formatUsdMagnitude(abs)}`;
}

/**
 * Величина без знака, компактно.
 *
 * Научная запись запрещена: «1.2e+7» в колонке прибыли не читается
 * человеком вовсе.
 */
export function formatUsdMagnitude(abs: number): string {
  if (!Number.isFinite(abs)) return '—';

  if (abs >= 1e9) return `$${trim(abs / 1e9)}B`;
  if (abs >= 1e6) return `$${trim(abs / 1e6)}M`;
  if (abs >= 1e3) return `$${trim(abs / 1e3)}K`;

  return `$${abs.toFixed(2)}`;
}

function trim(value: number): string {
  // Один знак после запятой у крупных величин: второй ничего
  // не уточняет, а ширину колонки увеличивает.
  return value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
}

/** Полная величина для подсказки. Округление только до цента. */
export function formatExactUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';

  const sign = value < 0 ? '−' : value > 0 ? '+' : '';
  const abs = Math.abs(value);

  return `${sign}$${abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Доходность в процентах.
 *
 * Считается только от известной себестоимости. Процент от нуля или
 * от неизвестного вложения — это не «бесконечная доходность», а
 * отсутствие ответа.
 */
export function roiPercent(pnlUsd: number | null, investedUsd: number | null): number | null {
  if (pnlUsd == null || investedUsd == null) return null;
  if (!Number.isFinite(pnlUsd) || !Number.isFinite(investedUsd)) return null;
  if (investedUsd <= 0) return null;

  return (pnlUsd / investedUsd) * 100;
}
