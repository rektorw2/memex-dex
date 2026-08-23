import { describe, expect, it } from 'vitest';
import {
  CHART_INTERVALS,
  appendLivePrice,
  chartIntervalSeconds,
  isChartInterval,
  type LiveChartCandle,
} from './chart-live.js';

describe('таймфреймы графика', () => {
  it('совпадают с продуктовым списком и включают секунду', () => {
    expect(CHART_INTERVALS).toEqual(['1s', '5m', '15m', '1h', '4h', '1d']);
    expect(chartIntervalSeconds('1s')).toBe(1);
    expect(chartIntervalSeconds('4h')).toBe(14_400);
    expect(isChartInterval('1m')).toBe(false);
  });
});

describe('живая свеча', () => {
  it('показывает первую фактическую цену без выдуманной истории', () => {
    expect(appendLivePrice([], '0.000882', '2026-08-23T09:03:51.900Z', '1s')).toEqual([
      {
        time: 1_787_475_831,
        open: 0.000882,
        high: 0.000882,
        low: 0.000882,
        close: 0.000882,
        volume: 0,
      },
    ]);
  });

  it('обновляет OHLC внутри того же временного окна', () => {
    const first = appendLivePrice([], 10, 1_787_472_231_000, '5m');
    const high = appendLivePrice(first, 12, 1_787_472_250_000, '5m');
    const close = appendLivePrice(high, 9, 1_787_472_299_000, '5m');

    expect(close).toEqual([
      expect.objectContaining({ open: 10, high: 12, low: 9, close: 9 }),
    ]);
  });

  it('не даёт запоздавшему ответу откатить последнюю свечу', () => {
    const candles: LiveChartCandle[] = [
      { time: 200, open: 2, high: 2, low: 2, close: 2 },
    ];

    expect(appendLivePrice(candles, 1, 100_000, '1s')).toEqual(candles);
  });

  it('ограничивает секундную историю', () => {
    let candles: LiveChartCandle[] = [];
    for (let second = 1; second <= 5; second++) {
      candles = appendLivePrice(candles, second, second * 1_000, '1s', 3);
    }

    expect(candles.map((c) => c.time)).toEqual([3, 4, 5]);
  });

  it('отвергает неизвестный интервал, неверную цену и время', () => {
    const candles: LiveChartCandle[] = [
      { time: 1, open: 1, high: 1, low: 1, close: 1 },
    ];

    expect(appendLivePrice(candles, 2, 2_000, '1m')).toEqual(candles);
    expect(appendLivePrice(candles, 0, 2_000, '1s')).toEqual(candles);
    expect(appendLivePrice(candles, 2, 'not-a-date', '1s')).toEqual(candles);
  });
});
