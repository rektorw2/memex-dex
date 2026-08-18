/**
 * Решение о допуске автоматической покупки.
 *
 * Это последний рубеж перед тратой денег, и устроен он на одном
 * принципе: **отсутствие данных — это `SKIP`, а не `ALLOW`**.
 *
 * Принцип выглядит очевидным и нарушается постоянно, потому что
 * нарушение приятно. Проверка не ответила — пропустим её; поле
 * пустое — сочтём нулём; источник промолчал — значит претензий нет.
 * Каждое такое послабление по отдельности мелочь, а вместе они
 * означают покупку токена, о котором мы не знаем ничего, под видом
 * токена, у которого нет замечаний.
 *
 * Второй принцип: решение детерминировано. Никакая языковая модель
 * не может его изменить. Модель вправе объяснить сигнал человеку
 * и помочь настроить стратегию — но не поднять лимит, не снять
 * стоп-лосс и не переписать вердикт.
 *
 * Третий: пороги не выдуманы здесь. Ни одного числа по умолчанию
 * в этом модуле нет. Все границы приходят из настроек пользователя,
 * и пока обязательные не заданы, автоматика включаться не должна —
 * за это отвечает `missingLimits`.
 *
 * «Доступен через OKX» не означает «безопасен». Токен может
 * находиться в Market, Signal, Trenches и Trade и при этом быть
 * ловушкой: маршрутизируемость — свойство ликвидности, а не
 * добросовестности.
 */

import type { ChainKey } from './token-registry.js';
import {
  assessCompleteness,
  ABSOLUTE_FAILURES,
  type RiskSignal,
} from './risk-completeness.js';
import { isAdverse, type OkxWalletCategory } from './okx-wallet-type.js';

export type GateDecision = 'ALLOW' | 'SKIP' | 'REVIEW_REQUIRED';

/**
 * Коды причин.
 *
 * Устойчивые: по ним строятся отчёты, уведомления и разбор
 * инцидентов. Переименование кода ломает историю, поэтому коды
 * добавляются, но не переименовываются.
 */
export const GATE_REASON = {
  tokenNotSupported: 'TOKEN_NOT_SUPPORTED',
  riskDataMissing: 'RISK_DATA_MISSING',
  honeypotSuspected: 'HONEYPOT_SUSPECTED',
  sellRouteUnavailable: 'SELL_ROUTE_UNAVAILABLE',
  sellSimulationFailed: 'SELL_SIMULATION_FAILED',
  liquidityTooLow: 'LIQUIDITY_TOO_LOW',
  priceImpactTooHigh: 'PRICE_IMPACT_TOO_HIGH',
  topHolderConcentration: 'TOP_HOLDER_CONCENTRATION_TOO_HIGH',
  sellTaxTooHigh: 'SELL_TAX_TOO_HIGH',
  mintAuthorityActive: 'MINT_AUTHORITY_ACTIVE',
  freezeAuthorityActive: 'FREEZE_AUTHORITY_ACTIVE',
  signalTooOld: 'SIGNAL_TOO_OLD',
  sourceAlreadySelling: 'SOURCE_ALREADY_SELLING',
  positionLimitReached: 'POSITION_LIMIT_REACHED',
  dailyLossLimitReached: 'DAILY_LOSS_LIMIT_REACHED',
  quoteExpired: 'QUOTE_EXPIRED',
  quoteUnavailable: 'QUOTE_UNAVAILABLE',
  adverseSourceWallet: 'ADVERSE_SOURCE_WALLET',
  limitsNotConfigured: 'LIMITS_NOT_CONFIGURED',
  providerUnavailable: 'PROVIDER_UNAVAILABLE',
  killSwitchActive: 'KILL_SWITCH_ACTIVE',
  missingRequiredLimits: 'MISSING_REQUIRED_LIMITS',
  riskDataUnavailableOrStale: 'RISK_DATA_UNAVAILABLE_OR_STALE',
  sourcesDisagree: 'SOURCES_DISAGREE',
  mixedSourceQuality: 'MIXED_SOURCE_QUALITY',
  nearThreshold: 'NEAR_THRESHOLD',
} as const;

export type GateReason = (typeof GATE_REASON)[keyof typeof GATE_REASON];

/**
 * Пороги.
 *
 * Все поля обязательны намеренно. Необязательное поле рано или
 * поздно окажется незаполненным, и проверка молча выключится —
 * ровно тот отказ, который невозможно заметить.
 */
export interface GateLimits {
  maxSignalAgeMs: number;
  minLiquidityUsd: number;
  maxPriceImpactPct: number;
  maxSellTaxPct: number;
  maxTopHolderPct: number;
  maxSoldRatioPct: number;
  maxOpenPositions: number;
  maxPositionsPerToken: number;
  dailyLossLimitUsd: number;
}

/** Какие обязательные пороги ещё не заданы. */
export function missingLimits(limits: Partial<GateLimits> | null | undefined): string[] {
  const required: Array<keyof GateLimits> = [
    'maxSignalAgeMs',
    'minLiquidityUsd',
    'maxPriceImpactPct',
    'maxSellTaxPct',
    'maxTopHolderPct',
    'maxSoldRatioPct',
    'maxOpenPositions',
    'maxPositionsPerToken',
    'dailyLossLimitUsd',
  ];

  if (!limits) return required as string[];

  // Ноль — допустимое значение порога, а вот отсутствие и не-число
  // означают, что настройка не сделана.
  return required.filter((k) => {
    const v = limits[k];
    return v == null || !Number.isFinite(v);
  });
}

export interface GateInput {
  chain: ChainKey;
  /** Проверки контракта, как их вернули источники. */
  signals: RiskSignal[];
  limits: Partial<GateLimits> | null;

  /** Токен поддержан торговым путём OKX. null — не выяснено. */
  tokenSupported: boolean | null;
  /** Есть исполнимый обратный маршрут. null — не выяснено. */
  sellRouteAvailable: boolean | null;
  /** Симуляция продажи прошла. null — не выполнялась. */
  sellSimulationOk: boolean | null;

  liquidityUsd: number | null;
  priceImpactPct: number | null;
  topHolderPct: number | null;
  soldRatioPct: number | null;

  /** Возраст сигнала на момент решения. */
  signalAgeMs: number | null;
  /** Категории кошельков, породивших сигнал. */
  sourceCategories: OkxWalletCategory[];

  /** Котировка получена и ещё жива. */
  quoteFresh: boolean | null;

  openPositions: number;
  positionsForToken: number;
  dailyLossUsd: number;

  /** Источники проверок недоступны — работаем в закрытую. */
  providerUnavailable?: boolean;
  /** Общий стоп-кран пользователя. */
  killSwitchActive?: boolean;

  /**
   * Когда получены проверки контракта.
   *
   * Нужен отдельно от самих проверок: результат может быть полным
   * и при этом старым. Старый результат не запрещает покупку, но
   * и не позволяет назвать её проверенной — за минуту ликвидность
   * успевает исчезнуть.
   */
  riskCheckedAt?: number | null;
  now?: number;
  /** После какого возраста проверка считается несвежей. */
  riskStaleAfterMs?: number;

  /** Источники разошлись в значении. Пары «что» и «насколько». */
  sourceDisagreements?: Array<{ field: string; spreadPct: number }>;
}

export interface GateResult {
  decision: GateDecision;
  /** Все сработавшие причины, в порядке важности. */
  reasons: GateReason[];
  /** Пояснения для человека, по одному на причину. */
  explanations: string[];
}

/**
 * Вердикт.
 *
 * Порядок проверок отражает порядок важности, а не удобства:
 * сначала то, что запрещает торговлю вообще, затем незнание,
 * затем нарушенные пороги.
 */
export function evaluateGate(input: GateInput): GateResult {
  const reasons: GateReason[] = [];
  const explanations: string[] = [];

  const deny = (code: GateReason, why: string) => {
    reasons.push(code);
    explanations.push(why);
  };

  // ── Запреты, не зависящие от данных ─────────────────────────────
  if (input.killSwitchActive) {
    deny(GATE_REASON.killSwitchActive, 'Автоторговля остановлена пользователем');
  }

  const notConfigured = missingLimits(input.limits);
  if (notConfigured.length > 0) {
    deny(
      GATE_REASON.limitsNotConfigured,
      `Не заданы обязательные пределы: ${notConfigured.join(', ')}`,
    );
  }

  if (input.providerUnavailable) {
    // Закрываемся, а не работаем по старым данным. Устаревшая
    // проверка безопасности хуже отсутствующей: она выглядит
    // как проверка.
    deny(GATE_REASON.providerUnavailable, 'Источник проверок недоступен — новые входы остановлены');
  }

  // ── Подтверждённые запреты по контракту ─────────────────────────
  const failed = new Set(
    input.signals.filter((s) => s.status === 'failed').map((s) => s.code),
  );

  if (failed.has('honeypot')) {
    deny(GATE_REASON.honeypotSuspected, 'Источник подтвердил невозможность продажи');
  }
  if (failed.has('mint_authority')) {
    deny(GATE_REASON.mintAuthorityActive, 'Владелец может допечатать токены');
  }
  if (failed.has('freeze_authority')) {
    deny(GATE_REASON.freezeAuthorityActive, 'Владелец может заморозить счета держателей');
  }

  for (const code of failed) {
    if (ABSOLUTE_FAILURES.has(code) && code !== 'honeypot') {
      deny(GATE_REASON.honeypotSuspected, `Подтверждён критический признак: ${code}`);
    }
  }

  // ── Незнание ────────────────────────────────────────────────────
  //
  // Здесь и живёт главное правило модуля. Всё, что ниже, — про
  // отсутствие ответа, и каждый такой случай запрещает покупку.

  const completeness = assessCompleteness(input.chain, input.signals);
  if (!completeness.isComplete) {
    deny(
      GATE_REASON.riskDataMissing,
      `Нет ответа по проверкам: ${completeness.missing.join(', ')}`,
    );
  }

  if (input.tokenSupported !== true) {
    deny(
      GATE_REASON.tokenNotSupported,
      input.tokenSupported === false
        ? 'Токен не поддержан торговым путём'
        : 'Поддержка токена не подтверждена',
    );
  }

  if (input.sellRouteAvailable !== true) {
    // Купить можно почти всё. Вопрос всегда в том, можно ли продать.
    deny(
      GATE_REASON.sellRouteUnavailable,
      input.sellRouteAvailable === false
        ? 'Обратный маршрут отсутствует'
        : 'Обратный маршрут не проверен',
    );
  }

  if (input.sellSimulationOk !== true) {
    deny(
      GATE_REASON.sellSimulationFailed,
      input.sellSimulationOk === false
        ? 'Симуляция продажи не прошла'
        : 'Симуляция продажи не выполнялась',
    );
  }

  if (input.quoteFresh !== true) {
    deny(
      GATE_REASON.quoteExpired,
      input.quoteFresh === false ? 'Котировка устарела' : 'Котировка не получена',
    );
  }

  // ── Пороги ──────────────────────────────────────────────────────
  //
  // Каждое сравнение сначала требует наличия числа. Отсутствующее
  // значение не проходит порог, а сообщает о себе отдельно: иначе
  // `null < порог` в JavaScript оказалось бы истиной и пропустило
  // бы токен без данных.

  const L = input.limits ?? {};

  checkNumber(
    input.signalAgeMs,
    L.maxSignalAgeMs,
    (v, max) => v > max,
    GATE_REASON.signalTooOld,
    'Возраст сигнала',
    deny,
  );

  checkNumber(
    input.liquidityUsd,
    L.minLiquidityUsd,
    (v, min) => v < min,
    GATE_REASON.liquidityTooLow,
    'Ликвидность',
    deny,
  );

  checkNumber(
    input.priceImpactPct,
    L.maxPriceImpactPct,
    (v, max) => v > max,
    GATE_REASON.priceImpactTooHigh,
    'Влияние на цену',
    deny,
  );

  checkNumber(
    input.topHolderPct,
    L.maxTopHolderPct,
    (v, max) => v > max,
    GATE_REASON.topHolderConcentration,
    'Концентрация у крупнейших держателей',
    deny,
  );

  checkNumber(
    input.soldRatioPct,
    L.maxSoldRatioPct,
    (v, max) => v > max,
    GATE_REASON.sourceAlreadySelling,
    'Доля уже проданного источниками',
    deny,
  );

  // Налог на продажу берётся из сигналов, а не из отдельного поля:
  // он либо измерен проверкой, либо неизвестен.
  const sellTax = numericValue(input.signals, 'sell_tax');
  if (input.chain !== 'SOLANA') {
    checkNumber(
      sellTax,
      L.maxSellTaxPct,
      (v, max) => v > max,
      GATE_REASON.sellTaxTooHigh,
      'Налог на продажу',
      deny,
    );
  }

  // ── Пределы позиции ─────────────────────────────────────────────
  if (L.maxOpenPositions != null && input.openPositions >= L.maxOpenPositions) {
    deny(
      GATE_REASON.positionLimitReached,
      `Открытых позиций ${input.openPositions} при пределе ${L.maxOpenPositions}`,
    );
  }

  if (L.maxPositionsPerToken != null && input.positionsForToken >= L.maxPositionsPerToken) {
    deny(
      GATE_REASON.positionLimitReached,
      `По этому токену уже ${input.positionsForToken} позиций`,
    );
  }

  if (L.dailyLossLimitUsd != null && input.dailyLossUsd >= L.dailyLossLimitUsd) {
    deny(
      GATE_REASON.dailyLossLimitReached,
      `Дневной убыток достиг предела: ${input.dailyLossUsd}`,
    );
  }

  // ── Источник сигнала ────────────────────────────────────────────
  const adverse = input.sourceCategories.filter(isAdverse);
  if (adverse.length > 0) {
    deny(
      GATE_REASON.adverseSourceWallet,
      `Сигнал породили кошельки, за которыми не повторяют: ${adverse.join(', ')}`,
    );
  }

  // ── Запреты кончились ───────────────────────────────────────────
  //
  // Всё, что накопилось выше, — это `SKIP`: детерминированный запрет
  // или отсутствие данных, без которых вывод невозможен.
  if (reasons.length > 0) {
    return { decision: 'SKIP', reasons, explanations };
  }

  /*
   * Неоднозначность.
   *
   * Данные полны, запретов нет — и всё же назвать это проверенным
   * нельзя. Такие случаи не запрещают покупку человеку, но не
   * допускаются к автоматике: машина не умеет сомневаться, а здесь
   * сомнение и есть содержание вердикта.
   *
   * Отдельное состояние нужно потому, что иначе выбор был бы между
   * двумя одинаково неверными решениями: `ALLOW` выдал бы сомнение
   * за уверенность, `SKIP` — молча спрятал бы находку, о которой
   * человеку стоило узнать.
   */
  const doubts: GateReason[] = [];
  const doubtWhy: string[] = [];

  const doubt = (code: GateReason, why: string) => {
    doubts.push(code);
    doubtWhy.push(why);
  };

  // Проверки полны, но получены давно. Не запрет: за минуту
  // ликвидность успевает исчезнуть, но и не факт, что исчезла.
  const now = input.now ?? Date.now();
  const staleAfter = input.riskStaleAfterMs;

  if (input.riskCheckedAt != null && staleAfter != null && now - input.riskCheckedAt > staleAfter) {
    doubt(
      GATE_REASON.riskDataUnavailableOrStale,
      `Проверки получены ${Math.round((now - input.riskCheckedAt) / 1000)} с назад`,
    );
  }

  // Источники разошлись. Расхождение в цене или ликвидности между
  // двумя источниками означает, что как минимум один из них неверен,
  // и мы не знаем какой.
  for (const d of input.sourceDisagreements ?? []) {
    doubt(
      GATE_REASON.sourcesDisagree,
      `Источники разошлись по «${d.field}» на ${d.spreadPct}%`,
    );
  }

  // Среди источников сигнала есть неизвестные категории. Не запрет —
  // запрет дают только заведомо вредные, — но и не подтверждение:
  // за неизвестным кошельком повторять не следует.
  const unknownSources = input.sourceCategories.filter((c) => c === 'unknown');
  if (unknownSources.length > 0) {
    doubt(
      GATE_REASON.mixedSourceQuality,
      `Категория ${unknownSources.length} кошельков неизвестна`,
    );
  }

  // Значение вплотную к порогу. Формально порог не нарушен, но
  // разница в пределах погрешности измерения, а решение по обе
  // стороны противоположное.
  const nearLimit = (v: number | null, limit: number | undefined, label: string) => {
    if (v == null || limit == null || limit === 0) return;
    if (Math.abs(v - limit) / limit <= NEAR_THRESHOLD_RATIO) {
      doubt(GATE_REASON.nearThreshold, `${label} вплотную к пределу: ${v} при ${limit}`);
    }
  };

  nearLimit(input.priceImpactPct, L.maxPriceImpactPct, 'Влияние на цену');
  nearLimit(input.liquidityUsd, L.minLiquidityUsd, 'Ликвидность');
  nearLimit(input.topHolderPct, L.maxTopHolderPct, 'Концентрация');

  if (doubts.length > 0) {
    return { decision: 'REVIEW_REQUIRED', reasons: doubts, explanations: doubtWhy };
  }

  return { decision: 'ALLOW', reasons: [], explanations: [] };
}

/**
 * Насколько близко к порогу считается «вплотную».
 *
 * Пять процентов от самого порога. Число не про рынок, а про
 * точность измерения: разница меньше погрешности источника
 * не должна решать судьбу сделки в одну или другую сторону.
 */
const NEAR_THRESHOLD_RATIO = 0.05;

/**
 * Разрешено ли автоматическое исполнение.
 *
 * Единственная функция, которой следует спрашивать перед покупкой.
 * Сравнение `decision !== 'SKIP'` рано или поздно кто-нибудь
 * напишет, и `REVIEW_REQUIRED` окажется допущенным к торговле.
 */
export function isAutoExecutionAllowed(result: GateResult): boolean {
  return result.decision === 'ALLOW';
}

/**
 * Стоит ли показать находку человеку.
 *
 * `REVIEW_REQUIRED` показывается: в этом его смысл. `SKIP` —
 * по запросу, но не в основной выдаче.
 */
export function isVisibleToUser(result: GateResult): boolean {
  return result.decision !== 'SKIP';
}

// ──────────────────────────── Вспомогательное ───────────────────────────────

/**
 * Сравнение с порогом, устойчивое к отсутствию значения.
 *
 * Отдельная функция ради одной строки, которую иначе повторили бы
 * восемь раз и в одном месте написали бы неверно: `null` в сравнении
 * приводится к нулю, и токен без данных проходит любой порог «не
 * больше».
 */
function checkNumber(
  value: number | null | undefined,
  limit: number | null | undefined,
  fails: (v: number, limit: number) => boolean,
  code: GateReason,
  label: string,
  deny: (code: GateReason, why: string) => void,
): void {
  if (limit == null || !Number.isFinite(limit)) return; // порог не задан — сказано выше

  if (value == null || !Number.isFinite(value)) {
    deny(GATE_REASON.riskDataMissing, `${label}: значение неизвестно`);
    return;
  }

  if (fails(value, limit)) {
    deny(code, `${label}: ${value} при пределе ${limit}`);
  }
}

/** Числовое значение проверки, если она его вернула. */
function numericValue(signals: RiskSignal[], code: string): number | null {
  const s = signals.find((x) => x.code === code && x.status !== 'unknown');
  const v = s?.value;

  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
