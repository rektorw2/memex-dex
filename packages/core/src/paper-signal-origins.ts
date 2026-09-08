import { PAPER_TEST_ORIGIN } from './paper-test-source.js';

/**
 * По каким сигналам агент вправе действовать.
 *
 * Это не то же самое, что «какие сигналы считаются живыми». Два вопроса
 * разошлись, и их нельзя отвечать одним списком:
 *
 *   • «действовать» — можно ли по этому сигналу создать run и принять
 *     решение. Сюда попадает управляемый источник, когда он включён:
 *     иначе проверять PAPER-режим нечем;
 *   • «живой» — считать ли сигнал частью настоящего потока OKX. Сюда
 *     управляемый источник не попадает никогда, иначе тестовый прогон
 *     улучшал бы отчётность.
 *
 * Первый вопрос отвечает этот модуль, второй — `isLivePaperSignalOrigin`
 * в `paper-agent.ts`, и он остаётся нетронутым.
 *
 * Зачем понадобилось. Управляемый источник помечает сигналы
 * происхождением `TEST_HARNESS`, а воркер пропускал к обработке только
 * `WEBSOCKET_LIVE` и `REST_RECONCILIATION` — в трёх местах, каждое со
 * своим списком. То есть источник, сделанный ради проверки PAPER-режима,
 * не мог довести до воркера ни одного сигнала: он молча отбрасывался
 * как диагностический.
 *
 * Правило fail-closed: при выключенном флаге список ровно тот же, что
 * был раньше. Production ничего не замечает.
 */

/** Происхождения настоящего потока. Всегда доступны для действия. */
export const LIVE_ACTIONABLE_ORIGINS = ['WEBSOCKET_LIVE', 'REST_RECONCILIATION'] as const;

/**
 * Список происхождений, по которым агент вправе действовать.
 *
 * Возвращается массив, а не предикат: воркер передаёт его прямо в
 * условие запроса `IN (...)`, и второй способ выразить то же правило
 * однажды разошёлся бы с первым.
 */
export function actionablePaperOrigins(testSourceEnabled: boolean): string[] {
  return testSourceEnabled
    ? [...LIVE_ACTIONABLE_ORIGINS, PAPER_TEST_ORIGIN]
    : [...LIVE_ACTIONABLE_ORIGINS];
}

/** Вправе ли агент действовать по сигналу с таким происхождением. */
export function isActionablePaperOrigin(value: unknown, testSourceEnabled: boolean): boolean {
  return typeof value === 'string' && actionablePaperOrigins(testSourceEnabled).includes(value);
}
