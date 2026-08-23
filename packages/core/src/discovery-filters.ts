/**
 * Правила витрины: что вообще может попасть в подборку.
 *
 * Два вопроса, оба стоят денег при неверном ответе.
 *
 * Ликвидность. Токен с пулом в полдоллара нельзя продать, и показывать
 * его в списке рядом с настоящими рынками значит предлагать ловушку.
 * Порог существовал в настройках, но применялся только к сортировкам
 * по изменению цены — остальные списки шли без него вовсе.
 *
 * Возраст. «Новые» должны означать новые рынки, а не свежий импорт
 * в нашу базу: старый токен, впервые увиденный сегодня, новым
 * не является. Разница не косметическая — на «новизну» покупают.
 */

// ────────────────────────────── Ликвидность ──────────────────────────────────

/**
 * Разбор ликвидности из того, что пришло из базы или от провайдера.
 *
 * Prisma отдаёт `Decimal` строкой, провайдер — числом или строкой,
 * а иногда не отдаёт ничего. Все три случая должны различаться,
 * и ни один не должен молча превратиться в ноль: ноль — это
 * утверждение «пул пуст», а не «мы не знаем».
 */
export function parseLiquidityUsd(raw: unknown): number | null {
  if (raw == null) return null;

  let value: number;

  if (typeof raw === 'number') {
    value = raw;
  } else {
    const text = String(raw).trim();

    // Пустая строка — отсутствие значения, а не ноль. `Number('')`
    // возвращает ноль, и без этой проверки пустая колонка читалась бы
    // как «пул пуст», то есть как знание вместо его отсутствия.
    if (text === '') return null;

    value = Number(text);
  }

  // NaN, Infinity и отрицательная ликвидность — испорченные данные.
  // Пропустить их значит пустить в витрину токен, о котором известно
  // только то, что о нём ничего не известно.
  if (!Number.isFinite(value) || value < 0) return null;

  return value;
}

/**
 * Проходит ли токен порог.
 *
 * Неизвестная ликвидность не проходит. Это может показаться строгим —
 * данные подтянутся позже, — но обратное умолчание означает, что
 * в списке окажется всё, о чём провайдер промолчал, а промолчит он
 * чаще всего именно о мусоре.
 */
export function passesLiquidityFloor(raw: unknown, floorUsd: number): boolean {
  const value = parseLiquidityUsd(raw);
  if (value == null) return false;

  return value >= floorUsd;
}

/**
 * Действующий порог для запроса.
 *
 * Клиент может попросить строже, но не мягче: параметр запроса —
 * это пожелание пользователя, а порог — правило платформы.
 *
 * Ноль от клиента раньше отключал фильтр целиком, потому что
 * проверялся на истинность. Ноль — это число, а не отсутствие
 * значения, и означает он «покажи всё», то есть ровно то, чего
 * делать нельзя.
 */
export function effectiveLiquidityFloor(
  requested: number | null | undefined,
  baseFloorUsd: number,
): number {
  if (requested == null || !Number.isFinite(requested)) return baseFloorUsd;

  return Math.max(requested, baseFloorUsd);
}

/**
 * Настройка порога осмысленна.
 *
 * Проверяется при старте: порог в ноль или отрицательный означает
 * витрину без фильтра, и узнать об этом из жалобы дороже, чем
 * из отказа подняться.
 */
export function isSaneLiquidityFloor(value: number): boolean {
  return Number.isFinite(value) && value >= 1;
}

// ──────────────────────────── Возраст рынка ──────────────────────────────────

/**
 * Откуда известен возраст.
 *
 * Различать источники обязательно: `imported` — это не возраст рынка,
 * а возраст нашей записи о нём, и выдавать одно за другое нельзя.
 */
export type MarketAgeSource = 'pool' | 'first-seen' | 'unknown';

export interface MarketAge {
  source: MarketAgeSource;
  /** Момент появления рынка. null — неизвестен. */
  at: number | null;
  ageMs: number | null;
}

export interface MarketAgeInput {
  /** Время создания пула по данным провайдера. Самый верный ответ. */
  poolCreatedAt?: Date | string | number | null;
  /** Когда мы впервые увидели токен на рынке. Приближение. */
  firstSeenAt?: Date | string | number | null;
}

function toMs(raw: Date | string | number | null | undefined): number | null {
  if (raw == null) return null;

  const ms = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Возраст рынка и то, откуда он известен.
 *
 * Порядок источников — от точного к приблизительному. Времени
 * создания записи в нашей базе среди них нет намеренно: оно отвечает
 * на другой вопрос.
 */
export function marketAge(input: MarketAgeInput, now = Date.now()): MarketAge {
  const pool = toMs(input.poolCreatedAt);
  if (pool != null) return { source: 'pool', at: pool, ageMs: Math.max(0, now - pool) };

  const seen = toMs(input.firstSeenAt);
  if (seen != null) return { source: 'first-seen', at: seen, ageMs: Math.max(0, now - seen) };

  return { source: 'unknown', at: null, ageMs: null };
}

/** Сколько живёт «новый» рынок по умолчанию. */
export const NEW_MARKET_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Считается ли рынок новым.
 *
 * Неизвестный возраст новым не считается. Смешать его с настоящими
 * новыми значит выдать за находку то, о чём нам ничего не известно, —
 * а «новое» на этом рынке читается как «успей первым».
 */
export function isNewMarket(
  age: MarketAge,
  maxAgeMs: number = NEW_MARKET_MAX_AGE_MS,
): boolean {
  if (age.ageMs == null) return false;

  return age.ageMs <= maxAgeMs;
}

/** Подпись возраста для интерфейса. Неизвестное названо неизвестным. */
export function marketAgeLabel(age: MarketAge): string {
  if (age.ageMs == null) return 'возраст неизвестен';

  const minutes = Math.floor(age.ageMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} мин`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч`;

  return `${Math.floor(hours / 24)} дн`;
}
