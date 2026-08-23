/**
 * Чем закончился проход к внешнему провайдеру.
 *
 * ─── Зачем понадобилось ─────────────────────────────────────────────
 *
 * Воркер цен считал проход успешным всегда. Каждый запрос был обёрнут
 * в `.catch(() => null)`, и полный отказ провайдера выглядел ровно как
 * успешный проход, в котором цен не нашлось: счётчик неудач сбрасывался,
 * отступ не включался никогда, и мы продолжали стучаться в отказавший
 * источник каждые тридцать секунд — то есть продлевали отказ своими
 * руками.
 *
 * ─── Что здесь есть ─────────────────────────────────────────────────
 *
 * Только структура отчёта и решение по нему. Ни сети, ни таймеров,
 * ни ожиданий: решение «пора отступить» обязано проверяться
 * мгновенно и детерминированно, иначе такой тест никто не напишет.
 *
 * Главное различение — между отсутствием котировки у одного токена
 * и отказом провайдера. Первое нормально: у половины мем-коинов нет
 * цены ни у кого. Второе означает, что дальнейшие запросы бессмысленны
 * и вредны.
 */

export interface ProviderReport {
  /** Сколько котировок запрашивали. */
  requested: number;
  /** Сколько получили. */
  fetched: number;
  /**
   * Источник ответил, но цены у него нет.
   *
   * Это сведения, а не сбой, и в отступ такое не складывается:
   * иначе пачка мёртвых токенов останавливала бы обновление живых.
   */
  missing: number;
  /** Временный сбой: таймаут, пятисотая, разорванное соединение. */
  transient: number;
  /** Провайдер прямо сказал «слишком часто». */
  rateLimited: number;
  /**
   * Сколько провайдер просил подождать, если сказал.
   *
   * Его число важнее нашего расчёта: мы гадаем, он знает.
   */
  retryAfterMs: number | null;
}

export const EMPTY_PROVIDER_REPORT: ProviderReport = {
  requested: 0,
  fetched: 0,
  missing: 0,
  transient: 0,
  rateLimited: 0,
  retryAfterMs: null,
};

/** Сложить отчёты нескольких источников в один. */
export function mergeReports(...reports: ProviderReport[]): ProviderReport {
  return reports.reduce<ProviderReport>(
    (acc, r) => ({
      requested: acc.requested + r.requested,
      fetched: acc.fetched + r.fetched,
      missing: acc.missing + r.missing,
      transient: acc.transient + r.transient,
      rateLimited: acc.rateLimited + r.rateLimited,
      // Берём наибольшую просьбу подождать: меньшая её не отменяет.
      retryAfterMs:
        r.retryAfterMs == null
          ? acc.retryAfterMs
          : Math.max(acc.retryAfterMs ?? 0, r.retryAfterMs),
    }),
    { ...EMPTY_PROVIDER_REPORT },
  );
}

/**
 * Какая доля неудач считается отказом провайдера.
 *
 * Половина. Ниже — отдельные токены, к которым не достучались,
 * и останавливать из-за них обновление остальных нельзя. Выше —
 * проблема на стороне источника, и следующий залп только усугубит.
 */
export const MASS_FAILURE_RATIO = 0.5;

export type CycleVerdict =
  | { kind: 'ok' }
  | {
      kind: 'backoff';
      reason: 'rate-limit' | 'provider-down';
      delayMs: number;
      /** Пауза назначена провайдером, а не нашим расчётом. */
      honoredRetryAfter: boolean;
    };

export interface CycleBackoffConfig {
  baseMs: number;
  maxMs: number;
  jitter: number;
}

export const DEFAULT_CYCLE_BACKOFF: CycleBackoffConfig = {
  baseMs: 30_000,
  // Пять минут. Дальше растить нельзя: пауза не должна превращаться
  // в остановку — цены нужны и после отказа провайдера.
  maxMs: 5 * 60_000,
  jitter: 0.5,
};

/**
 * Экспонента с разбросом.
 *
 * Разброс уменьшает задержку, а не увеличивает: превышать собственный
 * потолок нехорошо. Без разброса несколько экземпляров воркера
 * синхронизируются и бьют по провайдеру одним залпом.
 */
export function cycleDelayMs(
  failures: number,
  cfg: CycleBackoffConfig = DEFAULT_CYCLE_BACKOFF,
  random: () => number = Math.random,
): number {
  if (failures <= 0) return 0;

  const exponential = Math.min(cfg.maxMs, cfg.baseMs * 2 ** (failures - 1));
  return Math.round(exponential * (1 - cfg.jitter * random()));
}

/**
 * Отступать ли после этого прохода.
 *
 * Порядок проверок отражает, чьё слово весомее.
 *
 * Прямой отказ по частоте идёт первым и всегда: провайдер сказал
 * «слишком часто», и спорить с этим нечем. Его собственная просьба
 * подождать перекрывает наш расчёт, если она больше — он знает,
 * когда остынет, мы гадаем.
 *
 * Массовый временный сбой идёт вторым: провайдер не отвечает,
 * и следующий залп ничего не изменит.
 *
 * Отсутствие котировок не значит ничего. Проход, в котором источник
 * честно ответил «таких цен нет», — успешный проход.
 */
export function cycleVerdict(
  report: ProviderReport,
  failures: number,
  cfg: CycleBackoffConfig = DEFAULT_CYCLE_BACKOFF,
  random: () => number = Math.random,
): CycleVerdict {
  const computed = cycleDelayMs(Math.max(1, failures), cfg, random);

  if (report.rateLimited > 0) {
    const asked = report.retryAfterMs ?? 0;

    return {
      kind: 'backoff',
      reason: 'rate-limit',
      // Потолок соблюдается и здесь: провайдер, попросивший ждать
      // сутки, не должен останавливать обновление цен на сутки.
      delayMs: Math.min(cfg.maxMs, Math.max(asked, computed)),
      honoredRetryAfter: asked > computed,
    };
  }

  const failed = report.transient;

  if (report.requested > 0 && failed / report.requested >= MASS_FAILURE_RATIO) {
    return { kind: 'backoff', reason: 'provider-down', delayMs: computed, honoredRetryAfter: false };
  }

  return { kind: 'ok' };
}

/**
 * Заголовок `Retry-After` в миллисекунды.
 *
 * Два формата по стандарту: число секунд и дата. Второй встречается
 * реже, но игнорировать его значит не соблюдать просьбу именно тогда,
 * когда провайдер выразил её точнее всего.
 *
 * Отрицательные и нечисловые значения отбрасываются: мусор в заголовке
 * не должен ни останавливать работу, ни выглядеть как «можно сразу».
 */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now: number = Date.now(),
): number | null {
  if (header == null) return null;

  const text = header.trim();
  if (text === '') return null;

  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) ? seconds * 1000 : null;
  }

  /*
   * До `Date.parse` доходит только то, что похоже на дату.
   *
   * Иначе `-5` разбирается как год и даёт паузу ноль — то есть мусор
   * в заголовке читается как «повторяй немедленно», ровно наоборот
   * к смыслу заголовка. Требуем четырёхзначный год и время.
   */
  if (!/\d{4}/.test(text) || !text.includes(':')) return null;

  const at = Date.parse(text);
  if (Number.isNaN(at)) return null;

  return Math.max(0, at - now);
}
