/**
 * Что мы на самом деле знаем о токене.
 *
 * Уровень риска отвечает на вопрос «насколько опасно», и это не тот
 * вопрос, который задаёт человек, глядя на пустой список. Его вопрос
 * другой: «почему здесь ничего нет». Уровень на него не отвечает
 * вовсе — «не проверен» и «проверен, сведений не хватило» и «проверка
 * не смогла достучаться до источников» сливались в один `pending`.
 *
 * Разница между ними существенна, потому что действия разные.
 * Непроверенный ждёт очереди. Недостаточность данных не исправится
 * ожиданием. Сбой провайдера исправится сам, но требует повтора.
 * Устаревший вердикт нужно перепроверить. Слить их в одно слово —
 * значит лишить и человека, и себя возможности понять, что чинить.
 *
 * ─── Чем это отличается от riskState ────────────────────────────────
 *
 * Рядом живёт `risk-completeness.ts` с похожим на вид набором
 * состояний, и это не дубликат: у модулей разные входы и разные
 * потребители.
 *
 *   riskState   — про одну карточку в момент показа. На входе живые
 *                 сигналы проверок, на выходе ответ «можно ли сейчас
 *                 написать число рядом со словом „риск“».
 *
 *   checkStatus — про строку в базе. На входе сохранённый уровень,
 *                 время проверки и версия правил; на выходе ответ
 *                 «стоит ли этот токен в витрине, в очереди или
 *                 в отказе».
 *
 * Первое отвечает человеку, второе — витрине, очереди и диагностике.
 * Считать статус витрины из живых сигналов нельзя: их нет, пока
 * проверка не запущена, а решение о показе нужно принимать всегда.
 */

import type { RiskLevel } from './risk-model.js';
import { SAFE_LEVELS } from './risk-model.js';

export const CHECK_STATUSES = [
  'SAFE',
  'WARNING',
  'BLOCKED',
  'PENDING',
  'INSUFFICIENT_DATA',
  'PROVIDER_ERROR',
  'STALE',
] as const;

export type CheckStatus = (typeof CHECK_STATUSES)[number];

export const CHECK_STATUS_TEXT: Record<CheckStatus, string> = {
  SAFE: 'Проверен, замечаний нет',
  WARNING: 'Проверен, есть замечания',
  BLOCKED: 'Заблокирован',
  PENDING: 'Ожидает проверки',
  INSUFFICIENT_DATA: 'Проверен, но данных не хватило',
  PROVIDER_ERROR: 'Источники не ответили, повторим',
  STALE: 'Проверка устарела',
};

/**
 * Через сколько вердикт перестаёт что-либо значить.
 *
 * Втрое больше срока плановой перепроверки. Разница между «пора
 * перепроверить» и «верить нельзя» намеренная: очередь всегда идёт
 * с некоторым отставанием, и объявлять устаревшим всё, что не успели
 * за сутки, значит опустошить витрину при первой же задержке —
 * то есть повторить ошибку, которую мы чиним.
 *
 * Трое суток означают, что отстала не очередь, а вся проверка.
 */
export const CHECK_STALE_AFTER_MS = 72 * 60 * 60 * 1000;

/** Плановая перепроверка. За этим сроком вердикт ещё в силе. */
export const CHECK_RECHECK_AFTER_MS = 24 * 60 * 60 * 1000;

export interface CheckStatusInput {
  /** Уровень риска из базы. null — проверки не было. */
  riskLevel: RiskLevel | string | null;
  /** Когда проверяли. null — никогда. */
  checkedAt: Date | number | null;
  /** По какой версии правил. null — неизвестно. */
  rulesVersion: number | null;
  /** Нынешняя версия правил. */
  currentRulesVersion: number;
  /**
   * Последняя попытка упёрлась в недоступность источников.
   *
   * Именно последняя, а не «когда-нибудь»: сбой недельной давности
   * ничего не говорит о нынешнем вердикте.
   */
  providerError?: boolean;
  /**
   * Проверка прошла, но ни один источник безопасности не высказался.
   *
   * От `providerError` отличается тем, что источники ответили —
   * им просто нечего сказать об этом токене. Ожидание не поможет.
   */
  insufficientData?: boolean;
  now?: number;
  staleAfterMs?: number;
}

/**
 * Один статус на токен.
 *
 * Порядок проверок — это порядок приоритета утверждений, и он важнее
 * самих статусов.
 *
 * Блокировка идёт первой: найденное нарушение остаётся нарушением,
 * даже если вердикт устарел или часть источников молчит. Отменять
 * установленный факт из-за возраста записи опаснее, чем показать
 * старую блокировку.
 *
 * Дальше — состояния проверки, от «не начиналась» к «закончилась
 * ничем». И только последними — выводы, потому что вывод имеет смысл
 * лишь тогда, когда проверка действительно состоялась и не протухла.
 */
export function checkStatus(input: CheckStatusInput): CheckStatus {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? CHECK_STALE_AFTER_MS;

  if (input.riskLevel === 'blocked') return 'BLOCKED';

  const checkedAt =
    input.checkedAt == null
      ? null
      : input.checkedAt instanceof Date
        ? input.checkedAt.getTime()
        : input.checkedAt;

  // Никогда не проверяли — очередь до токена ещё не дошла.
  if (checkedAt == null || input.riskLevel == null) return 'PENDING';

  if (input.providerError) return 'PROVIDER_ERROR';
  if (input.insufficientData) return 'INSUFFICIENT_DATA';

  // Проверка была, но ничего не установила.
  if (input.riskLevel === 'pending') return 'PENDING';

  /*
   * Устаревание считается и по времени, и по версии правил.
   *
   * Версия важнее: токен, проверенный час назад по прежним правилам,
   * опаснее проверенного вчера по нынешним. Без этой ветки новое
   * правило не действовало бы на уже проверенные токены до самого
   * истечения срока.
   */
  const outdatedRules =
    input.rulesVersion == null || input.rulesVersion < input.currentRulesVersion;

  if (outdatedRules || now - checkedAt > staleAfter) return 'STALE';

  return SAFE_LEVELS.includes(input.riskLevel as RiskLevel) ? 'SAFE' : 'WARNING';
}

/**
 * Пора ли перепроверить.
 *
 * Отдельно от статуса намеренно. Токен может быть SAFE и при этом
 * стоять в очереди на перепроверку — это нормальное рабочее
 * состояние, а не проблема, и смешивать его со STALE значило бы
 * поднимать тревогу по расписанию.
 */
export function dueForRecheck(
  input: Pick<CheckStatusInput, 'checkedAt' | 'rulesVersion' | 'currentRulesVersion' | 'now'> & {
    recheckAfterMs?: number;
  },
): boolean {
  const now = input.now ?? Date.now();
  const after = input.recheckAfterMs ?? CHECK_RECHECK_AFTER_MS;

  if (input.checkedAt == null) return true;
  if (input.rulesVersion == null || input.rulesVersion < input.currentRulesVersion) return true;

  const at = input.checkedAt instanceof Date ? input.checkedAt.getTime() : input.checkedAt;
  return now - at > after;
}

/** Показывать ли токен в строгом режиме витрины. */
export function statusIsShowcaseSafe(status: CheckStatus): boolean {
  return status === 'SAFE';
}

/**
 * Разрешена ли покупка.
 *
 * Всё, кроме прямо разрешённого. Непроверенный токен покупать нельзя:
 * незавершённая проверка — это отсутствие сведений, а не сведения
 * об отсутствии проблем.
 *
 * Продажу это правило не касается вовсе: актив уже принадлежит
 * человеку, и запирать его в позиции из-за нашей очереди нельзя.
 */
export function statusAllowsBuy(status: CheckStatus): boolean {
  return status === 'SAFE' || status === 'WARNING';
}

/** Исправится ли состояние само, если подождать. */
export function statusWillResolve(status: CheckStatus): boolean {
  return status === 'PENDING' || status === 'PROVIDER_ERROR' || status === 'STALE';
}
