/**
 * Единый контракт таймфреймов между API и интерфейсом.
 *
 * `1s` — живой интервал: он собирается из наблюдений текущей цены,
 * потому что исторический поставщик начинает с минутных свечей.
 * Остальные интервалы дополняют сохранённую историю последней
 * наблюдаемой ценой, чтобы текущая свеча не замирала до следующего
 * фонового импорта.
 */
export const CHART_INTERVALS = ['1s', '5m', '15m', '1h', '4h', '1d'] as const;

export type ChartInterval = (typeof CHART_INTERVALS)[number];

const INTERVAL_SECONDS: Readonly<Record<ChartInterval, number>> = {
  '1s': 1,
  '5m': 5 * 60,
  '15m': 15 * 60,
  '1h': 60 * 60,
  '4h': 4 * 60 * 60,
  '1d': 24 * 60 * 60,
};

export interface LiveChartCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export function isChartInterval(value: string): value is ChartInterval {
  return CHART_INTERVALS.includes(value as ChartInterval);
}

export function chartIntervalSeconds(value: string): number | null {
  return isChartInterval(value) ? INTERVAL_SECONDS[value] : null;
}

function epochSeconds(value: string | number | Date | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date
    ? value.getTime()
    : typeof value === 'number'
      ? value
      : Date.parse(value);

  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.floor(ms / 1000);
}

/**
 * Добавить реальную наблюдаемую цену в текущую свечу.
 *
 * Никакой прошлой истории функция не выдумывает: если сохранённых
 * свечей нет, на графике появляется одна текущая точка. Дальше она
 * растёт из следующих наблюдений, а история поставщика подставляется
 * отдельно, когда успевает загрузиться.
 */
export function appendLivePrice(
  candles: readonly LiveChartCandle[],
  priceValue: string | number | null | undefined,
  observedAt: string | number | Date | null | undefined,
  interval: string,
  limit = 300,
): LiveChartCandle[] {
  const width = chartIntervalSeconds(interval);
  const price = Number(priceValue);
  const observed = epochSeconds(observedAt);

  if (width == null || !Number.isFinite(price) || price <= 0 || observed == null) {
    return [...candles];
  }

  const bucket = Math.floor(observed / width) * width;
  const previous = candles.at(-1);

  // Запоздавшее наблюдение не имеет права переписывать более свежую
  // свечу: ответы двух запросов могут прийти в обратном порядке.
  if (previous && previous.time > bucket) return [...candles];

  const next = [...candles];
  if (previous?.time === bucket) {
    next[next.length - 1] = {
      ...previous,
      high: Math.max(previous.high, price),
      low: Math.min(previous.low, price),
      close: price,
    };
  } else {
    next.push({
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    });
  }

  const bounded = Math.max(1, Math.min(1_000, Math.trunc(limit) || 300));
  return next.slice(-bounded);
}
