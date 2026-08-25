import { describe, it, expect } from 'vitest';
import {
  emptyCandleHistory,
  mergeCandlePages,
  applyHistoryPage,
  shouldLoadOlder,
  isAwayFromLive,
  historyFor,
  markHistoryFailed,
  clearHistoryFailure,
  HISTORY_PREFETCH_MARGIN,
} from './candle-history.js';
import type { LiveChartCandle } from './chart-live.js';

/**
 * Подгрузка истории графика.
 *
 * Арифметика на массивах, поэтому и проверяется на массивах.
 * Дефект, ради которого всё написано, в браузере выглядит как
 * «график не грузится дальше» и не оставляет ни ошибки, ни следа
 * в консоли.
 */

const candle = (time: number, close = 1): LiveChartCandle => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

const page = (from: number, count: number, step = 60) =>
  Array.from({ length: count }, (_, i) => candle(from + i * step));

// ────────────────────────────── Слияние ─────────────────────────────────────

describe('слияние страниц', () => {
  it('старая страница встаёт перед новой', () => {
    const merged = mergeCandlePages(page(1000, 3), page(700, 3));

    expect(merged.map((c) => c.time)).toEqual([700, 760, 820, 1000, 1060, 1120]);
  });

  it('перекрытие по краю не даёт дублей', () => {
    // Страницы перекрываются: провайдер отдаёт границу дважды.
    const merged = mergeCandlePages(page(1000, 3), page(880, 3));

    expect(merged.map((c) => c.time)).toEqual([880, 940, 1000, 1060, 1120]);
    expect(new Set(merged.map((c) => c.time)).size).toBe(merged.length);
  });

  it('порядок строго возрастающий', () => {
    const merged = mergeCandlePages(page(500, 4), page(2000, 4));

    for (let i = 1; i < merged.length; i++) {
      expect(merged[i]!.time).toBeGreaterThan(merged[i - 1]!.time);
    }
  });

  it('живая свеча не затирается страницей истории', () => {
    // Последняя свеча меняется каждую секунду; старая страница
    // с тем же временем не должна вернуть прежнюю цену.
    const live = [candle(1000, 42)];
    const history = [candle(1000, 7), candle(940, 6)];

    const merged = mergeCandlePages(live, history);

    expect(merged.find((c) => c.time === 1000)!.close).toBe(42);
  });

  it('пустая страница ничего не ломает', () => {
    expect(mergeCandlePages(page(100, 2), [])).toHaveLength(2);
    expect(mergeCandlePages([], page(100, 2))).toHaveLength(2);
  });
});

// ─────────────────────────── Состояние истории ──────────────────────────────

describe('применение страницы', () => {
  const base = () => applyHistoryPage(emptyCandleHistory('t1', '5m'), page(1000, 5), null);

  it('первая страница задаёт курсор', () => {
    const state = base();

    expect(state.candles).toHaveLength(5);
    expect(state.oldest).toBe(1000);
    expect(state.exhausted).toBe(false);
  });

  it('следующая страница сдвигает курсор влево', () => {
    const next = applyHistoryPage(base(), page(700, 5), 1000);

    expect(next.oldest).toBe(700);
    expect(next.candles).toHaveLength(10);
    expect(next.requested.has(1000)).toBe(true);
  });

  it('пустая страница означает конец истории', () => {
    const next = applyHistoryPage(base(), [], 1000);

    expect(next.exhausted).toBe(true);
    // Свечи остаются: конец истории не повод стереть график.
    expect(next.candles).toHaveLength(5);
  });

  it('страница без новых свечей тоже означает конец', () => {
    // Провайдер ответил, но всё это уже было: следующий запрос
    // принесёт ровно то же самое.
    const next = applyHistoryPage(base(), page(1000, 5), 1000);

    expect(next.exhausted).toBe(true);
  });
});

describe('повторные запросы', () => {
  const loaded = applyHistoryPage(emptyCandleHistory('t1', '5m'), page(1000, 5), null);

  it('по достигнутому краю запрос идёт один раз', () => {
    expect(shouldLoadOlder({ state: loaded, visibleFrom: 0 })).toBe(true);

    const asked = { ...loaded, requested: new Set([1000]) };
    expect(shouldLoadOlder({ state: asked, visibleFrom: 0 })).toBe(false);
  });

  it('пока запрос в пути, второй не отправляется', () => {
    expect(shouldLoadOlder({ state: { ...loaded, loading: true }, visibleFrom: 0 })).toBe(false);
  });

  it('после конца истории не спрашиваем вовсе', () => {
    expect(shouldLoadOlder({ state: { ...loaded, exhausted: true }, visibleFrom: 0 })).toBe(false);
  });

  it('вдали от края не спрашиваем', () => {
    expect(
      shouldLoadOlder({ state: loaded, visibleFrom: HISTORY_PREFETCH_MARGIN + 1 }),
    ).toBe(false);
  });

  it('запас срабатывает до того, как пустота видна', () => {
    // Грузить в момент, когда обрыв уже на экране, поздно.
    expect(shouldLoadOlder({ state: loaded, visibleFrom: HISTORY_PREFETCH_MARGIN })).toBe(true);
  });

  it('без загруженных свечей курсора нет', () => {
    expect(
      shouldLoadOlder({ state: emptyCandleHistory('t1', '5m'), visibleFrom: 0 }),
    ).toBe(false);
  });
});

// ───────────────────── Живой край и сброс состояния ─────────────────────────

describe('положение относительно живого края', () => {
  it('у правого края считается живым', () => {
    expect(isAwayFromLive({ visibleTo: 99, total: 100 })).toBe(false);
  });

  it('в прошлом — не живым', () => {
    expect(isAwayFromLive({ visibleTo: 40, total: 100 })).toBe(true);
  });

  it('небольшой отход допускается', () => {
    // Иначе кнопка «К текущей цене» мигала бы от каждого движения.
    expect(isAwayFromLive({ visibleTo: 97, total: 100 })).toBe(false);
  });

  it('пустой график живым краем не считается', () => {
    expect(isAwayFromLive({ visibleTo: 0, total: 0 })).toBe(false);
  });
});

describe('сброс при смене токена и таймфрейма', () => {
  const state = applyHistoryPage(emptyCandleHistory('t1', '5m'), page(1000, 5), null);

  it('тот же ключ сохраняет загруженное', () => {
    const same = historyFor(state, 't1', '5m');

    // Пересоздание на каждый рендер стирало бы историю и курсоры,
    // и подгрузка начиналась бы заново после каждой живой цены.
    expect(same).toBe(state);
  });

  it('смена таймфрейма сбрасывает историю', () => {
    const next = historyFor(state, 't1', '1h')!;

    expect(next.candles).toHaveLength(0);
    expect(next.oldest).toBeNull();
    expect(next.requested.size).toBe(0);
    expect(next.exhausted).toBe(false);
  });

  it('смена токена сбрасывает историю', () => {
    const next = historyFor(state, 't2', '5m')!;

    expect(next.tokenId).toBe('t2');
    expect(next.candles).toHaveLength(0);
  });

  it('без токена состояния нет', () => {
    expect(historyFor(state, null, '5m')).toBeNull();
  });

  it('свечи разных таймфреймов не смешиваются', () => {
    const fiveMin = historyFor(state, 't1', '5m')!;
    const hourly = applyHistoryPage(historyFor(fiveMin, 't1', '1h')!, page(1, 3, 3600), null);

    expect(hourly.interval).toBe('1h');
    expect(hourly.candles.map((c) => c.time)).toEqual([1, 3601, 7201]);
  });
});

// ─────────────────────────── Неудачная страница ─────────────────────────────

describe('ошибка загрузки старой страницы', () => {
  const loaded = applyHistoryPage(emptyCandleHistory('t1', '5m'), page(1000, 5), null);

  it('не стирает уже показанные свечи', () => {
    const failed = markHistoryFailed({ ...loaded, loading: true }, 1000);

    // График остаётся на экране: пропала только возможность уйти левее.
    expect(failed.candles).toHaveLength(5);
    expect(failed.loading).toBe(false);
  });

  it('край замирает до явного повтора', () => {
    const failed = markHistoryFailed(loaded, 1000);

    // Иначе лежащая сеть даёт поток запросов: обработчик зовётся
    // на каждое движение видимого диапазона.
    expect(shouldLoadOlder({ state: failed, visibleFrom: 0 })).toBe(false);
  });

  it('повтор снова открывает край', () => {
    const retried = clearHistoryFailure(markHistoryFailed(loaded, 1000));

    expect(shouldLoadOlder({ state: retried, visibleFrom: 0 })).toBe(true);
  });

  it('неудачный курсор не считается пройденным', () => {
    const failed = markHistoryFailed(loaded, 1000);

    // Попади он в `requested` — повторить было бы нечем.
    expect(failed.requested.has(1000)).toBe(false);
  });

  it('успех после неудачи снимает отметку', () => {
    const failed = markHistoryFailed(loaded, 1000);
    const ok = applyHistoryPage(failed, page(700, 3), 1000);

    expect(ok.failedAt).toBeNull();
  });
});
