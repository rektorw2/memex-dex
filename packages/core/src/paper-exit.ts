/**
 * Правила выхода из PAPER-позиции.
 *
 * До этого модуля у позиции был один способ закрыться — цена дошла
 * до цели. Ни стоп-лосса, ни выхода по времени, ни частичной
 * фиксации: просадка счёта останавливала только новые входы, а
 * открытая позиция ждала цель хоть сутки. Для мем-токена Solana,
 * который за час может обнулиться, это не стратегия, а надежда.
 *
 * Здесь — чистая математика без базы и без времени системы: на вход
 * план, состояние позиции, цена и «сейчас»; на выход — что сделать.
 * Адаптер применяет решение к счёту и записывает его. Так правило
 * существует в одном месте, и его можно проверить таблицей сценариев.
 *
 * Порядок проверок на каждой отметке цены — от защиты к прибыли:
 *   1. стоп (жёсткий, безубыток или трейлинг) — защита капитала;
 *   2. время (нет движения / слишком долго) — защита от «зависания»;
 *   3. ступени фиксации — частичная прибыль;
 *   4. цель — полный выход.
 * Если на одной отметке сработали и стоп, и ступень, побеждает стоп:
 * цена, которая одновременно ниже стопа и выше ступени, невозможна,
 * а при равенстве важнее не потерять.
 */

export type PaperExitMode = 'TARGET' | 'PROTECTED' | 'LADDER' | 'TRAILING' | 'TRAILING_PURE';

export type PaperExitReason =
  | 'TARGET_REACHED'
  | 'TAKE_PROFIT_LEG'
  | 'STOP_LOSS'
  | 'BREAKEVEN_STOP'
  | 'TRAILING_STOP'
  | 'TIME_STOP'
  | 'MAX_HOLD'
  | 'MANUAL_PANIC'
  | 'DRAWDOWN_BREAKER';

export const PAPER_EXIT_REASONS: readonly PaperExitReason[] = [
  'TARGET_REACHED',
  'TAKE_PROFIT_LEG',
  'STOP_LOSS',
  'BREAKEVEN_STOP',
  'TRAILING_STOP',
  'TIME_STOP',
  'MAX_HOLD',
  'MANUAL_PANIC',
  'DRAWDOWN_BREAKER',
];

export interface PaperExitLeg {
  /** Кратное от цены входа, при котором ступень исполняется. */
  multiple: number;
  /** Доля ИСХОДНОЙ позиции, которая продаётся на этой ступени, в процентах. */
  sellPct: number;
}

export interface PaperExitPlan {
  mode: PaperExitMode;
  version: 1;
  /**
   * Кратное полного выхода. `null` — полной цели нет: остаток ведёт
   * трейлинг или стоп (режимы LADDER и TRAILING).
   */
  targetMultiple: number | null;
  /** Жёсткий стоп от цены входа, в процентах падения. `null` — стопа нет. */
  stopLossPct: number | null;
  /** Ступени частичной фиксации, по возрастанию `multiple`. */
  legs: readonly PaperExitLeg[];
  /**
   * Трейлинг-стоп: допустимое падение от лучшей цены, в процентах.
   * Включается после того, как исполнено `trailingAfterLeg` ступеней
   * (0 — с самого входа).
   */
  trailingPct: number | null;
  trailingAfterLeg: number;
  /** После скольких ступеней стоп переносится в безубыток. `null` — никогда. */
  breakevenAfterLeg: number | null;
  /**
   * Выход по времени: если через `afterMs` после входа позиция не
   * достигла `minMultiple`, она закрывается. Ловит «мёртвые» токены,
   * которые не растут и не падают до стопа.
   */
  timeStop: { afterMs: number; minMultiple: number } | null;
  /** Абсолютный предел удержания. */
  maxHoldMs: number | null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/**
 * Пять режимов выхода — пять разных ответов на вопрос «что делать,
 * если цена пошла не туда».
 *
 * TARGET — прежнее поведение, оставлено как контрольная точка: без
 * него нельзя сказать, помогает ли защита или только режет прибыль.
 */
export const PAPER_EXIT_PRESETS: Record<PaperExitMode, PaperExitPlan> = {
  TARGET: {
    mode: 'TARGET',
    version: 1,
    targetMultiple: 2,
    stopLossPct: null,
    legs: [],
    trailingPct: null,
    trailingAfterLeg: 0,
    breakevenAfterLeg: null,
    timeStop: null,
    maxHoldMs: null,
  },
  PROTECTED: {
    mode: 'PROTECTED',
    version: 1,
    targetMultiple: 2,
    stopLossPct: 35,
    legs: [],
    trailingPct: null,
    trailingAfterLeg: 0,
    breakevenAfterLeg: null,
    timeStop: { afterMs: 45 * MINUTE, minMultiple: 1.3 },
    maxHoldMs: 4 * HOUR,
  },
  LADDER: {
    mode: 'LADDER',
    version: 1,
    targetMultiple: null,
    stopLossPct: 35,
    legs: [
      { multiple: 1.6, sellPct: 40 },
      { multiple: 2, sellPct: 30 },
    ],
    trailingPct: 25,
    trailingAfterLeg: 2,
    breakevenAfterLeg: 1,
    timeStop: { afterMs: 45 * MINUTE, minMultiple: 1.3 },
    maxHoldMs: 4 * HOUR,
  },
  TRAILING: {
    mode: 'TRAILING',
    version: 1,
    targetMultiple: null,
    stopLossPct: 50,
    legs: [{ multiple: 2, sellPct: 50 }],
    trailingPct: 50,
    trailingAfterLeg: 1,
    breakevenAfterLeg: 1,
    timeStop: null,
    maxHoldMs: 6 * HOUR,
  },
  /*
   * Чистый трейлинг: стоп идёт за максимумом с первой секунды, а не
   * после 2×. Отдельного жёсткого стопа нет — в момент входа трейлинг
   * от входа и есть стоп −50%, а дальше он только поднимается. Тело
   * фиксируется на 2× так же, как в TRAILING; разница — в том, что
   * происходит до 2×: TRAILING держит −50% от входа, этот режим
   * подтягивает стоп за ростом и не отдаёт уже полученное.
   */
  TRAILING_PURE: {
    mode: 'TRAILING_PURE',
    version: 1,
    targetMultiple: null,
    stopLossPct: null,
    legs: [{ multiple: 2, sellPct: 50 }],
    trailingPct: 50,
    trailingAfterLeg: 0,
    breakevenAfterLeg: 1,
    timeStop: null,
    maxHoldMs: 6 * HOUR,
  },
};

export const PAPER_EXIT_MODES: readonly PaperExitMode[] = ['TARGET', 'PROTECTED', 'LADDER', 'TRAILING', 'TRAILING_PURE'];

export const PAPER_EXIT_MODE_LABELS: Record<PaperExitMode, { label: string; summary: string }> = {
  TARGET: { label: 'Цель 2×', summary: 'Только полный выход на 2×. Без стопа — контрольный режим.' },
  PROTECTED: { label: 'Защищённый', summary: 'Стоп −35%, выход через 45 мин без +30%, не дольше 4 ч, цель 2×.' },
  LADDER: { label: 'Лестница', summary: '40% на +60%, 30% на 2×, остаток по трейлингу −25%; стоп −35%, безубыток после первой ступени.' },
  TRAILING: { label: 'Трейлинг', summary: 'На 2× фиксируется 50% тела, остаток ведёт трейлинг-стоп −50% от максимума.' },
  TRAILING_PURE: { label: 'Чистый трейлинг', summary: 'Трейлинг-стоп −50% от максимума с самого входа; на 2× фиксируется 50% тела, остаток продолжает трейлинг.' },
};

export interface PaperExitOverrides {
  targetMultiple?: number | null;
  stopLossPct?: number | null;
  trailingPct?: number | null;
  timeStopMinutes?: number | null;
  timeStopMinMultiple?: number | null;
  maxHoldHours?: number | null;
  legs?: readonly PaperExitLeg[];
}

/**
 * План из режима и правок. Правки проверяются, а не принимаются на
 * веру: план с суммой ступеней больше 100% или стопом выше входа
 * закрыл бы позицию в первую же секунду.
 */
export function paperExitPlan(mode: PaperExitMode, overrides: PaperExitOverrides = {}): PaperExitPlan {
  const base = PAPER_EXIT_PRESETS[mode];
  const plan: PaperExitPlan = {
    ...base,
    legs: overrides.legs ?? base.legs,
    targetMultiple: overrides.targetMultiple === undefined ? base.targetMultiple : overrides.targetMultiple,
    stopLossPct: overrides.stopLossPct === undefined ? base.stopLossPct : overrides.stopLossPct,
    trailingPct: overrides.trailingPct === undefined ? base.trailingPct : overrides.trailingPct,
    timeStop:
      overrides.timeStopMinutes === undefined && overrides.timeStopMinMultiple === undefined
        ? base.timeStop
        : overrides.timeStopMinutes === null
          ? null
          : {
              afterMs: (overrides.timeStopMinutes ?? (base.timeStop?.afterMs ?? 45 * MINUTE) / MINUTE) * MINUTE,
              minMultiple: overrides.timeStopMinMultiple ?? base.timeStop?.minMultiple ?? 1.3,
            },
    maxHoldMs:
      overrides.maxHoldHours === undefined
        ? base.maxHoldMs
        : overrides.maxHoldHours === null
          ? null
          : overrides.maxHoldHours * HOUR,
  };
  const problem = validatePaperExitPlan(plan);
  if (problem) throw new Error(problem);
  return plan;
}

export function validatePaperExitPlan(plan: PaperExitPlan): string | null {
  if (!PAPER_EXIT_MODES.includes(plan.mode)) return 'INVALID_EXIT_MODE';
  if (plan.targetMultiple != null && !(plan.targetMultiple > 1)) return 'INVALID_TARGET_MULTIPLE';
  if (plan.stopLossPct != null && !(plan.stopLossPct > 0 && plan.stopLossPct < 100)) return 'INVALID_STOP_LOSS';
  if (plan.trailingPct != null && !(plan.trailingPct > 0 && plan.trailingPct < 100)) return 'INVALID_TRAILING';
  if (!Number.isInteger(plan.trailingAfterLeg) || plan.trailingAfterLeg < 0 || plan.trailingAfterLeg > plan.legs.length) return 'INVALID_TRAILING_LEG';
  if (plan.breakevenAfterLeg != null && (!Number.isInteger(plan.breakevenAfterLeg) || plan.breakevenAfterLeg < 1 || plan.breakevenAfterLeg > plan.legs.length)) return 'INVALID_BREAKEVEN_LEG';
  let sold = 0;
  let previous = 1;
  for (const leg of plan.legs) {
    if (!(leg.multiple > previous)) return 'LEGS_NOT_ASCENDING';
    if (!(leg.sellPct > 0 && leg.sellPct <= 100)) return 'INVALID_LEG_SIZE';
    if (plan.targetMultiple != null && leg.multiple >= plan.targetMultiple) return 'LEG_ABOVE_TARGET';
    sold += leg.sellPct;
    previous = leg.multiple;
  }
  if (sold > 100 + 1e-9) return 'LEGS_EXCEED_POSITION';
  if (plan.timeStop != null && (!(plan.timeStop.afterMs > 0) || !(plan.timeStop.minMultiple >= 1))) return 'INVALID_TIME_STOP';
  if (plan.maxHoldMs != null && !(plan.maxHoldMs > 0)) return 'INVALID_MAX_HOLD';
  if (plan.timeStop != null && plan.maxHoldMs != null && plan.timeStop.afterMs > plan.maxHoldMs) return 'TIME_STOP_AFTER_MAX_HOLD';
  /*
   * Без цели, без ступеней на 100 % и без трейлинга/стопа позиция не
   * закроется никогда. Такой план — не «агрессивный», а бесконечный.
   */
  const closesEventually =
    plan.targetMultiple != null || sold >= 100 - 1e-9 || plan.trailingPct != null ||
    plan.stopLossPct != null || plan.maxHoldMs != null;
  if (!closesEventually) return 'PLAN_NEVER_CLOSES';
  return null;
}

/** Состояние позиции, которое нужно правилу выхода. Хранится адаптером. */
export interface PaperExitState {
  entrySourcePriceUsd: number;
  entryAtMs: number;
  /** Лучшая цена с момента входа. */
  peakSourcePriceUsd: number;
  legsFilled: number;
  /** Доля исходной позиции, которая ещё открыта, в процентах. */
  remainingPct: number;
}

export function initialPaperExitState(entrySourcePriceUsd: number, entryAtMs: number): PaperExitState {
  return {
    entrySourcePriceUsd,
    entryAtMs,
    peakSourcePriceUsd: entrySourcePriceUsd,
    legsFilled: 0,
    remainingPct: 100,
  };
}

export type PaperExitDecision =
  | { action: 'HOLD' }
  | {
      action: 'SELL';
      reason: PaperExitReason;
      /** Доля ИСХОДНОЙ позиции к продаже, в процентах. */
      sellPct: number;
      /** Доля ТЕКУЩЕГО остатка к продаже, 0..1 — то, что применяет адаптер. */
      fractionOfRemaining: number;
      /** `true` — после продажи позиция закрыта целиком. */
      closes: boolean;
      /** Сколько ступеней исполнено после этой продажи. */
      legsFilledAfter: number;
    };

/**
 * Действующий стоп для остатка позиции: максимум из жёсткого стопа,
 * безубытка и трейлинга. Стоп не опускается: если трейлинг поднял
 * его выше жёсткого, жёсткий больше не имеет значения.
 */
export function paperStopPrice(plan: PaperExitPlan, state: PaperExitState): { priceUsd: number; reason: PaperExitReason } | null {
  const candidates: Array<{ priceUsd: number; reason: PaperExitReason }> = [];
  if (plan.stopLossPct != null) {
    candidates.push({ priceUsd: state.entrySourcePriceUsd * (1 - plan.stopLossPct / 100), reason: 'STOP_LOSS' });
  }
  if (plan.breakevenAfterLeg != null && state.legsFilled >= plan.breakevenAfterLeg) {
    candidates.push({ priceUsd: state.entrySourcePriceUsd, reason: 'BREAKEVEN_STOP' });
  }
  if (plan.trailingPct != null && state.legsFilled >= plan.trailingAfterLeg) {
    candidates.push({ priceUsd: state.peakSourcePriceUsd * (1 - plan.trailingPct / 100), reason: 'TRAILING_STOP' });
  }
  if (!candidates.length) return null;
  return candidates.reduce((best, item) => (item.priceUsd > best.priceUsd ? item : best));
}

export function evaluatePaperExit(
  plan: PaperExitPlan,
  state: PaperExitState,
  sourcePriceUsd: number,
  nowMs: number,
): PaperExitDecision {
  if (!(sourcePriceUsd > 0) || !(state.remainingPct > 0)) return { action: 'HOLD' };
  const sellAll = (reason: PaperExitReason): PaperExitDecision => ({
    action: 'SELL',
    reason,
    sellPct: state.remainingPct,
    fractionOfRemaining: 1,
    closes: true,
    legsFilledAfter: state.legsFilled,
  });

  /*
   * Пик для трейлинга берётся ДО учёта текущей цены. Иначе трейлинг
   * от свежего максимума никогда не сработает на той же отметке, а
   * это и не нужно: новая вершина — не сигнал продавать.
   */
  const stop = paperStopPrice(plan, state);
  if (stop && sourcePriceUsd <= stop.priceUsd) return sellAll(stop.reason);

  const multiple = sourcePriceUsd / state.entrySourcePriceUsd;
  const held = nowMs - state.entryAtMs;
  if (plan.maxHoldMs != null && held >= plan.maxHoldMs) return sellAll('MAX_HOLD');
  if (plan.timeStop != null && held >= plan.timeStop.afterMs && multiple < plan.timeStop.minMultiple && state.legsFilled === 0) {
    return sellAll('TIME_STOP');
  }

  /*
   * Ступени, до которых цена дошла на этой отметке, исполняются все
   * сразу: при скачке цены через две ступени продаётся сумма долей,
   * а не одна ступень за тик. Иначе вторая ступень исполнилась бы
   * секундой позже по уже другой цене.
   */
  let legsFilled = state.legsFilled;
  let sellPct = 0;
  while (legsFilled < plan.legs.length && multiple >= plan.legs[legsFilled]!.multiple) {
    sellPct += plan.legs[legsFilled]!.sellPct;
    legsFilled += 1;
  }
  if (sellPct > 0) {
    const bounded = Math.min(sellPct, state.remainingPct);
    const closes = state.remainingPct - bounded <= 1e-9;
    return {
      action: 'SELL',
      reason: 'TAKE_PROFIT_LEG',
      sellPct: bounded,
      fractionOfRemaining: closes ? 1 : bounded / state.remainingPct,
      closes,
      legsFilledAfter: legsFilled,
    };
  }

  if (plan.targetMultiple != null && multiple >= plan.targetMultiple) return sellAll('TARGET_REACHED');
  return { action: 'HOLD' };
}

/** Состояние после исполнения решения и новой отметки цены. */
export function advancePaperExitState(
  state: PaperExitState,
  decision: PaperExitDecision,
  sourcePriceUsd: number,
): PaperExitState {
  const peakSourcePriceUsd = Math.max(state.peakSourcePriceUsd, sourcePriceUsd);
  if (decision.action === 'HOLD') return { ...state, peakSourcePriceUsd };
  return {
    ...state,
    peakSourcePriceUsd,
    legsFilled: decision.legsFilledAfter,
    remainingPct: decision.closes ? 0 : Math.max(0, state.remainingPct - decision.sellPct),
  };
}

/** Короткое описание плана для интерфейса и журнала. */
export function describePaperExitPlan(plan: PaperExitPlan): string {
  const parts: string[] = [];
  if (plan.legs.length) parts.push(plan.legs.map((leg) => `${leg.sellPct}% на ${leg.multiple}×`).join(', '));
  if (plan.targetMultiple != null) parts.push(`цель ${plan.targetMultiple}×`);
  if (plan.stopLossPct != null) parts.push(`стоп −${plan.stopLossPct}%`);
  if (plan.trailingPct != null) parts.push(`трейлинг −${plan.trailingPct}%${plan.trailingAfterLeg > 0 ? ` после ${plan.trailingAfterLeg}-й ступени` : ''}`);
  if (plan.breakevenAfterLeg != null) parts.push(`безубыток после ${plan.breakevenAfterLeg}-й ступени`);
  if (plan.timeStop) parts.push(`выход через ${Math.round(plan.timeStop.afterMs / MINUTE)} мин без ${plan.timeStop.minMultiple}×`);
  if (plan.maxHoldMs != null) parts.push(`не дольше ${Math.round(plan.maxHoldMs / HOUR * 10) / 10} ч`);
  return parts.join(' · ');
}

/* ───────────────── Какие режимы доступны в каком управлении ───────────────── */

export type LiveAgentControlMode = 'semi-auto' | 'auto';

/**
 * Semi-auto — человек подтверждает каждое предложение, и правило
 * выхода у него одно: полный выход на 2× (режим TARGET как есть,
 * без стопа — это подтверждённое решение владельца, а не догадка).
 * Auto — все режимы. Правило одно для интерфейса и для API: интерфейс
 * прячет лишние карточки, а сервер отклоняет прямой запрос с
 * недоступным режимом. Смена режима управления не переписывает план
 * уже открытых позиций: он снят при входе и лежит на позиции.
 */
export function allowedExitModes(controlMode: LiveAgentControlMode): readonly PaperExitMode[] {
  return controlMode === 'auto' ? PAPER_EXIT_MODES : ['TARGET'];
}

export function isExitModeAllowed(controlMode: LiveAgentControlMode, mode: PaperExitMode): boolean {
  return allowedExitModes(controlMode).includes(mode);
}

/**
 * Допустим ли итоговый план в режиме управления.
 *
 * Имени режима недостаточно: «Цель 2×» с `targetMultiple: 3` и
 * трейлингом — уже не «Цель 2×». Полуавтомат допускает пресет
 * ровно в том виде, в каком он записан в `PAPER_EXIT_PRESETS`, —
 * сравнивается сам план, а не то, как его назвали. В авто любой
 * корректный план любого из пяти режимов.
 */
export function exitPlanAllowed(controlMode: LiveAgentControlMode, plan: PaperExitPlan): { ok: true } | { ok: false; code: 'EXIT_MODE_NOT_ALLOWED' | 'EXIT_PRESET_MODIFIED'; message: string } {
  if (!isExitModeAllowed(controlMode, plan.mode)) {
    return { ok: false, code: 'EXIT_MODE_NOT_ALLOWED', message: `Режим выхода ${plan.mode} недоступен в ${controlMode}` };
  }
  if (controlMode === 'auto') return { ok: true };
  const preset = PAPER_EXIT_PRESETS[plan.mode];
  const same = plan.targetMultiple === preset.targetMultiple
    && plan.stopLossPct === preset.stopLossPct
    && plan.trailingPct === preset.trailingPct
    && JSON.stringify(plan.legs) === JSON.stringify(preset.legs)
    && JSON.stringify(plan.timeStop) === JSON.stringify(preset.timeStop)
    && plan.maxHoldMs === preset.maxHoldMs;
  return same
    ? { ok: true }
    : { ok: false, code: 'EXIT_PRESET_MODIFIED', message: `В режиме ${controlMode} правило «Цель 2×» применяется без изменений: цель, стоп, трейлинг и ступени менять нельзя` };
}
