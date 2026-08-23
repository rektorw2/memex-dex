/**
 * Модель риска токена: уровни, коды причин, пороги.
 *
 * Три вердикта — BLOCK, WARN, OK — оказались слишком грубыми. Между
 * «проверен и известен» и «ничего плохого не нашли» разница есть,
 * и она важна: первое можно показывать без оговорок, второе нельзя.
 * Так же различаются «проверен и найден опасным» и «проверить
 * не удалось» — сейчас оба попадали в один WARN.
 *
 * Коды причин машиночитаемы намеренно. Русский текст удобен человеку,
 * но по нему нельзя ни отфильтровать, ни посчитать статистику, ни
 * связать причину с подсказкой в интерфейсе. Текст остаётся, но рядом
 * с кодом, а не вместо него.
 */

// ─────────────────────────────── Уровни ─────────────────────────────────────

export const RISK_LEVELS = [
  'verified',
  'low',
  'medium',
  'high',
  'blocked',
  'pending',
] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];

export const RISK_LABELS: Record<RiskLevel, string> = {
  verified: 'Проверен',
  low: 'Низкий риск',
  medium: 'Средний риск',
  high: 'Высокий риск',
  blocked: 'Заблокирован',
  pending: 'Не проверен',
};

/**
 * Уровни, допустимые в основной выдаче.
 *
 * pending сюда не входит принципиально: незавершённая проверка — это
 * отсутствие сведений, а не сведения об отсутствии проблем. Показывать
 * такой токен наравне с проверенным значит выдавать незнание за
 * безопасность.
 */
export const TRADEABLE_LEVELS: RiskLevel[] = ['verified', 'low', 'medium'];

/** Уровни для строгого режима, включённого по умолчанию. */
export const SAFE_LEVELS: RiskLevel[] = ['verified', 'low'];

// ────────────────────────────── Коды причин ─────────────────────────────────

export const REASON_CODES = [
  // Критические: токен не показывается
  'HONEYPOT',
  'SELL_FAILED',
  'CANNOT_SELL_ALL',
  'HIGH_SELL_TAX',
  'MALICIOUS_CONTRACT',
  'BALANCE_MUTABLE',
  'TRANSFER_BLACKLIST',
  'JUPITER_BANNED',
  'JUPITER_SUSPICIOUS',
  'FAKE_SYMBOL',
  'FAKE_RWA_TICKER',
  'LOW_LIQUIDITY',
  'CREATOR_CONTROLS_SUPPLY',
  'FREEZE_AUTHORITY_ACTIVE',
  'DANGEROUS_TOKEN_EXTENSION',
  'SOURCE_PRICE_MISMATCH',
  'IMPLAUSIBLE_METRICS',
  'OKX_HIGH_RISK',
  'RUGCHECK_CRITICAL',
  'DEV_RUG_HISTORY',

  // Повышающие риск
  'MINT_AUTHORITY_ACTIVE',
  'UNLOCKED_LIQUIDITY',
  'OWNER_CAN_MODIFY',
  'ELEVATED_SELL_TAX',
  'HIGH_HOLDER_CONCENTRATION',
  'HIGH_TOP10_CONCENTRATION',
  'HIGH_DEV_HOLDING',
  'HIGH_BUNDLE_HOLDING',
  'SUSPICIOUS_HOLDERS',
  'HIGH_SNIPER_HOLDING',
  'DEV_SOLD_HOLDINGS',
  'FEW_HOLDERS',
  'SUSPICIOUS_VOLUME',
  'ONE_SIDED_TRADING',
  'YOUNG_POOL',
  'DUPLICATE_SYMBOL',
  'MINOR_CLONE',
  'COSTLY_ROUND_TRIP',
  'SINGLE_SOURCE',
  'OKX_CAUTION',
  'UNVERIFIED_RWA_CLAIM',

  // Отсутствие данных
  'SECURITY_DATA_UNAVAILABLE',
  'MARKET_DATA_UNAVAILABLE',
] as const;

export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  /** Человеческое объяснение. Показывается пользователю. */
  message: string;
  /** Насколько код повышает оценку риска. Критические дают 100. */
  weight: number;
}

/** Коды, при которых токен не показывается ни при каких условиях. */
export const CRITICAL_CODES = new Set<ReasonCode>([
  'HONEYPOT',
  'SELL_FAILED',
  'CANNOT_SELL_ALL',
  'HIGH_SELL_TAX',
  'MALICIOUS_CONTRACT',
  'BALANCE_MUTABLE',
  'TRANSFER_BLACKLIST',
  'JUPITER_BANNED',
  'FAKE_SYMBOL',
  'LOW_LIQUIDITY',
  'CREATOR_CONTROLS_SUPPLY',
  'FREEZE_AUTHORITY_ACTIVE',
  'DANGEROUS_TOKEN_EXTENSION',
  'SOURCE_PRICE_MISMATCH',
  'IMPLAUSIBLE_METRICS',

  // Подделка под биржевую бумагу. Стоит рядом с FAKE_SYMBOL, потому
  // что это тот же обман, только под другое имя: человек, покупающий
  // «NVDA», рассчитывает на долю в NVIDIA.
  'FAKE_RWA_TICKER',

  // Приговоры внешних проверок. Оба означают найденное нарушение,
  // а не подозрение: уровень 3 у OKX и danger у RugCheck выставляются
  // по факту, а не по совокупности признаков.
  'OKX_HIGH_RISK',
  'RUGCHECK_CRITICAL',
]);

/**
 * Почему JUPITER_SUSPICIOUS сюда не входит.
 *
 * Метка isSus в аудите Jupiter стояла у 54% заблокированных токенов.
 * Столько подтверждённого мошенничества не бывает: метка означает
 * «есть к чему придраться», а не «мошенник». Она осталась тяжёлым
 * замечанием весом 45 — из строгого режима токен выпадает, но
 * не исчезает совсем.
 *
 * Отдельно стоит запомнить, как эта ошибка пряталась. Сначала вес
 * понизили со 100 до 45 и посчитали дело сделанным, но код остался
 * в этом списке — а здесь вес не значит ничего, критический код
 * блокирует сам по себе. Правка выглядела осмысленной и не делала
 * ровно ничего.
 *
 * Отсюда правило: у кода есть два независимых свойства — вес
 * и членство в этом множестве. Меняя одно, надо проверять второе.
 */

/**
 * Почему DEV_RUG_HISTORY сюда не входит.
 *
 * Соблазн велик: создатель, бросивший три токена, почти наверняка
 * бросит и четвёртый. Но «почти наверняка» — это прогноз, а не факт
 * о данном токене, и смешивать их нельзя. Критические коды означают
 * найденное нарушение; история создателя означает вероятность
 * будущего. Такой токен и так уходит в high и не показывается —
 * разница только в том, что мы называем его подозрительным,
 * а не уличённым.
 */

// ──────────────────────────────── Пороги ────────────────────────────────────

/**
 * Настройки проверки.
 *
 * Вынесены отдельно, чтобы менять их без правки логики. Каждое значение
 * снабжено пояснением: через полгода никто не вспомнит, почему порог
 * концентрации именно такой, и без объяснения его либо не тронут вовсе,
 * либо изменят наугад.
 */
export interface RiskConfig {
  /** Ниже этой ликвидности выйти из позиции нельзя без обвала цены. */
  minLiquidityUsd: number;
  /** Налог на продажу выше этого — фактический запрет выхода. */
  maxSellTaxPct: number;
  /** Налог, при котором выход становится заметно дороже обычного. */
  elevatedSellTaxPct: number;
  /** Доля предложения у создателя, дающая ему контроль над ценой. */
  maxCreatorPct: number;
  /** Концентрация у топ-10 без учёта пулов и сожжённого. */
  highConcentrationPct: number;
  criticalConcentrationPct: number;
  /** Держателей меньше — рынка по сути нет. */
  minHolders: number;
  /** Оборот к ликвидности выше — почти всегда накрутка. */
  maxVolumeToLiquidity: number;
  /** Перекос покупок к продажам при достаточной выборке. */
  maxBuySellRatio: number;
  minTradesForRatio: number;
  /** Возраст пула, ниже которого история не сложилась. */
  youngPoolHours: number;
  /** Расхождение цены между источниками. */
  maxPriceSpread: number;
  /** Возврат на круге покупка-продажа. */
  trapReturnRatio: number;
  costlyReturnRatio: number;
  /** Границы уровней по итоговой оценке. */
  lowRiskMaxScore: number;
  mediumRiskMaxScore: number;
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  // Двадцать пять тысяч: при меньшей глубине пула выход суммой
  // в тысячу долларов двигает цену на десятки процентов.
  minLiquidityUsd: 25_000,

  // Пятнадцать процентов на продажу — граница, за которой удержание
  // перестаёт быть комиссией и становится изъятием.
  maxSellTaxPct: 15,
  elevatedSellTaxPct: 5,

  // Двадцать процентов у создателя достаточно, чтобы обвалить цену
  // одной продажей на любом мем-коине.
  maxCreatorPct: 20,

  // Пороги концентрации считаются без пулов, сожжённого и известных
  // системных адресов — иначе честный токен с одним крупным пулом
  // выглядит как захваченный.
  highConcentrationPct: 50,
  criticalConcentrationPct: 85,

  minHolders: 50,

  // Тридцатикратный оборот за сутки реальная торговля дала бы только
  // осушив пул: деньги должны откуда-то приходить и куда-то уходить.
  maxVolumeToLiquidity: 30,

  maxBuySellRatio: 10,
  // Ниже тридцати сделок соотношение получается случайно.
  minTradesForRatio: 30,

  youngPoolHours: 6,

  // Двадцать процентов с запасом на разные пулы и задержку обновления.
  maxPriceSpread: 0.2,

  trapReturnRatio: 0.5,
  costlyReturnRatio: 0.85,

  // Границы уровней.
  //
  // Калибровка под мем-коины, а не под идеальный актив. Незалоченная
  // ликвидность и половина предложения у топ-10 — для этого рынка норма,
  // а не аномалия: если считать их серьёзными замечаниями, в «низкий
  // риск» не попадёт почти ничего, и фильтр перестанет быть полезным.
  //
  // Уровень должен отвечать на вопрос «насколько это необычно для
  // мем-коина», а не «насколько это далеко от голубой фишки».
  lowRiskMaxScore: 30,
  mediumRiskMaxScore: 60,
};

// ───────────────────────────── Сведение оценки ──────────────────────────────

export interface RiskAssessmentInput {
  reasons: Reason[];
  /** Проверка контракта завершилась и вернула данные. */
  securityChecked: boolean;
  /** Токен есть в подтверждённом реестре. */
  isVerifiedAsset: boolean;
  /**
   * Часть источников не ответила.
   *
   * Не оценка токена, а состояние проверки, и обращаться с ним надо
   * соответственно: ни «безопасен», ни «заблокирован» на неполном
   * опросе утверждать нельзя. Токен уходит в `pending` и вернётся
   * в очередь.
   */
  providerError?: boolean;
  config?: RiskConfig;
}

export interface RiskResult {
  level: RiskLevel;
  score: number;
  reasons: Reason[];
  /** Только коды — для фильтрации и статистики. */
  codes: ReasonCode[];
}

/**
 * Сведение причин в уровень.
 *
 * Порядок проверок отражает приоритет утверждений. Критическая причина
 * важнее подтверждённости: даже токен из реестра, у которого сломалась
 * продажа, торговать нельзя. Незавершённая проверка важнее хорошей
 * оценки: нельзя назвать безопасным то, что не проверено.
 */
export function assessRisk(input: RiskAssessmentInput): RiskResult {
  const cfg = input.config ?? DEFAULT_RISK_CONFIG;
  const reasons = input.reasons;
  const codes = reasons.map((r) => r.code);

  const hasCritical = codes.some((c) => CRITICAL_CODES.has(c));

  if (hasCritical) {
    return { level: 'blocked', score: 100, reasons, codes };
  }

  /*
   * Неполный опрос важнее хорошей оценки, но слабее найденного
   * нарушения.
   *
   * Порядок именно такой. Найденный ханипот остаётся ханипотом,
   * даже если параллельно отвалился DexScreener: факт установлен,
   * и отменять его из-за чужого таймаута нельзя. А вот отсутствие
   * замечаний при неполном опросе — это не «замечаний нет», это
   * «мы не досмотрели».
   */
  if (input.providerError) {
    return {
      level: 'pending',
      score: Math.min(100, reasons.reduce((s, r) => s + r.weight, 0)),
      reasons,
      codes,
    };
  }

  if (!input.securityChecked) {
    // Отсутствие проверки — не оценка, а её отсутствие. Смешивать
    // с уровнями риска нельзя: «средний риск» звучит как вывод,
    // а вывода нет.
    return {
      level: 'pending',
      score: Math.min(100, reasons.reduce((s, r) => s + r.weight, 0)),
      reasons,
      codes,
    };
  }

  const score = Math.min(100, reasons.reduce((s, r) => s + r.weight, 0));

  // Подтверждённый актив без замечаний. Отдельный уровень нужен,
  // чтобы отличать «мы знаем этот токен» от «мы не нашли проблем».
  if (input.isVerifiedAsset && score === 0) {
    return { level: 'verified', score, reasons, codes };
  }

  if (score <= cfg.lowRiskMaxScore) return { level: 'low', score, reasons, codes };
  if (score <= cfg.mediumRiskMaxScore) return { level: 'medium', score, reasons, codes };

  return { level: 'high', score, reasons, codes };
}

/** Показывать ли токен в основной выдаче. */
export function isListable(level: RiskLevel, strict: boolean): boolean {
  return strict ? SAFE_LEVELS.includes(level) : TRADEABLE_LEVELS.includes(level);
}
