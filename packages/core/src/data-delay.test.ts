/**
 * Задержка данных и утечки.
 *
 * Половина набора проверяет не то, что скрыто, а то, что о скрытом
 * нельзя догадаться. Именно здесь такие системы и протекают:
 * карточку прячут, а счётчик, порядок, уведомление и прямой запрос
 * по идентификатору продолжают о ней рассказывать.
 */

import { describe, it, expect } from 'vitest';
import {
  FREE_DELAY_MS,
  visibleAt,
  isVisible,
  visibleItems,
  visibleSnapshot,
  delayMeta,
  cacheKey,
  cacheHeaders,
  countVisible,
  canReveal,
  DELAY_NOTICE,
} from './data-delay.js';

const NOW = 1_800_000_000_000;
const MIN = 60_000;

/** Событие, произошедшее столько-то миллисекунд назад. */
const ago = (ms: number) => ({ id: `e${ms}`, occurredAt: NOW - ms });

describe('видимость', () => {
  it('старое видно', () => {
    expect(isVisible(ago(4 * MIN), NOW, FREE_DELAY_MS)).toBe(true);
  });

  it('свежее скрыто', () => {
    expect(isVisible(ago(MIN), NOW, FREE_DELAY_MS)).toBe(false);
  });

  it('ровно на границе видно: три минуты прошли', () => {
    expect(isVisible(ago(FREE_DELAY_MS), NOW, FREE_DELAY_MS)).toBe(true);
  });

  it('на миллисекунду раньше границы — скрыто', () => {
    expect(isVisible(ago(FREE_DELAY_MS - 1), NOW, FREE_DELAY_MS)).toBe(false);
  });

  it('при нулевой задержке видно всё, включая только что созданное', () => {
    expect(isVisible(ago(0), NOW, 0)).toBe(true);
  });

  it('момент появления считается от события', () => {
    expect(visibleAt(NOW, FREE_DELAY_MS)).toBe(NOW + FREE_DELAY_MS);
  });
});

describe('отбор набора', () => {
  const items = [ago(10 * MIN), ago(5 * MIN), ago(2 * MIN), ago(10_000)];

  it('свежее не попадает в выдачу', () => {
    const visible = visibleItems(items, NOW, FREE_DELAY_MS);

    expect(visible).toHaveLength(2);
    expect(visible.map((i) => i.id)).toEqual(['e600000', 'e300000']);
  });

  it('без задержки отдаётся всё', () => {
    expect(visibleItems(items, NOW, 0)).toHaveLength(4);
  });

  it('пустой набор остаётся пустым', () => {
    expect(visibleItems([], NOW, FREE_DELAY_MS)).toEqual([]);
  });
});

describe('счётчики не выдают скрытое', () => {
  it('число в шапке совпадает с длиной списка', () => {
    // Число, не совпадающее со списком, сообщает о скрытом цифрой.
    const items = [ago(10 * MIN), ago(MIN), ago(30_000)];

    expect(countVisible(items, NOW, FREE_DELAY_MS)).toBe(
      visibleItems(items, NOW, FREE_DELAY_MS).length,
    );
  });

  it('появление скрытой записи не меняет счётчик', () => {
    // Рост счётчика с 1 до 2 означал бы «что-то нашлось».
    const before = [ago(10 * MIN)];
    const after = [ago(10 * MIN), ago(5_000)];

    expect(countVisible(before, NOW, FREE_DELAY_MS)).toBe(
      countVisible(after, NOW, FREE_DELAY_MS),
    );
  });

  it('через три минуты счётчик растёт', () => {
    const items = [ago(10 * MIN), ago(FREE_DELAY_MS - 1)];

    expect(countVisible(items, NOW, FREE_DELAY_MS)).toBe(1);
    expect(countVisible(items, NOW + 1, FREE_DELAY_MS)).toBe(2);
  });
});

describe('прямой запрос не обходит задержку', () => {
  it('скрытая запись не отдаётся по идентификатору', () => {
    // Иначе достаточно перебрать идентификаторы.
    expect(canReveal(ago(10_000), NOW, FREE_DELAY_MS)).toBe(false);
  });

  it('видимая запись отдаётся', () => {
    expect(canReveal(ago(10 * MIN), NOW, FREE_DELAY_MS)).toBe(true);
  });

  it('отсутствующая запись не отдаётся', () => {
    expect(canReveal(null, NOW, FREE_DELAY_MS)).toBe(false);
    expect(canReveal(undefined, NOW, 0)).toBe(false);
  });
});

describe('снимки изменяемых показателей', () => {
  const snap = (ms: number, price: number) => ({ observedAt: NOW - ms, price });

  it('берётся последний достаточно старый', () => {
    // Показать вчерашний токен с сегодняшней ценой — это отдать
    // платные данные бесплатно, просто в другой обёртке.
    const s = visibleSnapshot(
      [snap(10 * MIN, 1), snap(4 * MIN, 2), snap(10_000, 3)],
      NOW,
      FREE_DELAY_MS,
    );

    expect(s?.price).toBe(2);
  });

  it('если подходящего снимка нет — null, а не свежий', () => {
    const s = visibleSnapshot([snap(30_000, 3), snap(5_000, 4)], NOW, FREE_DELAY_MS);

    expect(s).toBeNull();
  });

  it('без задержки берётся самый свежий', () => {
    const s = visibleSnapshot([snap(10 * MIN, 1), snap(1_000, 9)], NOW, 0);

    expect(s?.price).toBe(9);
  });

  it('пустой список снимков даёт null', () => {
    expect(visibleSnapshot([], NOW, 0)).toBeNull();
  });

  it('порядок в массиве не влияет на выбор', () => {
    const ordered = visibleSnapshot([snap(4 * MIN, 2), snap(10 * MIN, 1)], NOW, FREE_DELAY_MS);
    const reversed = visibleSnapshot([snap(10 * MIN, 1), snap(4 * MIN, 2)], NOW, FREE_DELAY_MS);

    expect(ordered?.price).toBe(reversed?.price);
  });
});

describe('отметка в ответе', () => {
  it('задержанный ответ помечен явно', () => {
    const m = delayMeta(NOW - FREE_DELAY_MS, FREE_DELAY_MS);

    expect(m.isDelayed).toBe(true);
    expect(m.delaySeconds).toBe(180);
    expect(m.dataAsOf).toBe(new Date(NOW - FREE_DELAY_MS).toISOString());
  });

  it('мгновенный ответ тоже помечен, а не оставлен без поля', () => {
    // Отсутствие поля читается как «данные свежие», и однажды это
    // окажется неправдой.
    const m = delayMeta(NOW, 0);

    expect(m.isDelayed).toBe(false);
    expect(m.delaySeconds).toBe(0);
  });

  it('отсутствие данных не выдаёт время', () => {
    expect(delayMeta(null, FREE_DELAY_MS).dataAsOf).toBeNull();
  });
});

describe('кеш не смешивает планы', () => {
  it('ключи бесплатного и мгновенного плана различаются', () => {
    // Иначе первый платный пользователь прогреет кеш живыми данными,
    // и следующий бесплатный получит их оттуда.
    const free = cacheKey({ resource: 'radar', delaySeconds: 180 });
    const live = cacheKey({ resource: 'radar', delaySeconds: 0 });

    expect(free).not.toBe(live);
  });

  it('персональные данные разделены по пользователю', () => {
    const a = cacheKey({ resource: 'favorites', delaySeconds: 0, scope: 'u1' });
    const b = cacheKey({ resource: 'favorites', delaySeconds: 0, scope: 'u2' });

    expect(a).not.toBe(b);
  });

  it('порядок фильтров не создаёт разных ключей', () => {
    const a = cacheKey({ resource: 'radar', delaySeconds: 0, filters: { chain: 'SOLANA', sort: 'new' } });
    const b = cacheKey({ resource: 'radar', delaySeconds: 0, filters: { sort: 'new', chain: 'SOLANA' } });

    expect(a).toBe(b);
  });

  it('разные фильтры дают разные ключи', () => {
    const a = cacheKey({ resource: 'radar', delaySeconds: 0, filters: { chain: 'SOLANA' } });
    const b = cacheKey({ resource: 'radar', delaySeconds: 0, filters: { chain: 'BNB' } });

    expect(a).not.toBe(b);
  });

  it('момент снимка входит в ключ', () => {
    const a = cacheKey({ resource: 'radar', delaySeconds: 180, bucket: 1 });
    const b = cacheKey({ resource: 'radar', delaySeconds: 180, bucket: 2 });

    expect(a).not.toBe(b);
  });

  it('страница входит в ключ', () => {
    const a = cacheKey({ resource: 'radar', delaySeconds: 0, cursor: 'c1' });
    const b = cacheKey({ resource: 'radar', delaySeconds: 0, cursor: 'c2' });

    expect(a).not.toBe(b);
  });
});

describe('заголовки кеширования', () => {
  it('мгновенные данные не кешируются вовсе', () => {
    // Попав в общий кеш или в CDN, они достанутся тому,
    // кто за них не платил.
    expect(cacheHeaders(0)['cache-control']).toContain('no-store');
    expect(cacheHeaders(0)['cache-control']).toContain('private');
  });

  it('задержанные данные кешируются, но только приватно', () => {
    const h = cacheHeaders(180)['cache-control']!;

    expect(h).toContain('private');
    expect(h).not.toContain('public');
  });
});

describe('сообщение пользователю', () => {
  it('общее и без обратного отсчёта', () => {
    // «Через 2:14» прямо сообщает, что скрытое существует,
    // и сводит задержку на нет.
    expect(DELAY_NOTICE).toContain('задержкой');
    expect(DELAY_NOTICE).not.toMatch(/\d+:\d+/);
  });
});
