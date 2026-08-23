import { describe, it, expect } from 'vitest';
import {
  backoffDelayMs,
  nextAttemptState,
  nextBatch,
  retriesExhausted,
  DEFAULT_BACKOFF,
  DEFAULT_FAIR_SHARE,
  type QueueCandidate,
} from './check-queue.js';

/**
 * Обещания очереди.
 *
 * Проверяются без сети и без ожиданий: политика чистая, время
 * и случайность передаются аргументами. Тест на экспоненциальный
 * отступ иначе шёл бы полчаса.
 */

const NOW = Date.parse('2026-08-23T12:00:00Z');
const MIN = 60_000;

const candidate = (over: Partial<QueueCandidate> & { id: string }): QueueCandidate => ({
  priority: 'routine',
  checkedAt: NOW - 10 * MIN,
  attempts: 0,
  nextAttemptAt: null,
  volume24hUsd: 1000,
  ...over,
});

const ids = (list: QueueCandidate[]) => list.map((c) => c.id);

describe('порядок по срочности', () => {
  it('открытая карточка идёт первой', () => {
    // Человек смотрит на экран сию секунду. Плановая перепроверка
    // не ждёт никто.
    const batch = nextBatch(
      [
        candidate({ id: 'routine' }),
        candidate({ id: 'stale', priority: 'stale' }),
        candidate({ id: 'opened', priority: 'opened' }),
        candidate({ id: 'found', priority: 'discovered' }),
      ],
      { now: NOW, limit: 4, fairShare: 0 },
    );

    expect(ids(batch)[0]).toBe('opened');
    expect(ids(batch)[1]).toBe('found');
  });

  it('внутри приоритета первыми идут ни разу не проверенные', () => {
    const batch = nextBatch(
      [
        candidate({ id: 'old', checkedAt: NOW - 100 * MIN }),
        candidate({ id: 'never', checkedAt: null }),
      ],
      { now: NOW, limit: 2, fairShare: 0 },
    );

    expect(ids(batch)[0]).toBe('never');
  });

  it('при равном возрасте вперёд идёт оборот', () => {
    const batch = nextBatch(
      [
        candidate({ id: 'small', volume24hUsd: 10 }),
        candidate({ id: 'big', volume24hUsd: 1_000_000 }),
      ],
      { now: NOW, limit: 2, fairShare: 0 },
    );

    expect(ids(batch)[0]).toBe('big');
  });
});

describe('дедупликация', () => {
  it('токен, открытый тремя людьми, проверяется один раз', () => {
    const batch = nextBatch(
      [
        candidate({ id: 'wif', priority: 'opened' }),
        candidate({ id: 'wif', priority: 'opened' }),
        candidate({ id: 'wif', priority: 'routine' }),
      ],
      { now: NOW, limit: 5 },
    );

    expect(ids(batch)).toEqual(['wif']);
  });

  it('из дубликатов остаётся самый срочный', () => {
    const batch = nextBatch(
      [
        candidate({ id: 'wif', priority: 'routine' }),
        candidate({ id: 'wif', priority: 'opened' }),
      ],
      { now: NOW, limit: 5 },
    );

    expect(batch[0]!.priority).toBe('opened');
  });
});

describe('задержка повтора', () => {
  it('токен, упавший минуту назад, в пачку не попадает', () => {
    const batch = nextBatch(
      [
        candidate({ id: 'waiting', attempts: 1, nextAttemptAt: NOW + 5 * MIN }),
        candidate({ id: 'ready' }),
      ],
      { now: NOW, limit: 5 },
    );

    expect(ids(batch)).toEqual(['ready']);
  });

  it('срочность задержку не отменяет', () => {
    // Иначе открытая карточка била бы провайдера в упор, сколько бы
    // раз он ни отказал.
    const batch = nextBatch(
      [candidate({ id: 'hot', priority: 'opened', attempts: 2, nextAttemptAt: NOW + MIN })],
      { now: NOW, limit: 5 },
    );

    expect(batch).toEqual([]);
  });

  it('наступивший срок возвращает токен в очередь', () => {
    const batch = nextBatch(
      [candidate({ id: 'back', attempts: 2, nextAttemptAt: NOW - 1 })],
      { now: NOW, limit: 5 },
    );

    expect(ids(batch)).toEqual(['back']);
  });
});

describe('защита от бесконечного круга', () => {
  it('исчерпавший попытки выпадает из очереди', () => {
    /*
     * Пять токенов, стабильно роняющих проверку, выедают всю
     * пропускную способность, а снаружи очередь выглядит
     * работающей.
     */
    const batch = nextBatch(
      [
        candidate({ id: 'broken', attempts: DEFAULT_BACKOFF.maxAttempts }),
        candidate({ id: 'fine' }),
      ],
      { now: NOW, limit: 5 },
    );

    expect(ids(batch)).toEqual(['fine']);
  });

  it('предел считается одинаково в отборе и в переходе', () => {
    expect(retriesExhausted(DEFAULT_BACKOFF.maxAttempts)).toBe(true);
    expect(retriesExhausted(DEFAULT_BACKOFF.maxAttempts - 1)).toBe(false);
  });
});

describe('честная доля старым', () => {
  it('плановая перепроверка не голодает под потоком срочных', () => {
    /*
     * Без этой доли очередь не доходит до планового круга никогда:
     * открытые карточки и свежие находки приходят непрерывно,
     * и витрина тихо устаревает целиком.
     */
    const urgent = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `hot-${i}`, priority: 'opened', checkedAt: NOW - MIN }),
    );

    const ancient = candidate({ id: 'ancient', checkedAt: NOW - 5000 * MIN });

    const batch = nextBatch([...urgent, ancient], { now: NOW, limit: 8 });

    expect(ids(batch)).toContain('ancient');
  });

  it('доля не съедает всю пачку', () => {
    const urgent = Array.from({ length: 20 }, (_, i) =>
      candidate({ id: `hot-${i}`, priority: 'opened', checkedAt: NOW - MIN }),
    );

    const batch = nextBatch([...urgent, candidate({ id: 'ancient', checkedAt: 0 })], {
      now: NOW,
      limit: 8,
    });

    const hot = ids(batch).filter((id) => id.startsWith('hot-')).length;

    expect(hot).toBeGreaterThanOrEqual(Math.floor(8 * (1 - DEFAULT_FAIR_SHARE)));
  });

  it('пачка не превышает предел', () => {
    const many = Array.from({ length: 50 }, (_, i) => candidate({ id: `t-${i}` }));
    expect(nextBatch(many, { now: NOW, limit: 8 })).toHaveLength(8);
  });

  it('нулевой предел даёт пустую пачку', () => {
    expect(nextBatch([candidate({ id: 'x' })], { now: NOW, limit: 0 })).toEqual([]);
  });
});

describe('экспоненциальный отступ с разбросом', () => {
  it('растёт с каждой попыткой', () => {
    // random = 0 даёт верхнюю границу: разброс только уменьшает.
    const at = (n: number) => backoffDelayMs(n, DEFAULT_BACKOFF, () => 0);

    expect(at(1)).toBe(DEFAULT_BACKOFF.baseMs);
    expect(at(2)).toBe(DEFAULT_BACKOFF.baseMs * 2);
    expect(at(3)).toBe(DEFAULT_BACKOFF.baseMs * 4);
  });

  it('упирается в потолок', () => {
    expect(backoffDelayMs(20, DEFAULT_BACKOFF, () => 0)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it('разброс только уменьшает задержку', () => {
    // Превышать собственный потолок нехорошо.
    const full = backoffDelayMs(3, DEFAULT_BACKOFF, () => 0);
    const jittered = backoffDelayMs(3, DEFAULT_BACKOFF, () => 1);

    expect(jittered).toBeLessThan(full);
    expect(jittered).toBe(Math.round(full * (1 - DEFAULT_BACKOFF.jitter)));
  });

  it('разброс существует', () => {
    /*
     * Без него сотня токенов, упавших на одном таймауте провайдера,
     * повторит запрос в одну миллисекунду и уронит его снова —
     * уже своими силами.
     */
    const values = [0, 0.25, 0.5, 0.75, 1].map((r) => backoffDelayMs(4, DEFAULT_BACKOFF, () => r));

    expect(new Set(values).size).toBeGreaterThan(1);
  });

  it('нулевая попытка ждать не заставляет', () => {
    expect(backoffDelayMs(0)).toBe(0);
  });
});

describe('переход состояния попыток', () => {
  it('успех обнуляет счётчик', () => {
    /*
     * Без обнуления токен, упавший пять раз за месяц и с тех пор
     * проверяющийся нормально, однажды упрётся в предел и выпадет
     * из очереди навсегда.
     */
    expect(nextAttemptState({ attempts: 4, nextAttemptAt: NOW }, { ok: true }, NOW)).toEqual({
      attempts: 0,
      nextAttemptAt: null,
    });
  });

  it('неудача растит счётчик и назначает повтор', () => {
    const next = nextAttemptState(
      { attempts: 0, nextAttemptAt: null },
      { ok: false, providerError: true },
      NOW,
      DEFAULT_BACKOFF,
      () => 0,
    );

    expect(next.attempts).toBe(1);
    expect(next.nextAttemptAt).toBe(NOW + DEFAULT_BACKOFF.baseMs);
  });

  it('после предела повтор не назначается', () => {
    // Ждать больше нечего: токен вернётся в очередь только со сменой
    // версии правил или по ручному запросу.
    const next = nextAttemptState(
      { attempts: DEFAULT_BACKOFF.maxAttempts - 1, nextAttemptAt: null },
      { ok: false },
      NOW,
    );

    expect(next.attempts).toBe(DEFAULT_BACKOFF.maxAttempts);
    expect(next.nextAttemptAt).toBeNull();
  });
});
