/**
 * Состояние проверок риска в ответе Radar.
 *
 * Отдельный модуль без Prisma: разбор чистый, и проверять его надо
 * без базы. Импорт этого файла не поднимает клиент базы, поэтому
 * тесты запускаются в любом окружении.
 *
 * Полнота хранится приставками в `riskCodes`, а не отдельными
 * колонками: схема здесь наливается вручную, и код с новой колонкой
 * оказался бы в бою раньше самой колонки, уронив запрос целиком.
 * Разбор — обратный записи в воркере.
 */

import { requiredChecksCount, type ChainKey } from '@memex/core';

const COMPLETENESS_PREFIX = 'COMPLETENESS_';
const MISSING_PREFIX = 'MISSING_';

/**
 * Состояния нового алгоритма.
 *
 * Само значение уровня признаком новизны не является: слово `low`
 * писал и прежний движок. Признак — вердикт полноты рядом с ним.
 */
const KNOWN_STATES = new Set([
  'checking',
  'insufficient_data',
  'low',
  'medium',
  'high',
  'critical',
  'stale',
  'provider_error',
]);

/** Состояния, для которых число имеет смысл. */
const SCORED_STATES = new Set(['low', 'medium', 'high', 'critical', 'stale']);

const CRITICAL_CODE_PREFIXES = ['HONEYPOT', 'SELL_BLOCKED', 'LIQUIDITY_REMOVED', 'MALICIOUS'];

export interface RiskStateFields {
  riskState: string;
  riskStateScore: number | null;
  riskCompletenessPercent: number | null;
  requiredChecksCount: number;
  completedChecksCount: number;
  missingChecks: string[];
  criticalReasons: string[];
  riskUpdatedAt: string | null;
}

export function riskStateFields(
  chain: string,
  level: string | null,
  codes: string[],
  score: number | null,
  checkedAt: Date | null,
): RiskStateFields {
  // Размер набора берётся из ядра по сети, а не из константы здесь
  // и не из разметки: иначе три места начнут расходиться.
  const required = requiredChecksCount(chain as ChainKey);

  const missing = codes
    .filter((c) => c.startsWith(MISSING_PREFIX))
    .map((c) => c.slice(MISSING_PREFIX.length).toLowerCase());

  const percentCode = codes.find((c) => c.startsWith(COMPLETENESS_PREFIX));
  const percent = percentCode ? Number(percentCode.slice(COMPLETENESS_PREFIX.length)) : null;

  /*
   * Есть ли вердикт полноты.
   *
   * Это и есть признак того, что запись сделана новым алгоритмом.
   * Проверять по значению уровня нельзя: прежний движок тоже писал
   * `low`, и запись с одной проверкой снова оказалась бы низким
   * риском — ровно та ошибка, ради которой всё переделывалось.
   */
  const hasVerdict = percentCode != null;

  const state = hasVerdict && KNOWN_STATES.has(level ?? '') ? level! : legacyState(level, score);

  return {
    riskState: state,
    // Число только там, где набор закрыт и вердикт есть.
    riskStateScore: hasVerdict && SCORED_STATES.has(state) ? score : null,
    riskCompletenessPercent: hasVerdict ? percent : null,
    requiredChecksCount: required,
    // Считается вычитанием, а не отдельной приставкой: два числа
    // об одном и том же расходятся при первой же правке.
    completedChecksCount: hasVerdict ? Math.max(0, required - missing.length) : 0,
    missingChecks: missing,
    criticalReasons: codes.filter((c) => CRITICAL_CODE_PREFIXES.some((p) => c.includes(p))),
    riskUpdatedAt: checkedAt?.toISOString() ?? null,
  };
}

/**
 * Записи, сделанные до перехода на состояния.
 *
 * Превращать их в «низкий риск» по баллу нельзя — низкий балл
 * означал мало проверок. Подтверждённый запрет при этом теряться
 * не должен: там сведения были.
 */
function legacyState(level: string | null, score: number | null): string {
  if (level === 'blocked' || level === 'critical') return 'critical';
  if (score == null) return 'checking';
  return 'insufficient_data';
}
