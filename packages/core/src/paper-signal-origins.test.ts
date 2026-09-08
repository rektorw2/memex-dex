import { describe, expect, it } from 'vitest';
import {
  LIVE_ACTIONABLE_ORIGINS,
  actionablePaperOrigins,
  isActionablePaperOrigin,
} from './paper-signal-origins.js';
import { PAPER_TEST_ORIGIN } from './paper-test-source.js';
import { isLivePaperSignalOrigin } from './paper-agent.js';

describe('выключенный источник не меняет ничего', () => {
  it('список ровно тот, что был до появления управляемого источника', () => {
    /*
     * Главное свойство: production, где флаг выключен, не замечает
     * появления тестового происхождения вовсе.
     */
    expect(actionablePaperOrigins(false)).toEqual(['WEBSOCKET_LIVE', 'REST_RECONCILIATION']);
  });

  it('тестовое происхождение отвергается', () => {
    expect(isActionablePaperOrigin(PAPER_TEST_ORIGIN, false)).toBe(false);
  });
});

describe('включённый источник добавляет ровно одно происхождение', () => {
  it('живые остаются, тестовое добавляется', () => {
    expect(actionablePaperOrigins(true)).toEqual([
      'WEBSOCKET_LIVE',
      'REST_RECONCILIATION',
      PAPER_TEST_ORIGIN,
    ]);
  });

  it('ничего лишнего не появляется', () => {
    // Разница между двумя состояниями — ровно один элемент.
    expect(actionablePaperOrigins(true)).toHaveLength(actionablePaperOrigins(false).length + 1);
  });

  it('посторонние происхождения не проходят ни при каком флаге', () => {
    for (const flag of [true, false]) {
      for (const origin of ['REST_BACKFILL', 'MANUAL', '', 'websocket_live', null, undefined]) {
        expect(isActionablePaperOrigin(origin, flag), `${String(origin)}/${flag}`).toBe(false);
      }
    }
  });
});

describe('«действовать» и «живой» — разные вопросы', () => {
  it('тестовое происхождение действует, но живым не считается', () => {
    /*
     * Смысл разделения. Если бы список был один, у нас был бы выбор
     * из двух плохих вариантов: либо управляемый источник не доходит
     * до воркера и PAPER нечем проверять, либо тестовые прогоны
     * попадают в метрики живой ленты и делают их лучше, чем есть.
     */
    expect(isActionablePaperOrigin(PAPER_TEST_ORIGIN, true)).toBe(true);
    expect(isLivePaperSignalOrigin(PAPER_TEST_ORIGIN)).toBe(false);
  });

  it('живые происхождения действуют и считаются живыми', () => {
    for (const origin of LIVE_ACTIONABLE_ORIGINS) {
      expect(isActionablePaperOrigin(origin, false)).toBe(true);
      expect(isLivePaperSignalOrigin(origin)).toBe(true);
    }
  });

  it('backfill не действует, но и живым не считается', () => {
    // Диагностическое происхождение: было таким и остаётся.
    expect(isActionablePaperOrigin('REST_BACKFILL', true)).toBe(false);
    expect(isLivePaperSignalOrigin('REST_BACKFILL')).toBe(false);
  });
});
