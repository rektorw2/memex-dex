import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import type { Token } from './types';

/**
 * Подгрузка истории графика: пользовательский путь.
 *
 * Ядро уже проверено на массивах. Здесь проверяется то, что между
 * ядром и человеком: подписка на видимый участок, отправка запроса,
 * сохранение позиции после вставки слева, отмена устаревшего ответа
 * и кнопка возврата к текущей цене.
 *
 * `lightweight-charts` подменена минимальным контрактом: настоящая
 * библиотека рисует в canvas, которого в jsdom нет, а проверяем мы
 * не рисование, а то, какие вызовы к ней уходят и в каком порядке.
 */

/** Что запомнила поддельная библиотека за время теста. */
const chartApi = vi.hoisted(() => ({
  /** Подписчики на изменение видимого участка. */
  rangeSubscribers: [] as Array<(r: { from: number; to: number } | null) => void>,
  visibleRange: null as { from: number; to: number } | null,
  setRangeCalls: [] as Array<{ from: number; to: number }>,
  fitContentCalls: 0,
  scrollToRealTimeCalls: 0,
  setDataCalls: [] as unknown[][],
  updateCalls: [] as unknown[],
  markerCalls: [] as unknown[][],
  visibleTimeRangeCalls: [] as unknown[],
  removed: 0,
  reset() {
    this.rangeSubscribers = [];
    this.visibleRange = null;
    this.setRangeCalls = [];
    this.fitContentCalls = 0;
    this.scrollToRealTimeCalls = 0;
    this.setDataCalls = [];
    this.updateCalls = [];
    this.markerCalls = [];
    this.visibleTimeRangeCalls = [];
    this.removed = 0;
  },
}));

vi.mock('lightweight-charts', () => {
  const timeScale = {
    subscribeVisibleLogicalRangeChange: (fn: (r: { from: number; to: number } | null) => void) => {
      chartApi.rangeSubscribers.push(fn);
    },
    unsubscribeVisibleLogicalRangeChange: (fn: (r: unknown) => void) => {
      chartApi.rangeSubscribers = chartApi.rangeSubscribers.filter((s) => s !== fn);
    },
    getVisibleLogicalRange: () => chartApi.visibleRange,
    setVisibleLogicalRange: (r: { from: number; to: number }) => {
      chartApi.visibleRange = r;
      chartApi.setRangeCalls.push(r);
    },
    setVisibleRange: (r: unknown) => chartApi.visibleTimeRangeCalls.push(r),
    fitContent: () => {
      chartApi.fitContentCalls++;
    },
    scrollToRealTime: () => {
      chartApi.scrollToRealTimeCalls++;
    },
  };

  const series = {
    applyOptions: () => undefined,
    setData: (data: unknown[]) => chartApi.setDataCalls.push(data),
    update: (point: unknown) => chartApi.updateCalls.push(point),
    setMarkers: (markers: unknown[]) => chartApi.markerCalls.push(markers),
  };

  return {
    createChart: () => ({
      timeScale: () => timeScale,
      addLineSeries: () => series,
      addCandlestickSeries: () => series,
      applyOptions: () => undefined,
      remove: () => {
        chartApi.removed++;
      },
    }),
  };
});

// ResizeObserver в jsdom нет, а график его использует.
class FakeResizeObserver {
  observe() {}
  disconnect() {}
}
(globalThis as any).ResizeObserver = FakeResizeObserver;

const { ChartPanel } = await import('./ChartPanel');

const candle = (time: number, close = 1) => ({
  time,
  open: close,
  high: close,
  low: close,
  close,
  volume: 0,
});

const page = (from: number, count: number, step = 300) =>
  Array.from({ length: count }, (_, i) => candle(from + i * step));

const token = (over: Partial<Token> = {}): Token =>
  ({
    id: 'tk-1',
    symbol: 'BONK',
    name: 'Bonk',
    chain: 'SOLANA',
    address: 'BonkKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK',
    priceUsd: '0.0000125',
    priceChange24h: '4.2',
    liquidityUsd: '250000',
    volume24hUsd: '900000',
    fdvUsd: null,
    riskScore: 10,
    logoUrl: null,
    isVerified: false,
    hasChart: true,
    isQuote: false,
    ...over,
  }) as Token;

/** Сдвинуть видимый участок так, как это сделал бы человек мышью. */
async function moveRange(from: number, to: number) {
  chartApi.visibleRange = { from, to };

  await act(async () => {
    for (const fn of [...chartApi.rangeSubscribers]) fn({ from, to });
    // Запрос уходит через микрозадачу: решение и отправка разделены,
    // чтобы обновление состояния не превращалось в побочный эффект.
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => chartApi.reset());
afterEach(cleanup);

const base = page(10_000, 40);

function renderPanel(over: Partial<Parameters<typeof ChartPanel>[0]> = {}) {
  return render(
    <ChartPanel
      token={token()}
      chart={{ state: 'ready', candles: base, live: true }}
      interval="5m"
      onInterval={() => {}}
      showHeader={false}
      {...over}
    />,
  );
}

// ─────────────────── 1–4. Когда уходит запрос, а когда нет ──────────────────

describe('1. приближение к левому краю запускает запрос', () => {
  it('запрос уходит с курсором самой старой свечи', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(7_000, 10), oldest: 7_000 });

    renderPanel({ loadOlder });
    await moveRange(1, 30);

    expect(loadOlder).toHaveBeenCalledOnce();
    // Курсор — время левой свечи текущего набора.
    expect(loadOlder).toHaveBeenCalledWith(10_000);
  });
});

describe('2. середина графика запрос не запускает', () => {
  it('вдали от края ничего не грузится', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: [], oldest: null });

    renderPanel({ loadOlder });
    await moveRange(25, 39);

    expect(loadOlder).not.toHaveBeenCalled();
  });
});

describe('3. один курсор не запрашивается дважды', () => {
  it('повторное приближение к тому же краю запрос не шлёт', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(7_000, 10), oldest: 7_000 });

    renderPanel({ loadOlder });
    await moveRange(1, 30);
    await moveRange(2, 31);
    await moveRange(0, 29);

    // Второй и третий раз левый край уже другой, но курсор 10000
    // отмечен пройденным; новый курсор 7000 ещё не достигнут краем.
    expect(loadOlder.mock.calls.filter(([c]) => c === 10_000)).toHaveLength(1);
  });
});

describe('4. во время активного запроса второй не начинается', () => {
  it('пока страница в пути, новых вызовов нет', async () => {
    let release: (v: unknown) => void = () => {};
    const loadOlder = vi.fn(
      () => new Promise((resolve) => { release = resolve; }),
    );

    renderPanel({ loadOlder: loadOlder as never });

    await moveRange(1, 30);
    await moveRange(0, 29);
    await moveRange(2, 31);

    expect(loadOlder).toHaveBeenCalledOnce();

    await act(async () => {
      release({ candles: page(7_000, 10), oldest: 7_000 });
      await Promise.resolve();
    });
  });
});

// ──────────────── 5–6. Что происходит с данными и позицией ──────────────────

describe('5. старые свечи добавляются без дублей', () => {
  it('перекрытие страниц не удваивает свечи', async () => {
    // Страница перекрывает границу: 9700, 10000, 10300 уже есть.
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(9_400, 4), oldest: 9_400 });

    renderPanel({ loadOlder });
    await moveRange(1, 30);

    const last = chartApi.setDataCalls.at(-1) as Array<{ time: number }>;
    const times = last.map((c) => c.time);

    expect(new Set(times).size).toBe(times.length);
    // Порядок строго возрастающий: библиотека молча ломается иначе.
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe('6. видимый участок сохраняется после вставки слева', () => {
  it('диапазон сдвигается ровно на число добавленных баров', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(7_000, 10), oldest: 7_000 });

    renderPanel({ loadOlder });
    await moveRange(1, 30);

    /*
     * Десять свечей встали слева: логические индексы отсчитываются
     * от начала набора, поэтому обе границы прежнего участка
     * сдвигаются на десять. Без этого график прыгал бы к текущей цене
     * ровно в тот момент, когда человек изучает прошлое.
     */
    expect(chartApi.setRangeCalls.at(-1)).toEqual({ from: 11, to: 40 });
  });

  it('вставка слева не вызывает fitContent', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(7_000, 10), oldest: 7_000 });

    renderPanel({ loadOlder });
    const before = chartApi.fitContentCalls;

    await moveRange(1, 30);

    // `fitContent` показал бы весь набор целиком — то есть увёл бы
    // человека и от его участка, и от масштаба.
    expect(chartApi.fitContentCalls).toBe(before);
  });
});

// ───────────────────── 7–9. Живой край и кнопка возврата ────────────────────

describe('7. живая свеча не возвращает вправо', () => {
  it('пока человек в прошлом, автопрокрутки нет', async () => {
    const view = renderPanel({ loadOlder: vi.fn().mockResolvedValue({ candles: [], oldest: null }) });

    await moveRange(2, 20);
    const before = chartApi.scrollToRealTimeCalls;

    // Пришла новая свеча.
    view.rerender(
      <ChartPanel
        token={token()}
        chart={{ state: 'ready', candles: [...base, candle(22_000)], live: true }}
        interval="5m"
        onInterval={() => {}}
        showHeader={false}
      />,
    );

    expect(chartApi.scrollToRealTimeCalls).toBe(before);
  });
});

describe('8. кнопка появляется после ухода от live', () => {
  it('у правого края кнопки нет', async () => {
    renderPanel();
    await moveRange(20, 39);

    expect(screen.queryByRole('button', { name: 'Вернуться к текущей цене' })).toBeNull();
  });

  it('в прошлом кнопка есть', async () => {
    renderPanel();
    await moveRange(2, 20);

    expect(screen.getByRole('button', { name: 'Вернуться к текущей цене' })).toBeTruthy();
  });

  it('кнопка доступна с клавиатуры и имеет крупную цель', async () => {
    renderPanel();
    await moveRange(2, 20);

    const button = screen.getByRole('button', { name: 'Вернуться к текущей цене' });

    button.focus();
    expect(document.activeElement).toBe(button);
    // 44 пикселя на сенсорном экране.
    expect(button.className).toContain('tap');
    expect(button.className).toContain('motion-reduce:transition-none');
  });
});

describe('9. кнопка возвращает к live и исчезает', () => {
  it('нажатие прокручивает к текущей цене', async () => {
    renderPanel();
    await moveRange(2, 20);

    const before = chartApi.scrollToRealTimeCalls;

    await act(async () => {
      screen.getByRole('button', { name: 'Вернуться к текущей цене' }).click();
    });

    expect(chartApi.scrollToRealTimeCalls).toBe(before + 1);
  });

  it('после возврата к краю кнопка пропадает', async () => {
    renderPanel();
    await moveRange(2, 20);
    expect(screen.getByRole('button', { name: 'Вернуться к текущей цене' })).toBeTruthy();

    // Библиотека сообщает новый участок у правого края.
    await moveRange(20, 39);

    expect(screen.queryByRole('button', { name: 'Вернуться к текущей цене' })).toBeNull();
  });
});

// ───────────────── 10–12. Конец истории, сброс и отмена ─────────────────────

describe('10. пустая страница останавливает пагинацию', () => {
  it('после конца истории запросов больше нет', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: [], oldest: null });

    renderPanel({ loadOlder });
    await moveRange(1, 30);
    await moveRange(0, 29);
    await moveRange(-2, 27);

    expect(loadOlder).toHaveBeenCalledOnce();
  });
});

describe('11. смена таймфрейма сбрасывает историю', () => {
  it('после переключения курсор берётся заново', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: page(7_000, 10), oldest: 7_000 });

    const view = renderPanel({ loadOlder });
    await moveRange(1, 30);
    expect(loadOlder).toHaveBeenCalledWith(10_000);

    // Часовик: свои свечи, свой курсор, чужие страницы недопустимы.
    const hourly = page(50_000, 30, 3_600);

    view.rerender(
      <ChartPanel
        token={token()}
        chart={{ state: 'ready', candles: hourly, live: true }}
        interval="1h"
        onInterval={() => {}}
        showHeader={false}
        loadOlder={loadOlder}
      />,
    );

    await moveRange(1, 25);

    expect(loadOlder).toHaveBeenLastCalledWith(50_000);
  });
});

describe('12. смена токена отменяет старый результат', () => {
  it('страница прежнего токена не попадает в новый график', async () => {
    let release: (v: unknown) => void = () => {};
    const loadOlder = vi.fn(() => new Promise((resolve) => { release = resolve; }));

    const view = renderPanel({ loadOlder: loadOlder as never });
    await moveRange(1, 30);

    const other = page(80_000, 20);

    view.rerender(
      <ChartPanel
        token={token({ id: 'tk-2', symbol: 'WIF' })}
        chart={{ state: 'ready', candles: other, live: true }}
        interval="5m"
        onInterval={() => {}}
        showHeader={false}
        loadOlder={loadOlder as never}
      />,
    );

    // Ответ по прежнему токену приходит уже после переключения.
    await act(async () => {
      release({ candles: page(7_000, 10), oldest: 7_000 });
      await Promise.resolve();
      await Promise.resolve();
    });

    const last = chartApi.setDataCalls.at(-1) as Array<{ time: number }>;

    // Свечи прежнего токена в новом графике недопустимы.
    expect(last.some((c) => c.time === 7_000)).toBe(false);
    expect(last[0]!.time).toBe(80_000);
  });
});

// ──────────────────── 13–14. Ошибка и секундный график ──────────────────────

describe('13. ошибка старой страницы не удаляет текущие свечи', () => {
  it('график остаётся, появляется компактный повтор', async () => {
    const loadOlder = vi.fn().mockRejectedValue(new Error('сеть'));

    renderPanel({ loadOlder });
    await moveRange(1, 30);

    const last = chartApi.setDataCalls.at(-1) as unknown[];

    expect(last).toHaveLength(base.length);
    expect(screen.getByRole('button', { name: /Повторить/ })).toBeTruthy();
  });

  it('после ошибки запросы не сыплются потоком', async () => {
    const loadOlder = vi.fn().mockRejectedValue(new Error('сеть'));

    renderPanel({ loadOlder });
    await moveRange(1, 30);
    await moveRange(0, 29);
    await moveRange(2, 31);

    // Иначе лежащая сеть даёт по запросу на каждое движение мыши.
    expect(loadOlder).toHaveBeenCalledOnce();
  });

  it('повтор по кнопке отправляет тот же курсор', async () => {
    const loadOlder = vi.fn().mockRejectedValue(new Error('сеть'));

    renderPanel({ loadOlder });
    await moveRange(1, 30);

    await act(async () => {
      screen.getByRole('button', { name: /Повторить/ }).click();
      await Promise.resolve();
    });

    expect(loadOlder).toHaveBeenCalledTimes(2);
    expect(loadOlder).toHaveBeenLastCalledWith(10_000);
  });
});

describe('14. секундный график не зацикливается', () => {
  it('пустая история останавливает пагинацию и на 1s', async () => {
    const loadOlder = vi.fn().mockResolvedValue({ candles: [], oldest: null });

    render(
      <ChartPanel
        token={token()}
        chart={{ state: 'ready', candles: page(10_000, 40, 1), live: true }}
        interval="1s"
        onInterval={() => {}}
        showHeader={false}
        loadOlder={loadOlder}
      />,
    );

    for (let i = 0; i < 5; i++) await moveRange(1 - i, 30 - i);

    // Старшей истории у секундного ряда нет: один отказ — и всё.
    expect(loadOlder).toHaveBeenCalledOnce();
  });
});

describe('15. persisted PAPER BUY/SELL markers', () => {
  const markers = [
    { id: 'run-1:buy', side: 'BUY' as const, time: 10_000, strategyLabel: 'Baseline', priceUsd: 1, pnlUsd: null },
    { id: 'run-2:buy', side: 'BUY' as const, time: 10_000, strategyLabel: 'Shadow', priceUsd: 1.01, pnlUsd: null },
    { id: 'run-1:sell', side: 'SELL' as const, time: 10_300, strategyLabel: 'Baseline', priceUsd: 2, pnlUsd: 94.8 },
  ];

  it('несколько стратегий одной свечи не затирают друг друга и имеют текстовый список', () => {
    renderPanel({ markers });
    expect(chartApi.markerCalls.at(-1)).toHaveLength(3);
    expect(chartApi.markerCalls.at(-1)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'run-1:buy', text: expect.stringContaining('PAPER BUY') }),
      expect.objectContaining({ id: 'run-2:buy', text: expect.stringContaining('Shadow') }),
      expect.objectContaining({ id: 'run-1:sell', text: expect.stringContaining('PAPER SELL') }),
    ]));
    expect(screen.getByRole('list', { name: 'События paper-агента' }).children).toHaveLength(3);
  });

  it('смена таймфрейма восстанавливает markers на новой series', () => {
    const view = renderPanel({ markers });
    view.rerender(<ChartPanel token={token()} chart={{ state: 'ready', candles: base }} interval="15m" onInterval={() => {}} markers={markers} />);
    expect(chartApi.markerCalls.at(-1)).toHaveLength(3);
    expect(chartApi.markerCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('выбор сделки прокручивает график к её persisted времени', () => {
    renderPanel({ markers, focusMarkerId: 'run-1:sell' });
    expect(chartApi.visibleTimeRangeCalls.at(-1)).toMatchObject({ from: expect.any(Number), to: expect.any(Number) });
  });
});
