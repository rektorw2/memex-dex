import { describe, expect, it } from 'vitest';
import {
  PAPER_AGENT_DECISION_CODES,
  PAPER_AGENT_STRATEGIES,
  evaluatePaperSignal,
  type PaperAgentDecisionCode,
  type PaperAgentStrategy,
} from './paper-agent.js';

/**
 * Полнота PAPER-режима: каждый объявленный исход достижим и проверен.
 *
 * Здесь закрывается разрыв, который тип не мог показать. Кодов
 * исходов одиннадцать; девять из них назывались в тестах, а два —
 * `WAITING_FOR_PRICE` и `WAITING_FOR_ENTRY_DELAY` — не назывались
 * нигде. Второй к тому же недостижим ни одной из поставляемых
 * стратегий: у всех четырёх `entryDelayMs: 0`.
 *
 * Это не придирка к покрытию. Непроверенная ветка решения — это
 * ветка, про которую никто не знает, что она делает; а решает она,
 * входить ли в позицию.
 *
 * Тип проверить нельзя: он исчезает при компиляции. Поэтому рядом
 * с ним живёт список значений, и полнота проверяется по нему.
 */

const baseline = PAPER_AGENT_STRATEGIES[0]!;
const NOW = Date.UTC(2026, 8, 5, 12);

/** Стратегия с ненулевой паузой входа. Поставляемые её не имеют. */
const delayed: PaperAgentStrategy = { ...baseline, entryDelayMs: 10_000 };

const signal = (overrides: Record<string, unknown> = {}) => ({
  network: 'SOLANA',
  walletTypes: ['smart_money'] as string[],
  amountUsd: 5_000,
  signaledAtMs: NOW - 5_000,
  receivedAtMs: NOW - 100,
  origin: 'WEBSOCKET_LIVE' as const,
  poolCreatedAtMs: NOW - 10 * 60_000,
  priceUsd: 0.001,
  ...overrides,
});

/**
 * Сценарий на каждый исход.
 *
 * Таблица, а не набор отдельных тестов: только так тест полноты
 * может сравнить её ключи с объявленным списком.
 */
const SCENARIOS: Record<
  PaperAgentDecisionCode,
  { strategy: PaperAgentStrategy; signal: ReturnType<typeof signal>; expectedState: string }
> = {
  ELIGIBLE: { strategy: baseline, signal: signal(), expectedState: 'ELIGIBLE' },

  // Цена ещё не пришла, но дедлайн решения не истёк: это ожидание,
  // а не отказ, и позиция позже всё-таки может открыться.
  WAITING_FOR_PRICE: {
    strategy: baseline,
    signal: signal({ priceUsd: null }),
    expectedState: 'WAITING_PRICE',
  },

  // Стратегия просит выждать паузу после сигнала. Ни одна из
  // поставляемых так не настроена — ветка жила непроверенной.
  WAITING_FOR_ENTRY_DELAY: {
    strategy: delayed,
    signal: signal({ signaledAtMs: NOW - 1_000 }),
    expectedState: 'WAITING_ENTRY',
  },

  UNSUPPORTED_SIGNAL_TYPE: {
    strategy: baseline,
    signal: signal({ walletTypes: ['sniper'] }),
    expectedState: 'SKIPPED',
  },

  AMOUNT_BELOW_THRESHOLD: {
    strategy: baseline,
    signal: signal({ amountUsd: baseline.minAmountUsd - 1 }),
    expectedState: 'SKIPPED',
  },

  TOKEN_AGE_UNKNOWN: {
    strategy: baseline,
    signal: signal({ poolCreatedAtMs: null }),
    expectedState: 'SKIPPED',
  },

  TOKEN_TOO_OLD: {
    strategy: baseline,
    signal: signal({ poolCreatedAtMs: NOW - baseline.maxTokenAgeMs - 1 }),
    expectedState: 'SKIPPED',
  },

  NETWORK_NOT_SUPPORTED_PHASE_2: {
    strategy: baseline,
    signal: signal({ network: 'BSC' }),
    expectedState: 'SKIPPED',
  },

  INVALID_SIGNAL_TIMESTAMPS: {
    // Получено раньше, чем отправлено. Считать это нулевой задержкой
    // значило бы выдумать цифру вместо признания противоречия.
    strategy: baseline,
    signal: signal({ receivedAtMs: NOW + 1 }),
    expectedState: 'SKIPPED',
  },

  DECISION_DEADLINE_EXCEEDED: {
    // Цена есть, но решение опоздало.
    strategy: baseline,
    signal: signal({ signaledAtMs: NOW - baseline.maxDecisionLatencyMs - 1 }),
    expectedState: 'SKIPPED',
  },

  PRICE_UNAVAILABLE_BEFORE_DEADLINE: {
    // Тот же дедлайн, но цены так и не было: причина другая, и
    // называть её тем же кодом нельзя — это разные поломки.
    strategy: baseline,
    signal: signal({ priceUsd: null, signaledAtMs: NOW - baseline.maxDecisionLatencyMs - 1 }),
    expectedState: 'SKIPPED',
  },
};

describe('каждый исход решения достижим', () => {
  for (const code of PAPER_AGENT_DECISION_CODES) {
    it(`${code}`, () => {
      const scenario = SCENARIOS[code];
      const decision = evaluatePaperSignal(scenario.strategy, scenario.signal as never, NOW);

      expect(decision.code).toBe(code);
      expect(decision.state).toBe(scenario.expectedState);
    });
  }
});

describe('полнота таблицы сценариев', () => {
  it('сценарий есть у каждого объявленного исхода', () => {
    /*
     * Контракт против повторения разрыва: добавить исход и забыть
     * сценарий теперь нельзя. Сравниваются не два рукописных списка
     * — один список берётся из кода решения, другой из таблицы выше.
     */
    expect(Object.keys(SCENARIOS).sort()).toEqual([...PAPER_AGENT_DECISION_CODES].sort());
  });

  it('лишних исходов в таблице нет', () => {
    for (const code of Object.keys(SCENARIOS)) {
      expect(PAPER_AGENT_DECISION_CODES).toContain(code);
    }
  });

  it('каждый сценарий даёт свой исход, а не чужой', () => {
    // Иначе таблица могла бы состоять из одиннадцати одинаковых
    // случаев, и тест полноты прошёл бы на пустом месте.
    const produced = new Set(
      Object.values(SCENARIOS).map(
        (scenario) => evaluatePaperSignal(scenario.strategy, scenario.signal as never, NOW).code,
      ),
    );

    expect(produced.size).toBe(PAPER_AGENT_DECISION_CODES.length);
  });
});

describe('ожидание и отказ — разные состояния', () => {
  it('ожидание цены оставляет сигнал живым', () => {
    /*
     * `WAITING_PRICE` и `SKIPPED` — не оттенки одного и того же.
     * Первое означает «вернёмся к этому», второе — «решение принято
     * и оно отрицательное». Смешать их значит либо потерять входы,
     * либо вечно держать в очереди то, что уже отклонено.
     */
    const waiting = evaluatePaperSignal(baseline, signal({ priceUsd: null }) as never, NOW);
    const refused = evaluatePaperSignal(
      baseline,
      signal({ priceUsd: null, signaledAtMs: NOW - baseline.maxDecisionLatencyMs - 1 }) as never,
      NOW,
    );

    expect(waiting.state).toBe('WAITING_PRICE');
    expect(refused.state).toBe('SKIPPED');
  });

  it('пауза входа кончается, и сигнал становится пригодным', () => {
    // Ожидание должно быть конечным: иначе это отказ, который
    // никогда не называет себя отказом.
    const early = evaluatePaperSignal(delayed, signal({ signaledAtMs: NOW - 1_000 }) as never, NOW);
    const ready = evaluatePaperSignal(
      delayed,
      signal({ signaledAtMs: NOW - delayed.entryDelayMs }) as never,
      NOW,
    );

    expect(early.code).toBe('WAITING_FOR_ENTRY_DELAY');
    expect(ready.code).toBe('ELIGIBLE');
  });

  it('пауза входа не отменяет дедлайн решения', () => {
    /*
     * Худшее сочетание: стратегия просит подождать дольше, чем
     * разрешено думать. Побеждать должен дедлайн — иначе пауза
     * входа стала бы способом обойти ограничение задержки.
     */
    const conflicting: PaperAgentStrategy = { ...baseline, entryDelayMs: 60_000 };
    const decision = evaluatePaperSignal(
      conflicting,
      signal({ signaledAtMs: NOW - baseline.maxDecisionLatencyMs - 1 }) as never,
      NOW,
    );

    expect(decision.code).toBe('DECISION_DEADLINE_EXCEEDED');
  });
});
