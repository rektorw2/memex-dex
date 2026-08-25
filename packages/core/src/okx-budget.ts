/**
 * Сколько квоты OKX уже потрачено и кого притормозить.
 *
 * ─── Зачем ──────────────────────────────────────────────────────────
 *
 * Месячная квота бесплатного плана — сто тысяч вызовов Basic и сто
 * тысяч Premium. Прежняя схема расходовала Premium быстрее, чем
 * квота восстанавливается: горячий цикл звал `price-info` раз
 * в секунду, холодный — дважды в тридцать секунд. Восемьдесят шесть
 * тысяч вызовов в сутки при открытой вкладке означают, что месячной
 * квоты хватает примерно на день.
 *
 * ─── Главное правило ────────────────────────────────────────────────
 *
 * Тормозить надо фон, а не человека. Когда квота на исходе, разница
 * между «график перестал обновляться» и «фоновая переоценка каталога
 * подождёт до завтра» — это вся разница между сломанным продуктом
 * и работающим. Поэтому у расхода есть источник, и резерв последних
 * процентов принадлежит только пользовательским действиям.
 *
 * ─── Чем это не является ────────────────────────────────────────────
 *
 * Официальным балансом. OKX не сообщает остаток через API; здесь
 * считаются наши собственные вызовы с момента последнего сброса.
 * Счётчик не видит вызовов другого процесса и обнуляется при
 * перезапуске, поэтому в диагностике он обязан быть подписан как
 * локальная оценка — иначе однажды по нему примут решение как
 * по факту.
 */

import type { OkxTier } from './okx-tiers.js';

/**
 * Кто именно тратит.
 *
 * Порядок в списке — порядок, в котором эти потребители отключаются
 * при приближении к пределу.
 */
export const OKX_CALL_PURPOSES = [
  /** Открытый график, открытая карточка. Человек смотрит прямо сейчас. */
  'hot-price',
  /** Лента OKX Signal: то, ради чего существует вкладка GEMS. */
  'signal',
  /** Свечи для открытого графика: человек ждёт их сейчас. */
  'candles',
  /**
   * Фоновая догрузка свечей по каталогу.
   *
   * Отделена от `candles` намеренно. Оба зовут один и тот же
   * endpoint, но один обслуживает открытый экран, а второй заполняет
   * историю впрок — и если не различать их, фоновый обход съедает
   * резерв, который берегли для человека.
   */
  'candles-backfill',
  /** Медленный круг цен по каталогу. */
  'cold-price',
  /** Расширенные метрики: ликвидность, капитализация, держатели. */
  'enrichment',
  /** Проверка риска. */
  'risk',
  /** Кошельки и лидерборды. */
  'wallets',
] as const;

export type OkxCallPurpose = (typeof OKX_CALL_PURPOSES)[number];

/**
 * Пользовательские потребители.
 *
 * Им принадлежит резерв. Всё остальное — фон: его задержка
 * незаметна, его остановка не ломает экран.
 */
export const USER_FACING_PURPOSES: ReadonlySet<OkxCallPurpose> = new Set([
  'hot-price',
  'signal',
  'candles',
]);

export function isUserFacing(purpose: OkxCallPurpose): boolean {
  return USER_FACING_PURPOSES.has(purpose);
}

// ──────────────────────────────── Пороги ────────────────────────────────────

export interface OkxBudgetThresholds {
  /** С этого расхода фон начинает работать реже. */
  warn: number;
  /** С этого расхода фон останавливается совсем. */
  reserve: number;
  /** Полная месячная квота. */
  quota: number;
}

/**
 * Пороги бесплатного плана.
 *
 * Резерв — десять тысяч вызовов Basic и пятнадцать тысяч Premium.
 * Это не круглые числа ради красоты: при пяти секундах на тик
 * открытого графика десять тысяч Basic — это около четырнадцати часов
 * непрерывного просмотра, то есть месяц дотягивается даже в худшем
 * случае, когда фон встал в первых числах.
 */
export const FREE_BUDGET: Readonly<Record<'basic' | 'premium', OkxBudgetThresholds>> = {
  basic: { warn: 80_000, reserve: 90_000, quota: 100_000 },
  premium: { warn: 75_000, reserve: 85_000, quota: 100_000 },
};

/**
 * Пороги для произвольной квоты.
 *
 * Доли те же, что у бесплатного плана: предупреждение на 80%
 * и резерв на 90% для Basic, 75% и 85% для Premium. Premium строже,
 * потому что он вдвое дороже сверх квоты и вчетверо меньше на платных
 * планах.
 */
export function budgetThresholds(tier: 'basic' | 'premium', quota: number): OkxBudgetThresholds {
  const [warnShare, reserveShare] = tier === 'basic' ? [0.8, 0.9] : [0.75, 0.85];

  return {
    warn: Math.floor(quota * warnShare),
    reserve: Math.floor(quota * reserveShare),
    quota,
  };
}

// ──────────────────────────────── Решение ───────────────────────────────────

export type BudgetDecision =
  /** Работаем как обычно. */
  | { allow: true; slow: false }
  /** Разрешено, но фон обязан замедлиться. */
  | { allow: true; slow: true }
  /** Отказано: остаток бережём для пользователя. */
  | { allow: false; slow: true; reason: 'reserve' | 'quota' };

/**
 * Можно ли сделать вызов.
 *
 * Три уровня вместо двух. Резкий переход от «всё можно» к «ничего
 * нельзя» означал бы, что квота кончается внезапно и целиком;
 * промежуточная ступень даёт фону возможность растянуть остаток
 * на весь месяц вместо того, чтобы упереться в стену.
 *
 * Свободные endpoint разрешены всегда: они не расходуют ничего,
 * и притормаживать их — значит ухудшать продукт без всякой экономии.
 */
export function budgetDecision(input: {
  tier: OkxTier;
  purpose: OkxCallPurpose;
  used: number;
  thresholds: OkxBudgetThresholds;
}): BudgetDecision {
  if (input.tier === 'free') return { allow: true, slow: false };

  const { used, thresholds } = input;
  const userFacing = isUserFacing(input.purpose);

  // Квота исчерпана полностью. Дальше каждый вызов стоит денег,
  // и молча тратить их нельзя даже ради человека: он не просил
  // платить, он просил показать цену.
  if (used >= thresholds.quota) {
    return { allow: false, slow: true, reason: 'quota' };
  }

  if (used >= thresholds.reserve) {
    // Резерв. Пользователь проходит, фон — нет.
    return userFacing
      ? { allow: true, slow: true }
      : { allow: false, slow: true, reason: 'reserve' };
  }

  if (used >= thresholds.warn) {
    // Предупреждение: фон работает, но реже.
    return { allow: true, slow: !userFacing };
  }

  return { allow: true, slow: false };
}

/**
 * Во сколько раз замедлить фоновый цикл.
 *
 * Множитель, а не новый интервал: вызывающий знает свой обычный ритм,
 * а здесь решается только «насколько тише».
 */
export function slowdownFactor(used: number, thresholds: OkxBudgetThresholds): number {
  if (used < thresholds.warn) return 1;
  if (used < thresholds.reserve) return 4;
  return 0; // Ноль означает «не запускать вовсе».
}

// ──────────────────────────────── Прогноз ───────────────────────────────────

export interface BudgetForecast {
  used: number;
  quota: number;
  /** Вызовов в сутки по нынешнему темпу. */
  perDay: number;
  /** Прогноз расхода за месяц по нынешнему темпу. */
  projectedMonthly: number;
  /** Хватит ли квоты до конца месяца. */
  withinQuota: boolean;
  /** Через сколько дней квота кончится. null — не кончится. */
  daysToExhaustion: number | null;
}

/**
 * Прогноз по наблюдаемому темпу.
 *
 * Считается от времени наблюдения, а не от начала месяца: счётчик
 * обнуляется при перезапуске, и делать вид, что он покрывает месяц,
 * значит занижать прогноз ровно тогда, когда он нужнее всего.
 */
export function forecastBudget(input: {
  used: number;
  quota: number;
  observedMs: number;
}): BudgetForecast {
  const DAY = 24 * 60 * 60 * 1000;

  // Слишком короткое наблюдение прогнозу не поддаётся: минута работы
  // после деплоя дала бы любое число.
  const measurable = input.observedMs >= 60_000;
  const perDay = measurable ? (input.used / input.observedMs) * DAY : 0;
  const projectedMonthly = Math.round(perDay * 30);

  const remaining = Math.max(0, input.quota - input.used);

  return {
    used: input.used,
    quota: input.quota,
    perDay: Math.round(perDay),
    projectedMonthly,
    withinQuota: projectedMonthly <= input.quota,
    daysToExhaustion: perDay > 0 ? Math.round((remaining / perDay) * 10) / 10 : null,
  };
}
