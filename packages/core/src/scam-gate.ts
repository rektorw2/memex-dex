import { D, type Numeric } from './money.js';

/**
 * Допуск токена в терминал.
 *
 * Задача отличается от оценки риска: та отвечает «насколько опасно»,
 * эта — «показывать ли вообще». Разница практическая. Скор 78 из 100
 * ничего не говорит человеку, который смотрит список из двухсот
 * токенов; ему нужно, чтобы очевидный мусор туда не попадал.
 *
 * Решение принимается по трём уровням:
 *
 *  BLOCK — доказуемая ловушка: продать нельзя, эмиссию можно допечатать,
 *          ликвидность не залочена при живом владельце. Такие токены
 *          не показываются вовсе.
 *  WARN  — подозрительно, но не доказано: перекос покупок к продажам,
 *          объём, несопоставимый с ликвидностью, слишком юный пул.
 *          Показываются с пометкой.
 *  OK    — ничего из перечисленного не найдено. Это не значит «безопасно»:
 *          мем-коин может обесцениться при любых метриках.
 *
 * Отдельно важно: отсутствие данных — не то же самое, что их
 * благополучие. Токен, который не удалось проверить, помечается,
 * а не пропускается молча.
 */

export type ScamVerdict = 'BLOCK' | 'WARN' | 'OK';

export interface ScamSignals {
  // ─── Проверки контракта (GoPlus) ───────────────────────────────────
  isHoneypot?: boolean | null;
  mintable?: boolean | null;
  freezable?: boolean | null;
  ownerCanModify?: boolean | null;
  buyTaxPct?: number | null;
  sellTaxPct?: number | null;
  lpLocked?: boolean | null;
  top10Pct?: number | null;
  creatorPct?: number | null;
  holderCount?: number | null;

  // ─── Рыночные (GeckoTerminal / DexScreener) ────────────────────────
  liquidityUsd?: Numeric | null;
  volume24hUsd?: Numeric | null;
  /** Сделок на покупку за 24 ч. */
  buys24h?: number | null;
  /** Сделок на продажу за 24 ч. */
  sells24h?: number | null;
  poolAgeHours?: number | null;
  /** Проверки контракта выполнялись и вернули данные. */
  securityChecked?: boolean;
}

export interface ScamDecision {
  verdict: ScamVerdict;
  /** Причины блокировки. Пусто при WARN и OK. */
  blockers: string[];
  /** Поводы для осторожности. */
  warnings: string[];
  /** 0-100, чем выше — тем опаснее. Для сортировки, не для решения. */
  score: number;
}

/** Налог на продажу выше этого — фактический запрет выхода. */
export const MAX_SELL_TAX_PCT = 20;
/** Ликвидность ниже — из пула нельзя выйти без обвала цены. */
export const MIN_LIQUIDITY_USD = 5_000;

export function checkScam(s: ScamSignals): ScamDecision {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let score = 0;

  // ─── Блокирующие признаки ───────────────────────────────────────────
  // Общее у всех: они доказуемы из данных контракта, а не выводятся
  // из поведения цены. Догадка не должна блокировать торговлю.

  if (s.isHoneypot === true) {
    blockers.push('Продажа заблокирована контрактом');
  }

  if (s.sellTaxPct != null && s.sellTaxPct >= MAX_SELL_TAX_PCT) {
    // Налог в 30% на продажу — это не «высокая комиссия», а способ
    // забрать треть вклада при выходе.
    blockers.push(`Налог на продажу ${s.sellTaxPct.toFixed(0)}%`);
  }

  if (s.mintable === true) {
    blockers.push('Эмиссию можно допечатать в любой момент');
  }

  if (s.freezable === true) {
    blockers.push('Токен можно заморозить на вашем кошельке');
  }

  // Незалоченная ликвидность сама по себе не приговор — но вместе
  // с правом владельца менять контракт это готовый механизм вывода.
  if (s.lpLocked === false && s.ownerCanModify === true) {
    blockers.push('Ликвидность не залочена, владелец может менять контракт');
  }

  const liq = s.liquidityUsd != null ? D(s.liquidityUsd) : null;
  if (liq && liq.gt(0) && liq.lt(MIN_LIQUIDITY_USD)) {
    blockers.push(`Ликвидность $${liq.toFixed(0)} — выйти без обвала цены нельзя`);
  }

  if (blockers.length > 0) {
    return { verdict: 'BLOCK', blockers, warnings, score: 100 };
  }

  // ─── Поводы для осторожности ────────────────────────────────────────

  if (!s.securityChecked) {
    // Непроверенное не равно безопасному. Умолчание «раз не нашли
    // проблем, значит их нет» — самая дорогая ошибка в этом месте.
    warnings.push('Контракт не проверен — данные о безопасности недоступны');
    score += 25;
  }

  if (s.lpLocked === false) {
    warnings.push('Ликвидность не залочена — её могут вынуть');
    score += 20;
  }

  if (s.ownerCanModify === true) {
    warnings.push('Владелец может менять правила контракта');
    score += 15;
  }

  if (s.sellTaxPct != null && s.sellTaxPct > 5) {
    warnings.push(`Налог на продажу ${s.sellTaxPct.toFixed(0)}%`);
    score += 10;
  }

  if (s.top10Pct != null && s.top10Pct > 50) {
    warnings.push(`У топ-10 держателей ${s.top10Pct.toFixed(0)}% предложения`);
    score += s.top10Pct > 80 ? 25 : 15;
  }

  if (s.creatorPct != null && s.creatorPct > 20) {
    warnings.push(`У создателя ${s.creatorPct.toFixed(0)}% предложения`);
    score += 15;
  }

  if (s.holderCount != null && s.holderCount < 50) {
    warnings.push(`Держателей всего ${s.holderCount}`);
    score += 10;
  }

  // ─── Поведенческие признаки ─────────────────────────────────────────

  const buys = s.buys24h ?? null;
  const sells = s.sells24h ?? null;

  if (buys != null && sells != null && buys + sells >= 30) {
    // Перекос покупок к продажам — подпись ханипота, который проверка
    // контракта не поймала: продать формально можно, но никто не смог.
    // Порог по сумме сделок обязателен — на десяти сделках такое
    // соотношение получается случайно.
    if (sells === 0) {
      warnings.push(`${buys} покупок и ни одной продажи за сутки`);
      score += 35;
    } else if (buys / sells > 10) {
      warnings.push(
        `Покупок в ${(buys / sells).toFixed(0)} раз больше, чем продаж — возможна ловушка`,
      );
      score += 25;
    }
  }

  const vol = s.volume24hUsd != null ? D(s.volume24hUsd) : null;
  if (vol && liq && liq.gt(0) && vol.div(liq).gt(30)) {
    // Оборот в тридцать раз выше ликвидности за сутки — почти всегда
    // накрутка объёма: реальная торговля такой пул просто осушила бы.
    warnings.push(
      `Оборот в ${vol.div(liq).toFixed(0)} раз выше ликвидности — похоже на накрутку`,
    );
    score += 20;
  }

  if (s.poolAgeHours != null && s.poolAgeHours < 6) {
    warnings.push(`Пулу ${s.poolAgeHours.toFixed(1)} ч — история ещё не сложилась`);
    score += 10;
  }

  return {
    verdict: warnings.length > 0 ? 'WARN' : 'OK',
    blockers,
    warnings,
    score: Math.min(100, score),
  };
}

/**
 * Краткое пояснение вердикта одной строкой.
 * Для списка, где на полный разбор места нет.
 */
export function scamSummary(d: ScamDecision): string {
  if (d.verdict === 'BLOCK') return d.blockers[0] ?? 'Заблокирован';
  if (d.verdict === 'WARN') {
    return d.warnings.length > 1
      ? `${d.warnings[0]} и ещё ${d.warnings.length - 1}`
      : (d.warnings[0] ?? 'Требует внимания');
  }
  return 'Явных признаков ловушки не найдено';
}
