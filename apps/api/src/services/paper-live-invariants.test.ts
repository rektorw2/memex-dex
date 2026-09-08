import { describe, expect, it } from 'vitest';
import {
  liveReadinessStage,
  liveReadinessWithDiagnostics,
  paperTestSourceVerdict,
  paperTestWriteAllowed,
  phase4SectionsVerdict,
  stageRequirementCounts,
  type LiveStageInput,
} from '@memex/core';
import {
  KNOWN_MIGRATIONS,
  PHASE4_RECONCILIATION_MIGRATION,
  planProductionSchemaRepair,
} from '../lib/production-schema-repair.js';

/**
 * Инварианты безопасности PAPER и подготовки LIVE — списком.
 *
 * Каждый из них проверен и в своём файле; здесь они собраны в одном
 * месте намеренно. Разрозненные проверки отвечают на вопрос «работает
 * ли эта функция»; список отвечает на вопрос «что именно мы обещали
 * не делать» — и его можно прочитать целиком перед тем, как что-то
 * включать.
 *
 * Все проверки поведенческие: вызывается настоящая функция и
 * проверяется её ответ. Ни одна не ищет строку в исходнике —
 * grep по имени поля проходит и тогда, когда защита снята.
 */

const readyLive = { ready: true, blockers: [] as string[] };

const completeLadder: LiveStageInput = {
  paperAgentConfigured: true,
  allocationConfigured: true,
  signingEnabled: true,
  signerProviderSupported: true,
  signerKeyConfigured: true,
  signerKeyFingerprintObserved: true,
  identityRegistered: true,
  expectedKeyMatches: true,
  networkVerified: true,
  reconciliationEnabled: true,
  safetyLatchHealthy: true,
  migrationsReady: true,
  signatureValidated: true,
  hasAmbiguousAttempt: false,
  network: 'devnet',
};

describe('И1. Неотвечающая проверка не считается пройденной', () => {
  it('молчащая диагностика снимает готовность LIVE', () => {
    /*
     * Отказ диагностики означает, что о состоянии контура ничего
     * не известно. «Неизвестно» — не «готово».
     */
    for (const broken of [
      { funding: 'UNAVAILABLE', signing: 'AVAILABLE' },
      { funding: 'AVAILABLE', signing: 'UNAVAILABLE' },
      { funding: 'UNAVAILABLE', signing: 'UNAVAILABLE' },
    ] as const) {
      const result = liveReadinessWithDiagnostics(readyLive, phase4SectionsVerdict(broken));

      expect(result.ready, JSON.stringify(broken)).toBe(false);
    }
  });

  it('исправная диагностика ничего не ужесточает', () => {
    // Негативный контроль: запрет вызван молчанием, а не тем,
    // что функция всегда отвечает «нет».
    const ok = phase4SectionsVerdict({ funding: 'AVAILABLE', signing: 'AVAILABLE' });

    expect(liveReadinessWithDiagnostics(readyLive, ok).ready).toBe(true);
  });
});

describe('И2. Лестница LIVE не проходится одним флагом', () => {
  it('у каждой ступени минимум два условия и хотя бы один факт', () => {
    for (const step of stageRequirementCounts(completeLadder)) {
      expect(step.total, step.stage).toBeGreaterThanOrEqual(2);
      expect(step.observed, step.stage).toBeGreaterThanOrEqual(1);
    }
  });

  it('снятие любого условия опускает лестницу', () => {
    const flags = Object.keys(completeLadder).filter(
      (key) => key !== 'network' && key !== 'hasAmbiguousAttempt',
    ) as Array<keyof LiveStageInput>;

    for (const flag of flags) {
      expect(liveReadinessStage({ ...completeLadder, [flag]: false }).stage, flag).not.toBe(
        'MAINNET_BLOCKED',
      );
    }
  });
});

describe('И3. Mainnet не открывается прохождением ступеней', () => {
  it('верхняя ступень — стена, а не разрешение', () => {
    const verdict = liveReadinessStage({ ...completeLadder, network: 'mainnet-beta' });

    /*
     * Ступени пройдены полностью — и это ничего не меняет.
     * Запрос mainnet виден отдельно и не снимается достижениями
     * на devnet: там другой контур, другие ключи, другие деньги.
     */
    expect(verdict.stage).toBe('MAINNET_BLOCKED');
    expect(verdict.mainnetRequested).toBe(true);
  });
});

describe('И4. Управляемый источник закрыт по умолчанию', () => {
  const permissive = {
    testSourceEnabled: true,
    executionMode: 'paper',
    liveExecutionEnabled: false,
    withdrawalsEnabled: false,
    solanaNetwork: 'devnet',
    actorRole: 'ADMIN',
  };

  it('выключенная настройка перевешивает всё остальное', () => {
    expect(paperTestSourceVerdict({ ...permissive, testSourceEnabled: false }).allowed).toBe(false);
  });

  it('боевой режим, исполнение, выводы и mainnet — каждый по отдельности запрещает', () => {
    /*
     * Четыре независимых признака, и достаточно любого. Один общий
     * «режим» здесь был бы хуже: признаки означают разное и меняются
     * порознь.
     */
    const breaks = [
      { executionMode: 'live' },
      { liveExecutionEnabled: true },
      { withdrawalsEnabled: true },
      { solanaNetwork: 'mainnet-beta' },
    ];

    for (const patch of breaks) {
      expect(paperTestSourceVerdict({ ...permissive, ...patch }).allowed, JSON.stringify(patch))
        .toBe(false);
    }
  });

  it('при полном наборе условий источник разрешён', () => {
    // Негативный контроль к четырём проверкам выше.
    expect(paperTestSourceVerdict(permissive).allowed).toBe(true);
  });
});

describe('И5. Тестовый источник не пишет в боевые данные', () => {
  it('настоящие адреса вне досягаемости', () => {
    /*
     * Цена в `Token` общая для всего приложения: терминал, радар и
     * все подборки читают её. Запись туда из тестового контура —
     * это подмена production market data для всех сразу.
     */
    const realMints = [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      'So11111111111111111111111111111111111111112',
      '',
    ];

    for (const mint of realMints) expect(paperTestWriteAllowed(mint), mint).toBe(false);
  });

  it('тестовое пространство доступно', () => {
    expect(paperTestWriteAllowed('TEST0deadbeef')).toBe(true);
  });
});

describe('И6. Планировщик не отвечает ready на неполной схеме', () => {
  /**
   * Снимок полной схемы, собранный из констант планировщика.
   *
   * Не сравнение списка с самим собой: тот же снимок проверен на
   * настоящем Postgres в `production-schema-repair.pglite.test.ts`.
   * Здесь проверяется только реакция на неполноту.
   */
  it('отсутствие поздней миграции в истории останавливает запуск', () => {
    const withoutOne = KNOWN_MIGRATIONS.filter(
      (name) => name !== PHASE4_RECONCILIATION_MIGRATION,
    );

    /*
     * История без миграции и схема без её объектов: это состояние
     * боевой базы, на котором прежний планировщик отвечал `ready`
     * — и приложение стартовало без `FundingSafetyLatch`.
     */
    const plan = planProductionSchemaRepair({
      userColumns: [],
      tables: [],
      enums: [],
      appliedMigrations: [...withoutOne],
      migrationDirectories: [...KNOWN_MIGRATIONS],
    } as never);

    expect(plan.action).not.toBe('ready');
  });
});
