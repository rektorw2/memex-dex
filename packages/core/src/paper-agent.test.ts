import { describe, expect, it } from 'vitest';
import {
  PAPER_AGENT_STRATEGIES,
  evaluatePaperSignal,
  markPaperPosition,
  normalizePaperAgentNetwork,
  openPaperPosition,
  paperAgentHealthState,
  paperAgentMarkerTime,
  paperDrawdownPct,
  paperAgentModeVerdict,
  percentile,
} from './paper-agent.js';

const baseline = PAPER_AGENT_STRATEGIES[0]!;
const NOW = Date.UTC(2026, 7, 26, 12);

const signal = (overrides: Record<string, unknown> = {}) => ({
  network: 'SOLANA',
  walletTypes: ['smart_money'] as const,
  amountUsd: 5_000,
  signaledAtMs: NOW - 5_000,
  poolCreatedAtMs: NOW - 10 * 60_000,
  priceUsd: 0.001,
  ...overrides,
});

describe('paper agent — решение', () => {
  it('ни одна стратегия не может запустить агента в live-режиме', () => {
    for (const strategy of PAPER_AGENT_STRATEGIES) {
      expect(strategy.key).toBeTruthy();
      expect(paperAgentModeVerdict('live')).toEqual({
        ok: false,
        reason: 'PAPER_AGENT_REQUIRES_EXECUTION_MODE_PAPER',
      });
    }
    expect(paperAgentModeVerdict('paper')).toEqual({ ok: true });
  });

  it.each(['smart_money', 'kol', 'whale'] as const)('принимает сигнал %s', (type) => {
    expect(evaluatePaperSignal(baseline, signal({ walletTypes: [type] }), NOW).code).toBe(
      'ELIGIBLE',
    );
  });

  it.each(['SOLANA', 'Solana', 'solana-mainnet', 'solana_mainnet_beta', '501', 501])(
    'нормализует Solana из %s',
    (network) => {
      expect(normalizePaperAgentNetwork(network)).toBe('SOLANA');
      expect(evaluatePaperSignal(baseline, signal({ network }), NOW).code).toBe('ELIGIBLE');
    },
  );

  it.each(['BASE', 'BNB', 'ETHEREUM', '8453', '56', '1', '', 'unknown', null])(
    'пропускает неподдерживаемую сеть %s',
    (network) => {
      expect(evaluatePaperSignal(baseline, signal({ network }), NOW).code).toBe(
        'NETWORK_NOT_SUPPORTED_PHASE_2',
      );
    },
  );

  it('принимает ровно $5k и отклоняет сумму ниже порога', () => {
    expect(evaluatePaperSignal(baseline, signal({ amountUsd: 5_000 }), NOW).code).toBe('ELIGIBLE');
    expect(evaluatePaperSignal(baseline, signal({ amountUsd: 4_999.99 }), NOW).code).toBe(
      'AMOUNT_BELOW_THRESHOLD',
    );
  });

  it('принимает ровно 15 минут и отклоняет более старый пул', () => {
    expect(
      evaluatePaperSignal(baseline, signal({ poolCreatedAtMs: NOW - 15 * 60_000 }), NOW).code,
    ).toBe('ELIGIBLE');
    expect(
      evaluatePaperSignal(baseline, signal({ poolCreatedAtMs: NOW - 15 * 60_000 - 1 }), NOW)
        .code,
    ).toBe('TOKEN_TOO_OLD');
  });

  it('не подменяет неизвестный возраст временем записи в нашей базе', () => {
    expect(evaluatePaperSignal(baseline, signal({ poolCreatedAtMs: null }), NOW).code).toBe(
      'TOKEN_AGE_UNKNOWN',
    );
  });

  it('ждёт цену только до дедлайна', () => {
    expect(evaluatePaperSignal(baseline, signal({ priceUsd: null }), NOW).state).toBe(
      'WAITING_PRICE',
    );
    expect(
      evaluatePaperSignal(
        baseline,
        signal({ priceUsd: null, signaledAtMs: NOW - 30_001 }),
        NOW,
      ).code,
    ).toBe('PRICE_UNAVAILABLE_BEFORE_DEADLINE');
  });

  it('отклоняет запоздалое решение даже при наличии цены', () => {
    expect(
      evaluatePaperSignal(baseline, signal({ signaledAtMs: NOW - 30_001 }), NOW).code,
    ).toBe('DECISION_DEADLINE_EXCEEDED');
  });

  it('shadow задержки не заглядывает в будущую цену', () => {
    const delayed = PAPER_AGENT_STRATEGIES.find((s) => s.key.endsWith('delay-10s'))!;
    expect(
      evaluatePaperSignal(delayed, signal({ signaledAtMs: NOW - 9_999 }), NOW).state,
    ).toBe('WAITING_ENTRY');
    expect(evaluatePaperSignal(delayed, signal({ signaledAtMs: NOW - 10_000 }), NOW).code).toBe(
      'ELIGIBLE',
    );
  });

  it('не принимает неизвестный тип сигнала', () => {
    expect(evaluatePaperSignal(baseline, signal({ walletTypes: [] }), NOW).code).toBe(
      'UNSUPPORTED_SIGNAL_TYPE',
    );
  });
});

describe('paper agent — позиция', () => {
  it('открывает ровно бумажные $100 с консервативным проскальзыванием', () => {
    const entry = openPaperPosition(baseline, 2)!;
    expect(entry.positionUsd).toBe(100);
    expect(entry.executionPriceUsd).toBeCloseTo(2.02);
    expect(entry.targetSourcePriceUsd).toBe(4);
    expect(entry.entryTradingFeeUsd).toBeCloseTo(0.3);
    expect(entry.entryNetworkFeeUsd).toBe(0.02);
    expect(entry.entrySlippageUsd).toBeGreaterThan(0);
    expect(entry.quantity * entry.executionPriceUsd + entry.entryFeeUsd).toBeCloseTo(100);
  });

  it('закрывает только при достижении 2x и считает net PnL', () => {
    const entry = openPaperPosition(baseline, 2)!;
    expect(markPaperPosition(baseline, entry, 3.99)?.shouldClose).toBe(false);
    const exit = markPaperPosition(baseline, entry, 4)!;
    expect(exit.shouldClose).toBe(true);
    expect(exit.multiple).toBe(2);
    expect(exit.pnlUsd).toBeCloseTo(94.8060404);
    expect(exit.totalCostsUsd).toBeGreaterThan(3);
  });

  it('учитывает комиссию обеих сторон, когда она настроена', () => {
    const withFee = {
      ...baseline,
      tradeFeeBps: 50,
      entrySlippageBps: 0,
      exitSlippageBps: 0,
      networkFeeUsdPerSide: 0,
    };
    const entry = openPaperPosition(withFee, 1)!;
    const exit = markPaperPosition(withFee, entry, 2)!;
    expect(entry.entryFeeUsd).toBeCloseTo(0.5);
    expect(exit.exitFeeUsd).toBeCloseTo(0.995);
    expect(exit.pnlUsd).toBeCloseTo(98.005);
  });

  it('снимок старой модели не меняется после обновления настроек', () => {
    const original = openPaperPosition(baseline, 1)!;
    const changed = { ...baseline, tradeFeeBps: 500, networkFeeUsdPerSide: 1 };

    expect(markPaperPosition(baseline, original, 2)?.pnlUsd).toBeCloseTo(94.8060404);
    expect(markPaperPosition(changed, original, 2)?.pnlUsd).not.toBeCloseTo(94.8060404);
  });

  it('не выдумывает позицию или отметку без цены', () => {
    expect(openPaperPosition(baseline, 0)).toBeNull();
    const entry = openPaperPosition(baseline, 1)!;
    expect(markPaperPosition(baseline, entry, Number.NaN)).toBeNull();
  });

  it('считает просадку и перцентили без подстановки нулей', () => {
    expect(paperDrawdownPct(2, 1.5)).toBe(25);
    expect(paperDrawdownPct(0, 1)).toBeNull();
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85);
  });
});

describe('paper agent — состояние и график', () => {
  const health = (overrides: Record<string, unknown> = {}) =>
    paperAgentHealthState({
      executionMode: 'paper',
      enabled: true,
      socketHealthy: true,
      waitingForPrice: 0,
      queued: 0,
      lastActivityAtMs: null,
      nowMs: NOW,
      ...overrides,
    } as never);

  it('различает OFF, STANDBY, ACTIVE, DEGRADED и REFUSED', () => {
    expect(health({ enabled: false })).toBe('OFF');
    expect(health()).toBe('STANDBY');
    expect(health({ queued: 1 })).toBe('ACTIVE');
    expect(health({ socketHealthy: false })).toBe('DEGRADED');
    expect(health({ executionMode: 'live' })).toBe('REFUSED');
  });

  it('привязывает BUY/SELL к началу свечи на каждом таймфрейме', () => {
    const event = Date.UTC(2026, 7, 26, 12, 7, 42, 999);
    expect(paperAgentMarkerTime(event, '1s')).toBe(Date.UTC(2026, 7, 26, 12, 7, 42) / 1_000);
    expect(paperAgentMarkerTime(event, '5m')).toBe(Date.UTC(2026, 7, 26, 12, 5) / 1_000);
    expect(paperAgentMarkerTime(event, '1h')).toBe(Date.UTC(2026, 7, 26, 12) / 1_000);
    expect(paperAgentMarkerTime(event, 'bad')).toBeNull();
  });
});
