/**
 * Кого проверять следующим.
 *
 * Очередь была одна и работала по одному правилу: версия правил,
 * потом время проверки, потом оборот. Правило разумное, но у него нет
 * понятия срочности, и от этого страдал ровно тот случай, который
 * человек видит: он открыл карточку токена, а очередь дойдёт до него
 * через два часа, потому что впереди полторы тысячи записей.
 *
 * Здесь только политика: никаких запросов, никакой базы, никаких
 * таймеров. Это позволяет проверить обещания очереди — что открытый
 * токен идёт первым, что старые не голодают, что упавшая проверка
 * не крутится по кругу — без сети и без ожиданий.
 */

// ───────────────────────────── Приоритеты ───────────────────────────────────

/**
 * Очередь по срочности, а не по одному признаку.
 *
 * Порядок отражает, кто ждёт ответа. Первым — человек, который прямо
 * сейчас смотрит на экран; последним — плановая перепроверка, которой
 * никто не ждёт.
 */
export const CHECK_PRIORITIES = [
  /** Кто-то открыл карточку токена. Ждёт ответа сию секунду. */
  'opened',
  /** Свежая находка радара или DexScreener. Показывать нечего, пока не проверим. */
  'discovered',
  /** Проверен по устаревшим правилам. Новое правило до него не дошло. */
  'outdated-rules',
  /** Вердикт протух. */
  'stale',
  /** Плановая перепроверка. */
  'routine',
] as const;

export type CheckPriority = (typeof CHECK_PRIORITIES)[number];

const PRIORITY_ORDER: Record<CheckPriority, number> = {
  opened: 0,
  discovered: 1,
  'outdated-rules': 2,
  stale: 3,
  routine: 4,
};

export interface QueueCandidate {
  id: string;
  priority: CheckPriority;
  /** Когда проверяли в прошлый раз. null — никогда. */
  checkedAt: number | null;
  /** Неудачных попыток подряд. */
  attempts: number;
  /** Раньше этого времени повторять нет смысла. null — можно сейчас. */
  nextAttemptAt: number | null;
  /** Оборот за сутки. Разрешает ничью внутри одного приоритета. */
  volume24hUsd: number | null;
}

// ──────────────────────────── Повторные попытки ─────────────────────────────

export interface BackoffConfig {
  baseMs: number;
  maxMs: number;
  /** Доля случайного разброса: 0.5 означает от половины до полного. */
  jitter: number;
  /** После скольких неудач подряд перестать пытаться. */
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  // Полминуты: провайдер, отдавший 429, за меньшее время не остынет.
  baseMs: 30_000,
  // Полчаса. Дальше растить бессмысленно — плановая перепроверка
  // всё равно наступит раньше.
  maxMs: 30 * 60_000,
  jitter: 0.5,
  /*
   * Защита от бесконечного круга.
   *
   * Токен, который стабильно роняет проверку, обязан перестать
   * занимать место: иначе пять таких записей выедают всю пропускную
   * способность, а очередь снаружи выглядит работающей.
   *
   * Отказ не окончательный — смена версии правил или ручной запрос
   * счётчик обнуляют.
   */
  maxAttempts: 6,
};

/**
 * Задержка перед следующей попыткой.
 *
 * Экспонента с разбросом. Разброс обязателен: без него сотня токенов,
 * упавших на одном таймауте провайдера, повторит запрос в одну
 * и ту же миллисекунду и уронит его снова — уже своими силами.
 *
 * `random` передаётся снаружи, чтобы тест проверял границы, а не
 * ловил их вероятностью.
 */
export function backoffDelayMs(
  attempt: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (attempt <= 0) return 0;

  const exponential = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (attempt - 1));

  // От (1 − jitter) до 1 от расчётной задержки. Уменьшаем, а не
  // увеличиваем: превышать собственный потолок нехорошо.
  const factor = 1 - cfg.jitter * random();
  return Math.round(exponential * factor);
}

/** Исчерпаны ли попытки. */
export function retriesExhausted(attempts: number, cfg: BackoffConfig = DEFAULT_BACKOFF): boolean {
  return attempts >= cfg.maxAttempts;
}

// ─────────────────────────────── Отбор пачки ────────────────────────────────

export interface NextBatchOptions {
  now: number;
  limit: number;
  backoff?: BackoffConfig;
  /**
   * Сколько мест в пачке отдать самым старым записям.
   *
   * Без этой доли очередь голодает: пока приходят открытые карточки
   * и свежие находки, до плановой перепроверки очередь не доходит
   * никогда, и витрина тихо устаревает целиком.
   */
  fairShare?: number;
}

/** Доля мест, зарезервированная за старейшими. */
export const DEFAULT_FAIR_SHARE = 0.25;

/**
 * Следующая пачка.
 *
 * Три обязательных свойства, и каждое из них когда-то отсутствовало
 * в очередях, устроенных «просто по приоритету»:
 *
 *   1. Дедупликация. Один и тот же токен, открытый тремя людьми, —
 *      это одна проверка, а не три.
 *   2. Уважение к задержке повтора. Токен, упавший минуту назад,
 *      в пачку не попадает, сколько бы у него ни было приоритета.
 *   3. Честная доля старым. Иначе плановая перепроверка не случается
 *      никогда.
 */
export function nextBatch(
  candidates: QueueCandidate[],
  opts: NextBatchOptions,
): QueueCandidate[] {
  const backoff = opts.backoff ?? DEFAULT_BACKOFF;
  const fairShare = opts.fairShare ?? DEFAULT_FAIR_SHARE;

  if (opts.limit <= 0) return [];

  // ─── Кого вообще можно брать ────────────────────────────────────
  const byId = new Map<string, QueueCandidate>();

  for (const c of candidates) {
    if (retriesExhausted(c.attempts, backoff)) continue;
    if (c.nextAttemptAt != null && c.nextAttemptAt > opts.now) continue;

    // Дубликат: остаётся самый срочный.
    const prev = byId.get(c.id);
    if (prev == null || PRIORITY_ORDER[c.priority] < PRIORITY_ORDER[prev.priority]) {
      byId.set(c.id, c);
    }
  }

  const eligible = [...byId.values()];
  if (eligible.length === 0) return [];

  /** Внутри одного приоритета: сначала ни разу не проверенные, потом старейшие. */
  const byAge = (a: QueueCandidate, b: QueueCandidate) => {
    if (a.checkedAt == null && b.checkedAt !== null) return -1;
    if (b.checkedAt == null && a.checkedAt !== null) return 1;
    if (a.checkedAt !== b.checkedAt) return (a.checkedAt ?? 0) - (b.checkedAt ?? 0);
    return (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0);
  };

  const byUrgency = (a: QueueCandidate, b: QueueCandidate) => {
    const d = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    return d !== 0 ? d : byAge(a, b);
  };

  /*
   * Места делятся на две части.
   *
   * Срочная часть идёт по приоритету, честная — строго по возрасту,
   * не глядя на приоритет вовсе. Только так самый старый токен
   * попадает в проверку при постоянном потоке срочных.
   */
  const fairSlots = Math.min(
    eligible.length,
    Math.max(0, Math.floor(opts.limit * fairShare)),
  );
  const urgentSlots = opts.limit - fairSlots;

  const picked = new Map<string, QueueCandidate>();

  for (const c of [...eligible].sort(byUrgency).slice(0, urgentSlots)) {
    picked.set(c.id, c);
  }

  for (const c of [...eligible].sort(byAge)) {
    if (picked.size >= opts.limit) break;
    picked.set(c.id, c);
  }

  // Порядок выдачи — по срочности: если бюджет прохода выйдет
  // на середине, недоделанным окажется наименее срочное.
  return [...picked.values()].sort(byUrgency);
}

// ─────────────────────────── Итог одной попытки ─────────────────────────────

export interface AttemptOutcome {
  /** Проверка прошла и дала вердикт. */
  ok: boolean;
  /** Причина неудачи — недоступность источников, а не свойство токена. */
  providerError?: boolean;
}

export interface AttemptState {
  attempts: number;
  nextAttemptAt: number | null;
}

/**
 * Новое состояние попыток.
 *
 * Успех обнуляет счётчик. Это важнее, чем кажется: без обнуления
 * токен, упавший пять раз за месяц и с тех пор проверяющийся
 * нормально, однажды упрётся в предел и выпадет из очереди навсегда.
 */
export function nextAttemptState(
  current: AttemptState,
  outcome: AttemptOutcome,
  now: number,
  cfg: BackoffConfig = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): AttemptState {
  if (outcome.ok) return { attempts: 0, nextAttemptAt: null };

  const attempts = current.attempts + 1;

  if (retriesExhausted(attempts, cfg)) {
    // Больше не пытаемся до смены версии правил или ручного запроса.
    return { attempts, nextAttemptAt: null };
  }

  return { attempts, nextAttemptAt: now + backoffDelayMs(attempts, cfg, random) };
}
