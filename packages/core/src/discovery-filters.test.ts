import { describe, it, expect } from 'vitest';
import {
  parseLiquidityUsd,
  passesLiquidityFloor,
  effectiveLiquidityFloor,
  isSaneLiquidityFloor,
  marketAge,
  isNewMarket,
  marketAgeLabel,
  NEW_MARKET_MAX_AGE_MS,
} from './discovery-filters.js';

/**
 * Правила витрины.
 *
 * Оба защищают от одного и того же: показать человеку то, чего
 * показывать нельзя. Токен с пулом в полдоллара нельзя продать,
 * а «новым» на этом рынке называют то, во что вкладываются первыми.
 */

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 7, 23, 12, 0, 0);

describe('разбор ликвидности', () => {
  it('принимает число и строку', () => {
    // Prisma отдаёт Decimal строкой, провайдер — числом.
    expect(parseLiquidityUsd(15000)).toBe(15000);
    expect(parseLiquidityUsd('15000.50')).toBe(15000.5);
  });

  it('ноль — это ноль, а не отсутствие значения', () => {
    expect(parseLiquidityUsd(0)).toBe(0);
    expect(parseLiquidityUsd('0')).toBe(0);
  });

  it.each([null, undefined, '', 'много', NaN, Infinity, -1, '-500'])(
    'не принимает %s',
    (raw) => {
      expect(parseLiquidityUsd(raw)).toBeNull();
    },
  );
});

describe('порог ликвидности', () => {
  it('пропускает ровно на пороге и выше', () => {
    expect(passesLiquidityFloor(15000, 15000)).toBe(true);
    expect(passesLiquidityFloor(15001, 15000)).toBe(true);
  });

  it('не пропускает ниже порога', () => {
    expect(passesLiquidityFloor(14999, 15000)).toBe(false);
  });

  it('не пропускает копеечные пулы', () => {
    // Ровно то, что попадало в подборки: пул, который нельзя продать.
    for (const raw of [0, 0.5, '0.99', 1]) {
      expect(passesLiquidityFloor(raw, 15000), String(raw)).toBe(false);
    }
  });

  it('не пропускает неизвестную ликвидность', () => {
    // Провайдер чаще всего молчит именно о мусоре.
    expect(passesLiquidityFloor(null, 15000)).toBe(false);
    expect(passesLiquidityFloor(undefined, 15000)).toBe(false);
    expect(passesLiquidityFloor('нет данных', 15000)).toBe(false);
  });

  it('не пропускает отрицательную и нечисловую', () => {
    expect(passesLiquidityFloor(-100000, 15000)).toBe(false);
    expect(passesLiquidityFloor(NaN, 15000)).toBe(false);
  });
});

describe('действующий порог', () => {
  it('без запроса берётся базовый', () => {
    expect(effectiveLiquidityFloor(null, 15000)).toBe(15000);
    expect(effectiveLiquidityFloor(undefined, 15000)).toBe(15000);
  });

  it('клиент может попросить строже', () => {
    expect(effectiveLiquidityFloor(100000, 15000)).toBe(100000);
  });

  it('клиент не может попросить мягче', () => {
    // Параметр запроса — пожелание пользователя, порог — правило
    // платформы, и второе сильнее.
    expect(effectiveLiquidityFloor(100, 15000)).toBe(15000);
  });

  it('ноль от клиента не отключает фильтр', () => {
    // Прежняя проверка на истинность делала ровно это: `0` считался
    // отсутствием значения, и витрина открывалась целиком.
    expect(effectiveLiquidityFloor(0, 15000)).toBe(15000);
  });

  it('мусор от клиента игнорируется', () => {
    expect(effectiveLiquidityFloor(NaN, 15000)).toBe(15000);
    expect(effectiveLiquidityFloor(Number.POSITIVE_INFINITY, 15000)).toBe(15000);
  });
});

describe('настройка порога', () => {
  it('признаёт разумные значения', () => {
    expect(isSaneLiquidityFloor(15000)).toBe(true);
    expect(isSaneLiquidityFloor(1)).toBe(true);
  });

  it('отвергает ноль и отрицательное', () => {
    // Порог в ноль — это витрина без фильтра, и узнать об этом
    // из жалобы дороже, чем из отказа подняться.
    expect(isSaneLiquidityFloor(0)).toBe(false);
    expect(isSaneLiquidityFloor(-1)).toBe(false);
    expect(isSaneLiquidityFloor(NaN)).toBe(false);
  });
});

// ──────────────────────────── Возраст рынка ──────────────────────────────────

describe('возраст рынка', () => {
  it('берёт время пула, когда оно есть', () => {
    const age = marketAge({ poolCreatedAt: new Date(NOW - 3 * HOUR) }, NOW);

    expect(age.source).toBe('pool');
    expect(age.ageMs).toBe(3 * HOUR);
  });

  it('падает на первое наблюдение, когда пула нет', () => {
    const age = marketAge({ poolCreatedAt: null, firstSeenAt: new Date(NOW - 5 * HOUR) }, NOW);

    expect(age.source).toBe('first-seen');
    expect(age.ageMs).toBe(5 * HOUR);
  });

  it('время пула важнее первого наблюдения', () => {
    // Токен, впервые увиденный сегодня, но с пулом месячной давности,
    // старый. Ровно этот случай и выдавался за новинку.
    const age = marketAge(
      { poolCreatedAt: new Date(NOW - 30 * 24 * HOUR), firstSeenAt: new Date(NOW - HOUR) },
      NOW,
    );

    expect(age.source).toBe('pool');
    expect(age.ageMs).toBe(30 * 24 * HOUR);
  });

  it('без обоих источников возраст неизвестен', () => {
    const age = marketAge({}, NOW);

    expect(age.source).toBe('unknown');
    expect(age.at).toBeNull();
    expect(age.ageMs).toBeNull();
  });

  it('не принимает нечитаемую дату за возраст', () => {
    expect(marketAge({ poolCreatedAt: 'вчера' }, NOW).source).toBe('unknown');
  });

  it('не даёт отрицательного возраста', () => {
    // Часы провайдера могут уйти вперёд; «минус два часа»
    // выглядело бы как рынок из будущего.
    expect(marketAge({ poolCreatedAt: new Date(NOW + HOUR) }, NOW).ageMs).toBe(0);
  });
});

describe('что считается новым', () => {
  it('пул моложе суток — новый', () => {
    expect(isNewMarket(marketAge({ poolCreatedAt: new Date(NOW - 2 * HOUR) }, NOW))).toBe(true);
  });

  it('ровно сутки ещё новый, старше — нет', () => {
    const exactly = marketAge({ poolCreatedAt: new Date(NOW - NEW_MARKET_MAX_AGE_MS) }, NOW);
    const older = marketAge({ poolCreatedAt: new Date(NOW - NEW_MARKET_MAX_AGE_MS - 1) }, NOW);

    expect(isNewMarket(exactly)).toBe(true);
    expect(isNewMarket(older)).toBe(false);
  });

  it('старый токен, импортированный сегодня, новым не считается', () => {
    // Главная проверка файла: до неё «Новые» показывали свежий импорт.
    const age = marketAge(
      { poolCreatedAt: new Date(NOW - 90 * 24 * HOUR), firstSeenAt: new Date(NOW - 60_000) },
      NOW,
    );

    expect(isNewMarket(age)).toBe(false);
  });

  it('неизвестный возраст не смешивается с настоящими новыми', () => {
    // «Новое» здесь читается как «успей первым». Выдать за находку
    // то, о чём ничего не известно, значит подтолкнуть к покупке
    // вслепую.
    expect(isNewMarket(marketAge({}, NOW))).toBe(false);
  });
});

describe('подпись возраста', () => {
  it('называет неизвестное неизвестным', () => {
    expect(marketAgeLabel(marketAge({}, NOW))).toBe('возраст неизвестен');
  });

  it.each([
    [10 * 60_000, '10 мин'],
    [3 * HOUR, '3 ч'],
    [50 * HOUR, '2 дн'],
  ])('%s мс → %s', (ageMs, label) => {
    expect(marketAgeLabel(marketAge({ poolCreatedAt: new Date(NOW - ageMs) }, NOW))).toBe(label);
  });

  it('только что созданный пул не показывается нулём минут', () => {
    expect(marketAgeLabel(marketAge({ poolCreatedAt: new Date(NOW - 5_000) }, NOW))).toBe('1 мин');
  });
});
