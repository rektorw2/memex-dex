import { describe, expect, it } from 'vitest';
import {
  PAPER_EXIT_MODES,
  PAPER_EXIT_PRESETS,
  advancePaperExitState,
  describePaperExitPlan,
  evaluatePaperExit,
  initialPaperExitState,
  paperExitPlan,
  paperStopPrice,
  validatePaperExitPlan,
} from './paper-exit.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const T0 = 1_700_000_000_000;

function run(mode: keyof typeof PAPER_EXIT_PRESETS, ticks: Array<[price: number, atMs: number]>) {
  const plan = PAPER_EXIT_PRESETS[mode];
  let state = initialPaperExitState(1, T0);
  const log: string[] = [];
  for (const [price, at] of ticks) {
    if (state.remainingPct <= 0) break;
    const decision = evaluatePaperExit(plan, state, price, T0 + at);
    if (decision.action === 'SELL') log.push(`${decision.reason}:${decision.sellPct}${decision.closes ? ':close' : ''}`);
    state = advancePaperExitState(state, decision, price);
  }
  return { log, state };
}

describe('пресеты выхода', () => {
  it('все пять режимов валидны и различаются', () => {
    for (const mode of PAPER_EXIT_MODES) expect(validatePaperExitPlan(PAPER_EXIT_PRESETS[mode])).toBeNull();
    const described = new Set(PAPER_EXIT_MODES.map((mode) => describePaperExitPlan(PAPER_EXIT_PRESETS[mode])));
    expect(described.size).toBe(5);
  });

  it('TARGET повторяет прежнее поведение: только 2×, без стопа', () => {
    expect(run('TARGET', [[0.3, MINUTE], [0.1, 10 * HOUR], [2, 11 * HOUR]]).log).toEqual(['TARGET_REACHED:100:close']);
  });
});

describe('PROTECTED — стоп и время', () => {
  it('закрывает по стопу −35%', () => {
    expect(run('PROTECTED', [[0.9, MINUTE], [0.66, 2 * MINUTE], [0.64, 3 * MINUTE]]).log).toEqual(['STOP_LOSS:100:close']);
  });

  it('закрывает через 45 минут без +30%', () => {
    const { log } = run('PROTECTED', [[1.2, 44 * MINUTE], [1.2, 45 * MINUTE]]);
    expect(log).toEqual(['TIME_STOP:100:close']);
  });

  it('не трогает позицию, которая через 45 минут уже +30%', () => {
    const { log } = run('PROTECTED', [[1.35, 45 * MINUTE], [1.35, 3 * HOUR]]);
    expect(log).toEqual([]);
  });

  it('закрывает по пределу удержания 4 часа', () => {
    expect(run('PROTECTED', [[1.5, HOUR], [1.5, 4 * HOUR]]).log).toEqual(['MAX_HOLD:100:close']);
  });

  it('цель 2× закрывает целиком', () => {
    expect(run('PROTECTED', [[1.9, MINUTE], [2.01, 2 * MINUTE]]).log).toEqual(['TARGET_REACHED:100:close']);
  });
});

describe('LADDER — ступени, безубыток, трейлинг', () => {
  it('исполняет ступени по порядку и ведёт остаток трейлингом', () => {
    const { log, state } = run('LADDER', [
      [1.6, MINUTE],        // TP1: 40%
      [1.7, 2 * MINUTE],
      [2.0, 3 * MINUTE],    // TP2: 30%, дальше трейлинг −25%
      [2.4, 4 * MINUTE],    // новый пик
      [1.9, 5 * MINUTE],    // 2.4 × 0.75 = 1.8 — ещё держим
      [1.79, 6 * MINUTE],   // ниже 1.8 — трейлинг
    ]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:40', 'TAKE_PROFIT_LEG:30', 'TRAILING_STOP:30:close']);
    expect(state.remainingPct).toBe(0);
  });

  it('после первой ступени стоп переносится в безубыток', () => {
    const { log } = run('LADDER', [[1.6, MINUTE], [1.2, 2 * MINUTE], [0.99, 3 * MINUTE]]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:40', 'BREAKEVEN_STOP:60:close']);
  });

  it('скачок через две ступени продаёт обе доли одной отметкой', () => {
    const { log, state } = run('LADDER', [[2.5, MINUTE]]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:70']);
    expect(state.legsFilled).toBe(2);
    expect(state.remainingPct).toBe(30);
  });

  it('после ступени выход по времени не применяется', () => {
    const { log } = run('LADDER', [[1.6, MINUTE], [1.25, 50 * MINUTE]]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:40']);
  });
});

describe('TRAILING — 50% тела на 2×, остаток по трейлингу −50%', () => {
  it('фиксирует половину на 2× и закрывает остаток при падении на 50% от пика', () => {
    const { log } = run('TRAILING', [
      [2.0, MINUTE],       // 50% тела
      [4.0, 2 * MINUTE],   // пик 4
      [2.1, 3 * MINUTE],   // 4 × 0.5 = 2.0 — держим
      [2.0, 4 * MINUTE],   // ровно стоп — закрываем
    ]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:50', 'TRAILING_STOP:50:close']);
  });

  it('до 2× трейлинг не активен, работает только жёсткий стоп −50%', () => {
    const { log } = run('TRAILING', [[1.9, MINUTE], [1.2, 2 * MINUTE], [0.5, 3 * MINUTE]]);
    expect(log).toEqual(['STOP_LOSS:100:close']);
  });

  it('стоп после первой ступени не ниже входа', () => {
    const plan = PAPER_EXIT_PRESETS.TRAILING;
    const state = { ...initialPaperExitState(1, T0), legsFilled: 1, remainingPct: 50, peakSourcePriceUsd: 2 };
    expect(paperStopPrice(plan, state)?.priceUsd).toBe(1);
  });
});

describe('TRAILING_PURE — трейлинг с входа, тело на 2×', () => {
  it('до 2× стоп идёт за максимумом, а не стоит на −50% от входа', () => {
    // Пик 1.8 → стоп 0.9. TRAILING в той же точке держал бы до 0.5.
    const { log } = run('TRAILING_PURE', [[1.8, MINUTE], [1.2, 2 * MINUTE], [0.9, 3 * MINUTE]]);
    expect(log).toEqual(['TRAILING_STOP:100:close']);
  });

  it('в момент входа трейлинг равен стопу −50%', () => {
    const state = initialPaperExitState(1, T0);
    expect(paperStopPrice(PAPER_EXIT_PRESETS.TRAILING_PURE, state)).toEqual({ priceUsd: 0.5, reason: 'TRAILING_STOP' });
  });

  it('на 2× фиксирует половину, остаток продолжает трейлинг', () => {
    const { log, state } = run('TRAILING_PURE', [[2.0, MINUTE], [3.0, 2 * MINUTE], [1.5, 3 * MINUTE]]);
    expect(log).toEqual(['TAKE_PROFIT_LEG:50', 'TRAILING_STOP:50:close']);
    expect(state.remainingPct).toBe(0);
  });

  it('отличается от TRAILING ровно поведением до 2×', () => {
    const ticks: Array<[number, number]> = [[1.8, MINUTE], [0.95, 2 * MINUTE], [0.55, 3 * MINUTE], [0.45, 4 * MINUTE]];
    expect(run('TRAILING_PURE', ticks).log).toEqual(['TRAILING_STOP:100:close']);
    expect(run('TRAILING', ticks).log).toEqual(['STOP_LOSS:100:close']);
  });
});

describe('приоритет правил', () => {
  it('стоп важнее цели на одной отметке', () => {
    const plan = paperExitPlan('PROTECTED', { stopLossPct: 10, targetMultiple: 1.05 });
    const state = { ...initialPaperExitState(1, T0), peakSourcePriceUsd: 5 };
    // Цена выше цели, но план с трейлингом бы закрыл по стопу; здесь стопа от пика нет,
    // поэтому проверяем сам порядок: при равных условиях сначала стоп.
    const decision = evaluatePaperExit({ ...plan, trailingPct: 50, trailingAfterLeg: 0 }, state, 1.1, T0 + MINUTE);
    expect(decision).toMatchObject({ action: 'SELL', reason: 'TRAILING_STOP' });
  });

  it('нулевая или отрицательная цена — держим и ждём данных', () => {
    const state = initialPaperExitState(1, T0);
    expect(evaluatePaperExit(PAPER_EXIT_PRESETS.PROTECTED, state, 0, T0)).toEqual({ action: 'HOLD' });
  });
});

describe('правки плана', () => {
  it('принимает разумные правки', () => {
    const plan = paperExitPlan('TRAILING', { trailingPct: 40, stopLossPct: 45, maxHoldHours: 8 });
    expect(plan.trailingPct).toBe(40);
    expect(plan.stopLossPct).toBe(45);
    expect(plan.maxHoldMs).toBe(8 * HOUR);
  });

  it('отклоняет план, который никогда не закроется', () => {
    expect(() => paperExitPlan('TARGET', { targetMultiple: null })).toThrow('PLAN_NEVER_CLOSES');
  });

  it('отклоняет ступени больше позиции и стоп вне диапазона', () => {
    expect(() => paperExitPlan('LADDER', { legs: [{ multiple: 1.5, sellPct: 60 }, { multiple: 2, sellPct: 60 }] })).toThrow('LEGS_EXCEED_POSITION');
    expect(() => paperExitPlan('PROTECTED', { stopLossPct: 100 })).toThrow('INVALID_STOP_LOSS');
    expect(() => paperExitPlan('LADDER', { legs: [{ multiple: 2, sellPct: 10 }, { multiple: 1.5, sellPct: 10 }] })).toThrow('LEGS_NOT_ASCENDING');
  });
});
