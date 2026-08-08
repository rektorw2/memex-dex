import { describe, it, expect } from 'vitest';
import { evaluateTrigger, validateQuote, requiredLock } from './orders.js';

describe('срабатывание отложенных ордеров', () => {
  it('BUY-лимитка ждёт падения цены до лимита', () => {
    const o = { id: '1', side: 'BUY' as const, type: 'LIMIT' as const, limitPriceUsd: 0.05 };
    expect(evaluateTrigger(o, 0.08).action).toBe('hold');
    expect(evaluateTrigger(o, 0.05).action).toBe('execute');
    expect(evaluateTrigger(o, 0.04).action).toBe('execute');
  });

  it('SELL-лимитка ждёт роста цены до лимита', () => {
    const o = { id: '2', side: 'SELL' as const, type: 'LIMIT' as const, limitPriceUsd: 0.5 };
    expect(evaluateTrigger(o, 0.4).action).toBe('hold');
    expect(evaluateTrigger(o, 0.5).action).toBe('execute');
  });

  it('стоп-лосс срабатывает при падении', () => {
    const o = { id: '3', side: 'SELL' as const, type: 'STOP_LOSS' as const, triggerPriceUsd: 0.02 };
    expect(evaluateTrigger(o, 0.03).action).toBe('hold');
    expect(evaluateTrigger(o, 0.019).action).toBe('execute');
  });

  it('тейк-профит срабатывает при росте', () => {
    const o = { id: '4', side: 'SELL' as const, type: 'TAKE_PROFIT' as const, triggerPriceUsd: 1 };
    expect(evaluateTrigger(o, 0.9).action).toBe('hold');
    expect(evaluateTrigger(o, 1.2).action).toBe('execute');
  });

  it('trailing stop поднимает пик и срабатывает от него', () => {
    const base = { id: '5', side: 'SELL' as const, type: 'TRAILING_STOP' as const, trailingBps: 2000 };

    const up = evaluateTrigger({ ...base, peakPriceUsd: 1 }, 2);
    expect(up.action).toBe('update_peak');
    if (up.action === 'update_peak') expect(up.peakPriceUsd.toString()).toBe('2');

    // пик 2, трейлинг 20% => стоп на 1.6
    expect(evaluateTrigger({ ...base, peakPriceUsd: 2 }, 1.7).action).toBe('hold');
    expect(evaluateTrigger({ ...base, peakPriceUsd: 2 }, 1.6).action).toBe('execute');
  });

  it('истекший ордер не исполняется', () => {
    const o = {
      id: '6', side: 'BUY' as const, type: 'LIMIT' as const,
      limitPriceUsd: 100, expiresAt: new Date('2020-01-01'),
    };
    expect(evaluateTrigger(o, 1).action).toBe('expire');
  });

  it('не исполняет при отсутствии цены', () => {
    const o = { id: '7', side: 'BUY' as const, type: 'LIMIT' as const, limitPriceUsd: 1 };
    expect(evaluateTrigger(o, 0).action).toBe('hold');
  });
});

describe('валидация котировки перед отправкой', () => {
  it('пропускает котировку в пределах проскальзывания', () => {
    const v = validateQuote({ expectedOut: 1000, quotedOut: 995, slippageBps: 100 });
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.minOut.toString()).toBe('985.05'); // 995 * 0.99
  });

  it('отклоняет котировку хуже допуска', () => {
    const v = validateQuote({ expectedOut: 1000, quotedOut: 900, slippageBps: 100 });
    expect(v.ok).toBe(false);
  });

  it('отклоняет чрезмерный price impact', () => {
    const v = validateQuote({
      expectedOut: 1000, quotedOut: 1000, slippageBps: 300,
      priceImpactBps: 4000, maxPriceImpactBps: 1500,
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('price impact');
  });

  it('отклоняет пустой маршрут', () => {
    expect(validateQuote({ expectedOut: 100, quotedOut: 0, slippageBps: 100 }).ok).toBe(false);
  });
});

describe('резервирование средств', () => {
  it('блокирует неисполненный остаток', () => {
    expect(requiredLock({ amountIn: 100, filledIn: 30 }).toString()).toBe('70');
    expect(requiredLock({ amountIn: 100 }).toString()).toBe('100');
    expect(requiredLock({ amountIn: 100, filledIn: 100 }).toString()).toBe('0');
  });
});
