/**
 * Четыре независимые оценки кошелька вместо одного числа.
 *
 * Прежняя единая оценка отвечала сразу на несколько вопросов и потому
 * ни на один — внятно. Кошелёк-снайпер, входящий в первом блоке
 * с проскальзыванием в сорок процентов, получал высокий балл наравне
 * с кошельком, чьи сделки может повторить кто угодно. Для человека,
 * который собирается копировать, это разные вещи.
 *
 * Теперь их четыре, и каждая отвечает на свой вопрос:
 *
 *   Smart Score  — насколько хорошо кошелёк торгует;
 *   Copyability  — можно ли это повторить;
 *   Risk         — чем он рискует и во что вляпывался;
 *   Confidence   — сколько за этим наблюдений.
 *
 * Их нельзя складывать и нельзя выводить одно из другого. Высокий
 * Smart Score при нулевой Copyability — обычное сочетание, и прятать
 * его за средним значением значит вводить в заблуждение ровно там,
 * где решение стоит денег.
 */

import { wilsonLowerBound } from './wallet-score.js';
import type { WalletPnl, Position } from './position-ledger.js';

// ─────────────────────────── Настройки ──────────────────────────────────────

export interface ScoreConfig {
  /** Веса составляющих Smart Score. Сумма — единица. */
  weights: {
    realized: number;
    consistency: number;
    discovery: number;
    winRate: number;
    riskManagement: number;
    organic: number;
  };
  /** Затухание по времени: вес сделок по давности. */
  decay: { last30d: number; days31to90: number; older: number };
  /**
   * Доля прибыли от одной сделки, выше которой стабильность падает.
   *
   * Шестьдесят процентов: если больше половины заработка пришло
   * с одной позиции, остальные сделки к результату почти не относятся,
   * и называть это стабильностью нельзя.
   */
  concentrationPenaltyAt: number;
  /** Границы доходности при усечении выбросов. */
  winsorizeRoi: { min: number; max: number };
}

export const DEFAULT_SCORE_CONFIG: ScoreConfig = {
  weights: {
    realized: 0.25,
    consistency: 0.2,
    discovery: 0.2,
    winRate: 0.15,
    riskManagement: 0.1,
    organic: 0.1,
  },
  decay: { last30d: 0.6, days31to90: 0.3, older: 0.1 },
  concentrationPenaltyAt: 0.6,
  // Одна сделка на сто концов не должна тянуть среднее вверх:
  // усечение сверху делает влияние выброса конечным.
  winsorizeRoi: { min: -1, max: 5 },
};

// ─────────────────────────── Уверенность ────────────────────────────────────

export type ConfidenceLevel = 'none' | 'low' | 'medium' | 'high' | 'conflict';

/**
 * Пороги выборки.
 *
 * Прежний порог высокой уверенности в пятнадцать сделок был низким:
 * на пятнадцати наблюдениях доля попаданий всё ещё гуляет на десяток
 * процентов от одной новой сделки. Пятьдесят — величина, при которой
 * оценка описывает поведение, а не последовательность совпадений.
 */
export const CONFIDENCE_THRESHOLDS = {
  minForScore: 5,
  low: 5,
  medium: 15,
  high: 50,
} as const;

export interface ConfidenceInput {
  closedPositions: number;
  /** Средняя уверенность разбора сделок, 0–1. */
  parsingConfidence?: number;
  /** Сколько независимых источников подтвердили кошелёк. */
  sourceCount?: number;
  /**
   * Расхождение результата между источниками, доля.
   * Выше порога — данные считаются спорными.
   */
  sourceDisagreement?: number | null;
  /** Доля операций, которые не удалось объяснить. */
  unexplainedShare?: number;
}

export const MAX_SOURCE_DISAGREEMENT = 0.25;

export interface ConfidenceResult {
  level: ConfidenceLevel;
  label: string;
  /** Показывать ли числовую оценку вообще. */
  showScore: boolean;
  detail: string;
}

export function assessConfidence(input: ConfidenceInput): ConfidenceResult {
  const n = input.closedPositions;

  // Расхождение источников важнее размера выборки: спорное число
  // нельзя показывать как достоверное, сколько бы наблюдений
  // за ним ни стояло.
  if (
    input.sourceDisagreement != null &&
    input.sourceDisagreement > MAX_SOURCE_DISAGREEMENT
  ) {
    return {
      level: 'conflict',
      label: 'Данные проверяются',
      showScore: false,
      detail:
        `Источники расходятся на ${Math.round(input.sourceDisagreement * 100)}%. ` +
        'Пока расхождение не разобрано, показывать оценку было бы враньём.',
    };
  }

  if (n < CONFIDENCE_THRESHOLDS.minForScore) {
    return {
      level: 'none',
      label: 'Собираем историю',
      showScore: false,
      detail: `${n} из ${CONFIDENCE_THRESHOLDS.minForScore} завершённых позиций для первой оценки`,
    };
  }

  if (n < CONFIDENCE_THRESHOLDS.medium) {
    return {
      level: 'low',
      label: 'Низкая уверенность',
      showScore: true,
      detail: `${n} завершённых позиций — одна удача заметно двигает оценку`,
    };
  }

  if (n < CONFIDENCE_THRESHOLDS.high) {
    return {
      level: 'medium',
      label: 'Средняя уверенность',
      showScore: true,
      detail: `${n} завершённых позиций — выборка рабочая, но ещё короткая`,
    };
  }

  return {
    level: 'high',
    label: 'Высокая уверенность',
    showScore: true,
    detail: `${n} завершённых позиций — достаточно, чтобы оценка описывала поведение`,
  };
}

// ─────────────────────────── Smart Score ────────────────────────────────────

export interface SmartScoreInput {
  pnl: WalletPnl;
  positions: Position[];
  /** Доля находок, дошедших до двукратного роста. */
  discovery2xRate?: number | null;
  /** Медианное время входа после запуска пула, часы. */
  medianEntryHours?: number | null;
  /** Доля позиций, обнулившихся более чем на девяносто процентов. */
  zeroedShare?: number | null;
  /** Признаки неорганического поведения: свои токены, накрутка. */
  organicPenalty?: number;
  config?: ScoreConfig;
}

export interface SmartScoreResult {
  /** null означает «оценивать рано», а не «плохо». */
  score: number | null;
  confidence: ConfidenceResult;
  /** Разбор по составляющим — чтобы оценку можно было объяснить. */
  components: Record<string, number>;
}

export function computeSmartScore(input: SmartScoreInput): SmartScoreResult {
  const cfg = input.config ?? DEFAULT_SCORE_CONFIG;
  const { pnl } = input;

  const confidence = assessConfidence({ closedPositions: pnl.closedCount });

  // Ниже порога числа не будет вовсе. Это главное требование:
  // одна удачная сделка не может дать рейтинг.
  if (!confidence.showScore) {
    return { score: null, confidence, components: {} };
  }

  // ─── Зафиксированный результат ─────────────────────────────────
  //
  // Считается по усечённой медианной доходности, а не по среднему:
  // одна сделка на сто концов иначе перетягивает всё остальное,
  // и кошелёк с одной удачей обгоняет кошелёк с двадцатью ровными
  // прибыльными сделками.
  const roi = clamp01(
    ((winsorize(pnl.medianRoi ?? 0, cfg.winsorizeRoi.min, cfg.winsorizeRoi.max) + 1) / 3),
  );

  const pf = pnl.profitFactor;
  const profitFactor = pf == null ? 0.3 : clamp01(Math.min(pf, 4) / 4);

  const realized = clamp01(roi * 0.6 + profitFactor * 0.4);

  // ─── Стабильность ──────────────────────────────────────────────
  const concentration = pnl.topTradeShare ?? 0;
  const concentrationPenalty =
    concentration > cfg.concentrationPenaltyAt
      ? (concentration - cfg.concentrationPenaltyAt) / (1 - cfg.concentrationPenaltyAt)
      : 0;

  const breadth = clamp01(pnl.uniqueTokens / 30);
  const consistency = clamp01(breadth * (1 - concentrationPenalty));

  // ─── Раннее обнаружение ────────────────────────────────────────
  const entry = input.medianEntryHours;
  const speed = entry == null ? 0.3 : clamp01(1 - Math.min(entry, 24) / 24);
  const discovery = clamp01(speed * 0.5 + (input.discovery2xRate ?? 0) * 0.5);

  // ─── Доля удачных с поправкой на выборку ───────────────────────
  //
  // Нижняя граница доверительного интервала: три из трёх дают
  // не единицу, а около сорока четырёх сотых.
  const winRate = wilsonLowerBound(pnl.wins, pnl.closedCount);

  // ─── Управление риском ─────────────────────────────────────────
  const zeroed = input.zeroedShare ?? 0;
  const riskManagement = clamp01(1 - zeroed);

  // ─── Органичность поведения ────────────────────────────────────
  const organic = clamp01(1 - (input.organicPenalty ?? 0));

  const components = {
    realized,
    consistency,
    discovery,
    winRate,
    riskManagement,
    organic,
  };

  const w = cfg.weights;
  const raw =
    realized * w.realized +
    consistency * w.consistency +
    discovery * w.discovery +
    winRate * w.winRate +
    riskManagement * w.riskManagement +
    organic * w.organic;

  return {
    score: Math.round(clamp01(raw) * 100),
    confidence,
    components,
  };
}

// ─────────────────────────── Copyability ────────────────────────────────────

export interface CopyabilityInput {
  /** Медианная ликвидность пула на момент входа, USD. */
  medianEntryLiquidityUsd: number | null;
  /** Медианный размер позиции, USD. */
  medianPositionUsd: number | null;
  /** Медианное время входа после запуска пула, часы. */
  medianEntryHours: number | null;
  /** Сделок в сутки. Высокая частота повторению не поддаётся. */
  tradesPerDay?: number | null;
  /** Кошелёк опознан как снайпер, бот или арбитражник. */
  isBot?: boolean;
}

export type CopyBadge =
  | 'not_copyable'
  | 'sniper'
  | 'mev'
  | 'high_slippage'
  | 'low_liquidity';

export interface CopyabilityResult {
  score: number;
  badges: CopyBadge[];
  /** Можно ли войти на сто долларов без заметного удара по цене. */
  canEnterSmall: boolean;
  explanation: string;
}

/**
 * Насколько сделки кошелька вообще повторимы.
 *
 * Отдельная оценка нужна потому, что лучшие по доходности кошельки
 * чаще всего именно неповторимы: снайпер входит в первом блоке,
 * арбитражник — внутри одной транзакции. Их результат настоящий,
 * но воспроизвести его нельзя, и человек, который об этом не знает,
 * повторяет их с задержкой в минуты и теряет деньги.
 */
export function computeCopyability(input: CopyabilityInput): CopyabilityResult {
  const badges: CopyBadge[] = [];

  const liq = input.medianEntryLiquidityUsd ?? 0;
  // Сто долларов на пуле в двадцать тысяч — это половина процента
  // глубины, приемлемо. На пуле в тысячу — уже десятая часть,
  // и цена уйдёт.
  const liquidityScore = clamp01(Math.log10(Math.max(liq, 1) / 1_000) / 2);
  if (liq > 0 && liq < 20_000) badges.push('low_liquidity');

  const entry = input.medianEntryHours;
  // Вход в первые секунды повторить нельзя физически: пока человек
  // увидит сделку, блок уже закрыт.
  const timingScore =
    entry == null ? 0.5 : entry < 0.05 ? 0 : clamp01(Math.min(entry, 6) / 6);
  if (entry != null && entry < 0.05) badges.push('sniper');

  const freq = input.tradesPerDay ?? 0;
  const freqScore = freq > 50 ? 0 : clamp01(1 - freq / 50);
  if (freq > 50) badges.push('mev');

  if (input.isBot) badges.push('mev');

  let score = Math.round(
    clamp01(liquidityScore * 0.45 + timingScore * 0.4 + freqScore * 0.15) * 100,
  );

  /**
   * Невозможность повторить — свойство абсолютное, а не слагаемое.
   *
   * Взвешенная сумма давала снайперу на глубоком пуле шестьдесят
   * баллов: ликвидность и частота вытягивали оценку, хотя вход
   * в первом блоке нельзя повторить ни при какой ликвидности.
   * Пока человек увидит сделку, блок закрыт — и никакая глубина
   * пула этого не меняет.
   *
   * Поэтому такие признаки не складываются с остальными, а ставят
   * потолок.
   */
  if (badges.includes('sniper') || badges.includes('mev')) {
    score = Math.min(score, 20);
  }

  if (score < 25) badges.unshift('not_copyable');

  return {
    score,
    badges,
    canEnterSmall: liq >= 20_000,
    explanation:
      badges.includes('sniper')
        ? 'Входит в первые секунды после запуска пула — повторить это вручную нельзя'
        : badges.includes('mev')
          ? 'Частота сделок указывает на бота, а не на человека'
          : badges.includes('low_liquidity')
            ? 'Торгует в мелких пулах: вход даже на сотню долларов двигает цену'
            : 'Сделки в целом повторимы',
  };
}

// ─────────────────────────────── Риск ───────────────────────────────────────

export type WalletRisk = 'low' | 'medium' | 'high' | 'critical';

export interface RiskInput {
  /** Доля позиций, обнулившихся более чем на девяносто процентов. */
  zeroedShare: number;
  /** Сколько торгуемых токенов оказались ловушками или подделками. */
  scamTokens: number;
  /** Наибольшая просадка по зафиксированному результату, доля. */
  maxDrawdown?: number | null;
  /** Доля прибыли от одной сделки. */
  concentration?: number | null;
  /** Кошелёк связан с разработчиками или инсайдерами. */
  insiderLinked?: boolean;
}

export function assessWalletRisk(input: RiskInput): { level: WalletRisk; reasons: string[] } {
  const reasons: string[] = [];

  if (input.insiderLinked) {
    reasons.push('Связан с адресами разработчиков или инсайдеров');
  }
  if (input.scamTokens > 0) {
    reasons.push(`Торговал ${input.scamTokens} токенами, признанными мошенническими`);
  }
  if (input.zeroedShare > 0.4) {
    reasons.push(`${Math.round(input.zeroedShare * 100)}% позиций обнулились`);
  }
  if ((input.concentration ?? 0) > 0.7) {
    reasons.push('Почти вся прибыль пришла с одной сделки');
  }
  if ((input.maxDrawdown ?? 0) > 0.6) {
    reasons.push(`Просадка достигала ${Math.round((input.maxDrawdown ?? 0) * 100)}%`);
  }

  const level: WalletRisk =
    input.insiderLinked || input.scamTokens > 3
      ? 'critical'
      : reasons.length >= 3
        ? 'high'
        : reasons.length >= 1
          ? 'medium'
          : 'low';

  return { level, reasons };
}

// ────────────────────── Исключение ложных лидеров ───────────────────────────

export type WalletKind =
  | 'trader'
  | 'cex'
  | 'bridge'
  | 'router'
  | 'pool'
  | 'contract'
  | 'developer'
  | 'insider'
  | 'bundle'
  | 'wash';

/** Виды, которые не место в рейтинге торговцев ни при каком результате. */
export const EXCLUDED_KINDS: WalletKind[] = [
  'cex',
  'bridge',
  'router',
  'pool',
  'contract',
  'developer',
  'insider',
  'bundle',
  'wash',
];

export function isListableWallet(kind: WalletKind): boolean {
  return !EXCLUDED_KINDS.includes(kind);
}

export const KIND_LABELS: Record<WalletKind, string> = {
  trader: 'Трейдер',
  cex: 'Кошелёк биржи',
  bridge: 'Мост',
  router: 'Маршрутизатор',
  pool: 'Пул ликвидности',
  contract: 'Контракт протокола',
  developer: 'Разработчик токена',
  insider: 'Инсайдер',
  bundle: 'Связанный кошелёк',
  wash: 'Накрутка оборота',
};

// ─────────────────────────────── Мелочи ─────────────────────────────────────

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

/**
 * Усечение выброса.
 *
 * Не отбрасывание: сделка на сто концов реальна и должна учитываться.
 * Но её влияние обязано быть конечным, иначе одна удача определяет
 * весь рейтинг.
 */
export function winsorize(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}
