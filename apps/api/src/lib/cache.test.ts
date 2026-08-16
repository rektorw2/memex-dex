import { describe, it, expect, beforeEach, vi } from 'vitest';
import { cached, peek, invalidate, resetCache, withRetry, Concurrency, RateLimit } from './cache.js';

beforeEach(() => resetCache());

describe('кеш', () => {
  it('второе обращение не идёт к источнику', async () => {
    const loader = vi.fn(async () => 'значение');

    await cached('k', loader, { ttlMs: 1000 });
    await cached('k', loader, { ttlMs: 1000 });

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('после истечения срока значение отдаётся, но помечается устаревшим', async () => {
    let n = 0;
    const loader = async () => `v${++n}`;

    const first = await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    expect(first.value).toBe('v1');
    expect(first.isStale).toBe(false);

    await new Promise((r) => setTimeout(r, 25));

    // Отдаётся старое немедленно — но честно помеченное как старое.
    const second = await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    expect(second.value).toBe('v1');
    expect(second.isStale).toBe(true);
    expect(second.ageMs).toBeGreaterThan(0);
  });

  it('фоновое обновление доносит новое значение', async () => {
    let n = 0;
    const loader = async () => `v${++n}`;

    await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    await new Promise((r) => setTimeout(r, 25));
    await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    await new Promise((r) => setTimeout(r, 20));

    const third = await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    expect(third.value).toBe('v2');
  });

  it('после полного истечения источник опрашивается заново и ждётся', async () => {
    let n = 0;
    const loader = async () => `v${++n}`;

    await cached('k', loader, { ttlMs: 5, staleMs: 5 });
    await new Promise((r) => setTimeout(r, 30));

    const again = await cached('k', loader, { ttlMs: 5, staleMs: 5 });
    expect(again.value).toBe('v2');
    expect(again.isStale).toBe(false);
  });

  it('одновременные обращения к пустому ключу дают один запрос', async () => {
    // Иначе первое обращение к холодному кешу умножается на число
    // одновременных пользователей — ровно тогда, когда источник
    // меньше всего к этому готов.
    const loader = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'значение';
    });

    const results = await Promise.all([
      cached('k', loader, { ttlMs: 1000 }),
      cached('k', loader, { ttlMs: 1000 }),
      cached('k', loader, { ttlMs: 1000 }),
    ]);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r.value === 'значение')).toBe(true);
  });

  it('ошибка при пустом кеше пробрасывается', async () => {
    // Притвориться, что данных нет по причине их отсутствия, нельзя.
    await expect(
      cached('k', async () => { throw new Error('источник упал'); }, { ttlMs: 100 }),
    ).rejects.toThrow('источник упал');
  });

  it('ошибка при наличии устаревшего значения его не рушит', async () => {
    let fail = false;
    const loader = async () => {
      if (fail) throw new Error('упал');
      return 'старое';
    };

    await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    await new Promise((r) => setTimeout(r, 25));
    fail = true;

    const hit = await cached('k', loader, { ttlMs: 10, staleMs: 10_000 });
    expect(hit.value).toBe('старое');
    expect(hit.isStale).toBe(true);
  });

  it('peek не ходит к источнику', async () => {
    const loader = vi.fn(async () => 'v');
    expect(peek('k')).toBeNull();

    await cached('k', loader, { ttlMs: 1000 });
    expect(peek<string>('k')?.value).toBe('v');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('сброс по префиксу', async () => {
    await cached('okx:hot:SOLANA', async () => 1, { ttlMs: 1000 });
    await cached('okx:hot:BASE', async () => 2, { ttlMs: 1000 });
    await cached('rugcheck:x', async () => 3, { ttlMs: 1000 });

    expect(invalidate('okx:hot:')).toBe(2);
    expect(peek('okx:hot:SOLANA')).toBeNull();
    expect(peek('rugcheck:x')).not.toBeNull();
  });
});

describe('повторы', () => {
  it('временная ошибка переживается', async () => {
    let n = 0;
    const fn = async () => {
      if (++n < 3) throw new Error('сеть');
      return 'ок';
    };

    expect(await withRetry(fn, { attempts: 3, baseDelayMs: 1 })).toBe('ок');
    expect(n).toBe(3);
  });

  it('постоянная ошибка не повторяется', async () => {
    // Неверный запрос не станет верным со второй попытки, а лимит израсходует.
    let n = 0;
    const fn = async () => {
      n++;
      const e: any = new Error('400');
      e.permanent = true;
      throw e;
    };

    await expect(withRetry(fn, { attempts: 5, baseDelayMs: 1 })).rejects.toThrow('400');
    expect(n).toBe(1);
  });

  it('после исчерпания попыток ошибка пробрасывается', async () => {
    await expect(
      withRetry(async () => { throw new Error('всё'); }, { attempts: 2, baseDelayMs: 1 }),
    ).rejects.toThrow('всё');
  });
});

describe('ограничение одновременности', () => {
  it('больше предела одновременно не запускается', async () => {
    const pool = new Concurrency(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 10 }, () =>
        pool.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });

  it('map сохраняет порядок результатов', async () => {
    const pool = new Concurrency(3);
    const out = await pool.map([1, 2, 3, 4, 5], async (n) => {
      await new Promise((r) => setTimeout(r, (6 - n) * 2));
      return n * 10;
    });
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  it('ошибка одной задачи не оставляет очередь заблокированной', async () => {
    const pool = new Concurrency(1);
    await expect(pool.run(async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(await pool.run(async () => 'следующая прошла')).toBe('следующая прошла');
  });
});

describe('ограничение частоты', () => {
  it('в пределах ёмкости не задерживает', async () => {
    const rl = new RateLimit(5, 1000);
    const start = Date.now();
    for (let i = 0; i < 5; i++) await rl.take();
    expect(Date.now() - start).toBeLessThan(50);
  });

  it('сверх ёмкости ждёт', async () => {
    const rl = new RateLimit(2, 100);
    const start = Date.now();
    for (let i = 0; i < 3; i++) await rl.take();
    expect(Date.now() - start).toBeGreaterThanOrEqual(50);
  });
});
