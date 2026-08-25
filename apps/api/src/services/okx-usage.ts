/**
 * Учёт вызовов OKX.
 *
 * ─── Зачем ──────────────────────────────────────────────────────────
 *
 * Квота расходовалась вслепую. Никто не мог ответить на вопрос
 * «сколько мы тратим и на что», и поэтому никто не заметил, что
 * горячий цикл цен звал Premium раз в секунду: восемьдесят шесть тысяч
 * вызовов в сутки при месячной квоте в сто тысяч.
 *
 * ─── Что здесь считается ────────────────────────────────────────────
 *
 * Каждый вызов — по endpoint, по квоте, по источнику и по исходу.
 * Разрез по источнику нужен не для отчётности: по нему принимается
 * решение, кого притормозить у предела, и без него притормозить можно
 * только всех сразу.
 *
 * ─── Чем это не является ────────────────────────────────────────────
 *
 * Балансом OKX. Остаток квоты через API не сообщается; здесь наши
 * собственные вызовы с момента запуска процесса. Счётчик не видит
 * второй экземпляр приложения и обнуляется при перезапуске Render.
 *
 * Поэтому в диагностике он подписан как локальная оценка. Разница
 * не педантизм: приняв оценку за факт, легко решить «квота ещё есть»
 * ровно тогда, когда её уже нет.
 */

import {
  budgetDecision,
  budgetThresholds,
  forecastBudget,
  okxPlanQuota,
  okxTierOf,
  parseOkxPlan,
  slowdownFactor,
  type BudgetDecision,
  type OkxCallPurpose,
  type OkxTier,
} from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export type OkxCallOutcome = 'ok' | 'empty' | 'error' | 'rate-limit' | 'payment-required';

interface EndpointStats {
  tier: OkxTier;
  calls: number;
  ok: number;
  empty: number;
  error: number;
  rateLimited: number;
  paymentRequired: number;
}

const byEndpoint = new Map<string, EndpointStats>();
const byPurpose = new Map<OkxCallPurpose, number>();

/** Расход по квотам. Свободные endpoint сюда не попадают вовсе. */
const spent: Record<'basic' | 'premium', number> = { basic: 0, premium: 0 };

let observingSince = Date.now();

/** Сколько раз бюджет отказал — по этому числу видно, что мы у предела. */
let refusals = 0;

function statsFor(path: string): EndpointStats {
  const key = path.split('?')[0]!;
  let s = byEndpoint.get(key);

  if (!s) {
    s = {
      tier: okxTierOf(key),
      calls: 0,
      ok: 0,
      empty: 0,
      error: 0,
      rateLimited: 0,
      paymentRequired: 0,
    };
    byEndpoint.set(key, s);
  }

  return s;
}

/**
 * Учесть вызов.
 *
 * Считается сам факт обращения, а не успех: отказ провайдера квоту
 * тоже расходует — по крайней мере, мы не можем утверждать обратное,
 * и осторожнее считать, что расходует.
 */
export function recordOkxCall(
  path: string,
  purpose: OkxCallPurpose,
  outcome: OkxCallOutcome,
): void {
  const s = statsFor(path);
  s.calls++;

  if (outcome === 'ok') s.ok++;
  else if (outcome === 'empty') s.empty++;
  else if (outcome === 'rate-limit') s.rateLimited++;
  else if (outcome === 'payment-required') s.paymentRequired++;
  else s.error++;

  byPurpose.set(purpose, (byPurpose.get(purpose) ?? 0) + 1);

  if (s.tier !== 'free') spent[s.tier]++;
}

/** Текущий план из настроек. Неизвестное значение читается как Free. */
export function currentOkxPlan() {
  return parseOkxPlan(env.OKX_PLAN);
}

function thresholdsFor(tier: 'basic' | 'premium') {
  const quota = okxPlanQuota(currentOkxPlan());
  return budgetThresholds(tier, tier === 'basic' ? quota.basic : quota.premium);
}

/**
 * Можно ли потратить вызов.
 *
 * Спрашивается до запроса, а не после: смысл резерва в том, чтобы
 * фоновая работа не съела последние проценты, а не в том, чтобы
 * узнать об этом задним числом.
 */
export function canSpendOkxCall(path: string, purpose: OkxCallPurpose): BudgetDecision {
  const tier = okxTierOf(path);
  if (tier === 'free') return { allow: true, slow: false };

  const decision = budgetDecision({
    tier,
    purpose,
    used: spent[tier],
    thresholds: thresholdsFor(tier),
  });

  if (!decision.allow) {
    refusals++;

    // Одна строка на переход, а не на вызов: у предела запросов много,
    // и заливать журнал одинаковыми записями значит спрятать в них
    // всё остальное.
    if (refusals === 1 || refusals % 100 === 0) {
      logger.warn(
        { tier, purpose, used: spent[tier], refusals, reason: decision.reason },
        'OKX: бюджет не позволяет фоновый вызов',
      );
    }
  }

  return decision;
}

/** Во сколько раз замедлить фоновый цикл этой квоты. */
export function okxSlowdown(tier: 'basic' | 'premium'): number {
  return slowdownFactor(spent[tier], thresholdsFor(tier));
}

/**
 * Снимок для диагностики.
 *
 * Подписан явно: это счётчик MEMEX с момента последнего сброса,
 * а не остаток по данным OKX.
 */
export function okxUsageSnapshot() {
  const plan = currentOkxPlan();
  const quota = okxPlanQuota(plan);
  const observedMs = Date.now() - observingSince;

  return {
    source: 'Локальный счётчик MEMEX с момента последнего сброса. ' +
      'Не является балансом OKX: остаток квоты провайдер через API не сообщает.',
    plan,
    websocketSupported: quota.websocket,
    observedSinceMs: observedMs,
    refusals,

    basic: {
      ...forecastBudget({ used: spent.basic, quota: quota.basic, observedMs }),
      thresholds: thresholdsFor('basic'),
    },
    premium: {
      ...forecastBudget({ used: spent.premium, quota: quota.premium, observedMs }),
      thresholds: thresholdsFor('premium'),
    },

    byEndpoint: [...byEndpoint.entries()]
      .map(([endpoint, s]) => ({ endpoint, ...s }))
      .sort((a, b) => b.calls - a.calls),

    byPurpose: [...byPurpose.entries()]
      .map(([purpose, calls]) => ({ purpose, calls }))
      .sort((a, b) => b.calls - a.calls),
  };
}

export function resetOkxUsageForTests(): void {
  byEndpoint.clear();
  byPurpose.clear();
  spent.basic = 0;
  spent.premium = 0;
  refusals = 0;
  observingSince = Date.now();
}

/** Только для тестов: подставить расход, не делая запросов. */
export function seedOkxUsageForTests(tier: 'basic' | 'premium', used: number): void {
  spent[tier] = used;
}
