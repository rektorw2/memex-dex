import { describe, it, expect } from 'vitest';
import {
  chartState,
  chartStateRetryable,
  chartStateWillResolve,
  CHART_STATE_TEXT,
  type ChartState,
} from './chart-state.js';

/**
 * Почему графика нет.
 *
 * Одно сообщение на все случаи врало в большинстве из них: «не найден
 * пул ликвидности» показывалось у токена с пулом на 184 тысячи,
 * потому что пул был, а свечей не было. Человек читал это как
 * «токен мёртвый» и уходил.
 */

const base = {
  hasPool: true,
  supported: true,
  candleCount: 0,
  hasAnyCandles: false,
};

describe('состояние графика', () => {
  it('свечи есть — график готов', () => {
    expect(chartState({ ...base, candleCount: 120, hasAnyCandles: true })).toBe('ready');
  });

  it('нет пула — пул ещё определяется', () => {
    expect(chartState({ ...base, hasPool: false })).toBe('pool-pending');
  });

  it('пул есть, свечей нет нигде — стоят в очереди', () => {
    // Тот самый случай: пул на 184 тысячи, а сообщение говорило,
    // что пула нет.
    expect(chartState({ ...base, hasPool: true, hasAnyCandles: false })).toBe('candles-queued');
  });

  it('свечи есть по другим интервалам — пустой период', () => {
    // По этому интервалу сделок не было, а загрузка дошла.
    expect(chartState({ ...base, hasAnyCandles: true, candleCount: 0 })).toBe('empty-period');
  });

  it('сеть не поддерживается — ждать бесполезно', () => {
    expect(chartState({ ...base, supported: false })).toBe('unsupported');
  });

  it('ошибка важнее всех остальных причин', () => {
    // При упавшем запросе про пул и свечи ничего не известно,
    // и объяснять отсутствие данных отсутствием пула было бы догадкой.
    expect(chartState({ ...base, hasPool: false, supported: false, failed: true })).toBe('failed');
  });

  it('неподдерживаемая сеть важнее отсутствия пула', () => {
    // Пул может появиться, поддержка — нет.
    expect(chartState({ ...base, hasPool: false, supported: false })).toBe('unsupported');
  });
});

describe('что делать с состоянием', () => {
  it('повторять имеет смысл только после ошибки', () => {
    expect(chartStateRetryable('failed')).toBe(true);

    for (const s of [
      'ready',
      'pool-pending',
      'candles-queued',
      'unsupported',
      'empty-period',
    ] as ChartState[]) {
      expect(chartStateRetryable(s), s).toBe(false);
    }
  });

  it('само разрешится только ожидание', () => {
    expect(chartStateWillResolve('pool-pending')).toBe(true);
    expect(chartStateWillResolve('candles-queued')).toBe(true);

    // Крутящийся индикатор у неподдерживаемой сети обещал бы то,
    // чего не будет.
    expect(chartStateWillResolve('unsupported')).toBe(false);
    expect(chartStateWillResolve('empty-period')).toBe(false);
    expect(chartStateWillResolve('failed')).toBe(false);
  });
});

describe('тексты', () => {
  it('у каждого состояния есть свой', () => {
    const states: ChartState[] = [
      'ready',
      'pool-pending',
      'candles-queued',
      'unsupported',
      'empty-period',
      'failed',
    ];

    for (const s of states) expect(CHART_STATE_TEXT[s], s).toBeDefined();
  });

  it('тексты различаются: в этом весь смысл', () => {
    const texts = Object.entries(CHART_STATE_TEXT)
      .filter(([k]) => k !== 'ready')
      .map(([, v]) => v);

    expect(new Set(texts).size).toBe(texts.length);
  });

  it('ни один не утверждает отсутствие пула без основания', () => {
    // Про пул говорит ровно одно состояние — то, которое про пул.
    for (const [state, text] of Object.entries(CHART_STATE_TEXT)) {
      if (state === 'pool-pending') continue;
      expect(text.toLowerCase(), state).not.toContain('пул');
    }
  });
});
