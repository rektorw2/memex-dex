import { describe, it, expect } from 'vitest';
import {
  cycleVerdict,
  cycleDelayMs,
  mergeReports,
  parseRetryAfterMs,
  EMPTY_PROVIDER_REPORT,
  DEFAULT_CYCLE_BACKOFF as CFG,
  MASS_FAILURE_RATIO,
  type ProviderReport,
} from './provider-cycle.js';

/**
 * Отступать ли после прохода к провайдеру.
 *
 * Воркер цен считал успешным любой проход: каждый запрос был обёрнут
 * в `.catch(() => null)`, и полный отказ выглядел ровно как проход,
 * в котором цен не нашлось. Счётчик неудач сбрасывался, отступ
 * не включался никогда, и мы продолжали стучаться в отказавший
 * источник каждые тридцать секунд.
 */

const report = (over: Partial<ProviderReport> = {}): ProviderReport => ({
  ...EMPTY_PROVIDER_REPORT,
  requested: 100,
  ...over,
});

/** Без разброса: проверяем границы, а не вероятности. */
const NO_JITTER = () => 0;

describe('отсутствие котировок не считается отказом', () => {
  it('источник ответил, цен нет — проход успешный', () => {
    /*
     * У половины мем-коинов цены нет ни у кого. Считать это сбоем
     * значило бы остановить обновление живых токенов из-за мёртвых.
     */
    expect(cycleVerdict(report({ missing: 100 }), 0)).toEqual({ kind: 'ok' });
  });

  it('одна пропавшая цена системным отказом не является', () => {
    expect(cycleVerdict(report({ fetched: 99, missing: 1 }), 0)).toEqual({ kind: 'ok' });
  });

  it('единичный сбой тоже', () => {
    expect(cycleVerdict(report({ fetched: 99, transient: 1 }), 0)).toEqual({ kind: 'ok' });
  });

  it('пустой проход ничего не решает', () => {
    // Нечего было запрашивать — не о чем и судить.
    expect(cycleVerdict(EMPTY_PROVIDER_REPORT, 0)).toEqual({ kind: 'ok' });
  });
});

describe('отказ по частоте', () => {
  it('один 429 включает отступ', () => {
    const v = cycleVerdict(report({ rateLimited: 100 }), 0, CFG, NO_JITTER);

    expect(v.kind).toBe('backoff');
    expect(v.kind === 'backoff' && v.reason).toBe('rate-limit');
  });

  it('429 важнее любой доли успеха', () => {
    // Провайдер сказал «слишком часто». Спорить с этим нечем,
    // сколько бы цен ни пришло до отказа.
    const v = cycleVerdict(report({ fetched: 99, rateLimited: 1 }), 0, CFG, NO_JITTER);

    expect(v.kind).toBe('backoff');
  });
});

describe('Retry-After соблюдается', () => {
  it('просьба провайдера перекрывает наш расчёт', () => {
    // Он знает, когда остынет; мы гадаем.
    const asked = 120_000;
    const v = cycleVerdict(report({ rateLimited: 100, retryAfterMs: asked }), 1, CFG, NO_JITTER);

    expect(v.kind === 'backoff' && v.delayMs).toBe(asked);
    expect(v.kind === 'backoff' && v.honoredRetryAfter).toBe(true);
  });

  it('меньшая просьба нашу оценку не уменьшает', () => {
    // Провайдер, попросивший секунду после третьего отказа подряд,
    // ошибается насчёт своего состояния сильнее, чем мы.
    const v = cycleVerdict(report({ rateLimited: 100, retryAfterMs: 1 }), 3, CFG, NO_JITTER);

    expect(v.kind === 'backoff' && v.delayMs).toBe(cycleDelayMs(3, CFG, NO_JITTER));
    expect(v.kind === 'backoff' && v.honoredRetryAfter).toBe(false);
  });

  it('чрезмерная просьба упирается в потолок', () => {
    /*
     * Пауза не должна превращаться в остановку: цены нужны и после
     * отказа провайдера. Сутки ожидания означали бы сутки вчерашних
     * котировок на торговом экране.
     */
    const v = cycleVerdict(
      report({ rateLimited: 100, retryAfterMs: 24 * 3_600_000 }),
      1,
      CFG,
      NO_JITTER,
    );

    expect(v.kind === 'backoff' && v.delayMs).toBe(CFG.maxMs);
  });
});

describe('массовый сбой', () => {
  it('половина неудач включает отступ', () => {
    const v = cycleVerdict(report({ transient: 50, fetched: 50 }), 0, CFG, NO_JITTER);

    expect(v.kind).toBe('backoff');
    expect(v.kind === 'backoff' && v.reason).toBe('provider-down');
  });

  it('ниже порога проход считается рабочим', () => {
    const below = Math.floor(100 * MASS_FAILURE_RATIO) - 1;
    expect(cycleVerdict(report({ transient: below, fetched: 100 - below }), 0)).toEqual({
      kind: 'ok',
    });
  });

  it('отсутствие цен в долю неудач не входит', () => {
    // Иначе пачка токенов без котировок выглядела бы отказом
    // провайдера и останавливала обновление остальных.
    expect(cycleVerdict(report({ missing: 100 }), 0)).toEqual({ kind: 'ok' });
  });
});

describe('пауза растёт и не убегает', () => {
  it('удваивается с каждым отказом', () => {
    expect(cycleDelayMs(1, CFG, NO_JITTER)).toBe(CFG.baseMs);
    expect(cycleDelayMs(2, CFG, NO_JITTER)).toBe(CFG.baseMs * 2);
    expect(cycleDelayMs(3, CFG, NO_JITTER)).toBe(CFG.baseMs * 4);
  });

  it('упирается в потолок', () => {
    expect(cycleDelayMs(50, CFG, NO_JITTER)).toBe(CFG.maxMs);
  });

  it('разброс только уменьшает', () => {
    // Превышать собственный потолок нехорошо.
    expect(cycleDelayMs(3, CFG, () => 1)).toBeLessThan(cycleDelayMs(3, CFG, NO_JITTER));
  });

  it('нулевая неудача паузы не даёт', () => {
    expect(cycleDelayMs(0, CFG, NO_JITTER)).toBe(0);
  });
});

describe('сложение отчётов', () => {
  it('числа складываются', () => {
    const merged = mergeReports(
      report({ requested: 10, fetched: 5, missing: 5 }),
      report({ requested: 20, fetched: 20 }),
    );

    expect(merged.requested).toBe(30);
    expect(merged.fetched).toBe(25);
  });

  it('берётся наибольшая просьба подождать', () => {
    // Меньшая её не отменяет.
    const merged = mergeReports(
      report({ retryAfterMs: 1_000 }),
      report({ retryAfterMs: 60_000 }),
      report({ retryAfterMs: null }),
    );

    expect(merged.retryAfterMs).toBe(60_000);
  });

  it('пустое сложение даёт пустой отчёт', () => {
    expect(mergeReports()).toEqual(EMPTY_PROVIDER_REPORT);
  });
});

describe('разбор Retry-After', () => {
  const NOW = Date.parse('2026-08-23T12:00:00Z');

  it('секунды', () => {
    expect(parseRetryAfterMs('30', NOW)).toBe(30_000);
  });

  it('дата', () => {
    // Второй формат по стандарту. Игнорировать его значит
    // не соблюдать просьбу там, где она выражена точнее всего.
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 12:02:00 GMT', NOW)).toBe(120_000);
  });

  it('дата в прошлом не даёт отрицательной паузы', () => {
    expect(parseRetryAfterMs('Sun, 23 Aug 2026 11:00:00 GMT', NOW)).toBe(0);
  });

  it('отсутствие заголовка', () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterMs('   ', NOW)).toBeNull();
  });

  it('мусор не ломает работу и не читается как «можно сразу»', () => {
    expect(parseRetryAfterMs('скоро', NOW)).toBeNull();
    expect(parseRetryAfterMs('-5', NOW)).toBeNull();
  });
});
