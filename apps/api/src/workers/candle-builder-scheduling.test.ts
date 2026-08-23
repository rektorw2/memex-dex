import { beforeEach, describe, expect, it } from 'vitest';
import {
  candleRefreshDue,
  priorityIntervalsForTests,
  priorityQueueSize,
  requestCandlesSoon,
  resetPriorityForTests,
} from './candle-builder.js';

beforeEach(() => resetPriorityForTests());

describe('планирование свечей', () => {
  it('не принимает время открытия дневной свечи за время последнего запроса', () => {
    const now = Date.parse('2026-08-23T12:00:00.000Z');
    const opened = new Date('2026-08-23T00:00:00.000Z');

    // Свеча текущего дня уже есть. После рестарта не нужно пять раз
    // спрашивать её заново только потому, что открылась в полночь.
    expect(candleRefreshDue('1d', opened, null, now)).toBe(false);
  });

  it('обновляет текущую формирующуюся свечу по частоте синхронизации', () => {
    const now = Date.parse('2026-08-23T12:00:00.000Z');
    const opened = new Date('2026-08-23T08:00:00.000Z');

    expect(candleRefreshDue('4h', opened, now - 60 * 60_000, now)).toBe(false);
    expect(candleRefreshDue('4h', opened, now - 2 * 60 * 60_000, now)).toBe(true);
  });

  it('догружает отсутствующий текущий период', () => {
    const now = Date.parse('2026-08-23T12:07:00.000Z');
    const old = new Date('2026-08-23T11:55:00.000Z');

    expect(candleRefreshDue('5m', old, null, now)).toBe(true);
    expect(candleRefreshDue('5m', null, null, now)).toBe(true);
  });

  it('при открытии графика ставит в приоритет только выбранные интервалы', () => {
    requestCandlesSoon('token-1', '5m');
    requestCandlesSoon('token-1', '1h');

    expect(priorityQueueSize()).toBe(1);
    expect(priorityIntervalsForTests('token-1')).toEqual(['5m', '1h']);
  });

  it('не принимает неизвестный интервал в очередь', () => {
    requestCandlesSoon('token-1', '2m');
    expect(priorityQueueSize()).toBe(0);
  });
});
