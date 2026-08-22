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
  riskDataStale: 'RISK_DATA_STALE',
  unsupportedWalletCategory: 'UNSUPPORTED_WALLET_CATEGORY',
  riskDataUnavailableOrStale: 'RISK_DATA_UNAVAILABLE_OR_STALE',
  sourcesDisagree: 'SOURCES_DISAGREE',
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
  /**
   * Предельный возраст проверок контракта.
   *
   * Обязателен: без него «устарело» не имеет определения, и решать
   * пришлось бы на глаз. Старше этого — запрет, а не сомнение.
   */
  maxRiskAgeMs: number;
}

/**
 * Полоса пересмотра.
 *
 * Необязательная и без значения по умолчанию. Её отсутствие означает,
 * что полосы нет вовсе, а не что она равна какому-то числу: скрытый
 * порог опаснее отсутствующего, потому что о нём никто не знает.
 *
 * Каждое поле — доля от основного порога. `0.05` означает «считать
 * неоднозначным всё, что отстоит от предела меньше чем на пять
 * процентов».
 */
export interface ReviewBand {
  priceImpactRatio?: number;
  liquidityRatio?: number;
  topHolderRatio?: number;
  /** Возраст проверок, после которого стоит присмотреться. */
  riskAgeMs?: number;
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
    'maxRiskAgeMs',
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

  /**
   * Полоса пересмотра, если настроена.
   *
   * Без неё значение ровно на пороге проходит по оператору правила
   * и никакого дополнительного сомнения не порождает.
   */
  reviewBand?: ReviewBand | null;
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

  // ── Пригодность источника ───────────────────────────────────────
  //
  // Отдельно от оценки риска токена. Это разные вопросы: «безопасен
  // ли контракт» и «стоит ли повторять за этим кошельком». Смешивать
  // их значит объяснять отказ не тем.
  const adverse = input.sourceCategories.filter(isAdverse);
  if (adverse.length > 0) {
    deny(
      GATE_REASON.adverseSourceWallet,
      `Сигнал породили кошельки, за которыми не повторяют: ${adverse.join(', ')}`,
    );
  }

  // Неизвестная категория — не повод для сомнения, а отсутствие
  // пригодного источника. Показать такой сигнал человеку можно,
  // копировать автоматически — нет: мы не знаем, за кем повторяем.
  const unknownCount = input.sourceCategories.filter((c) => c === 'unknown').length;
  if (unknownCount > 0) {
    deny(
      GATE_REASON.unsupportedWalletCategory,
      `Категория ${unknownCount} кошельков неизвестна — источник не пригоден для копирования`,
    );
  }

  // Проверки старше предельного возраста. Не сомнение: устаревшую
  // критическую проверку нельзя рассматривать как, возможно,
  // ещё годную — за это время ликвидность успевает исчезнуть,
  // а владелец успевает всё.
  const gateNow = input.now ?? Date.now();

  // Проверки без отметки времени. Полный набор ответов без даты
  // их получения не отличим от набора недельной давности, и «свежо»
  // здесь было бы предположением, а не фактом.
  if (completeness.isComplete && input.riskCheckedAt == null) {
    deny(
      GATE_REASON.riskDataUnavailableOrStale,
      'Проверки есть, но время их получения неизвестно',
    );
  }

  if (
    input.riskCheckedAt != null &&
    L.maxRiskAgeMs != null &&
    gateNow - input.riskCheckedAt > L.maxRiskAgeMs
  ) {
    deny(
      GATE_REASON.riskDataStale,
      `Проверки старше предела: ${Math.round((gateNow - input.riskCheckedAt) / 1000)} с`,
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

  const band = input.reviewBand;

  /*
   * Полоса пересмотра.
   *
   * Работает, только если её задали. Отсутствие полосы означает,
   * что её нет, а не что она равна какому-то разумному числу:
   * скрытый порог опаснее отсутствующего, потому что о нём никто
   * не знает и никто его не пересматривает.
   *
   * Значение ровно на пороге при этом проходит — так определён
   * оператор правила, и менять его смысл полоса не должна.
   */
  if (band) {
    const nearMax = (v: number | null, limit: number | undefined, ratio: number | undefined, label: string) => {
      if (v == null || limit == null || ratio == null || limit === 0) return;
      // Правило «не больше»: сомнение в полосе под пределом.
      if (v <= limit && v > limit * (1 - ratio)) {
        doubt(GATE_REASON.nearThreshold, `${label}: ${v} в полосе пересмотра у предела ${limit}`);
      }
    };

    const nearMin = (v: number | null, limit: number | undefined, ratio: number | undefined, label: string) => {
      if (v == null || limit == null || ratio == null || limit === 0) return;
      // Правило «не меньше»: сомнение в полосе над пределом.
      if (v >= limit && v < limit * (1 + ratio)) {
        doubt(GATE_REASON.nearThreshold, `${label}: ${v} в полосе пересмотра у предела ${limit}`);
      }
    };

    nearMax(input.priceImpactPct, L.maxPriceImpactPct, band.priceImpactRatio, 'Влияние на цену');
    nearMax(input.topHolderPct, L.maxTopHolderPct, band.topHolderRatio, 'Концентрация');
    nearMin(input.liquidityUsd, L.minLiquidityUsd, band.liquidityRatio, 'Ликвидность');

    // Проверки ещё в пределах допустимого возраста, но уже в полосе.
    if (input.riskCheckedAt != null && band.riskAgeMs != null) {
      const age = gateNow - input.riskCheckedAt;
      if (age > band.riskAgeMs) {
        doubt(GATE_REASON.nearThreshold, `Проверки получены ${Math.round(age / 1000)} с назад`);
      }
    }
  }

  /*
   * Расхождение источников.
   *
   * Единственный повод для сомнения, не требующий настройки:
   * если два источника дают разные числа, как минимум один неверен,
   * и определить какой мы не можем. Сюда попадают только случаи,
   * где оба источника валидны и актуальны, — иначе запрет сработал
   * бы выше.
   */
  for (const d of input.sourceDisagreements ?? []) {
    doubt(GATE_REASON.sourcesDisagree, `Источники разошлись по «${d.field}» на ${d.spreadPct}%`);
  }

  if (doubts.length > 0) {
    return { decision: 'REVIEW_REQUIRED', reasons: doubts, explanations: doubtWhy };
  }

  return { decision: 'ALLOW', reasons: [], explanations: [] };
}

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
