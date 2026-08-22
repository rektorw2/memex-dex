import { describe, expect, it } from 'vitest';
import {
  ACCESS_ENUMS,
  ACCESS_MIGRATION,
  ACCESS_TABLES,
  ACCESS_USER_COLUMNS,
  BASELINE_MIGRATION,
  BASE_USER_COLUMNS,
  planProductionSchemaRepair,
  type ProductionSchemaSnapshot,
} from './production-schema-repair.js';

function legacySnapshot(): ProductionSchemaSnapshot {
  return {
    userColumns: [...BASE_USER_COLUMNS],
    tables: ['User', 'WalletActivity'],
    enums: ['UserRole'],
    appliedMigrations: null,
  };
}

function readySnapshot(): ProductionSchemaSnapshot {
  return {
    userColumns: [...BASE_USER_COLUMNS, ...ACCESS_USER_COLUMNS],
    tables: ['User', ...ACCESS_TABLES],
    enums: [...ACCESS_ENUMS],
    appliedMigrations: [BASELINE_MIGRATION, ACCESS_MIGRATION],
  };
}

describe('безопасное исправление боевой схемы', () => {
  it('не меняет готовую базу', () => {
    expect(planProductionSchemaRepair(readySnapshot())).toEqual({ action: 'ready' });
  });

  it('разрешает точный переход с прежней схемы', () => {
    expect(planProductionSchemaRepair(legacySnapshot())).toEqual({
      action: 'apply-access-migration',
      resolveBaseline: true,
    });
  });

  it('не помечает baseline второй раз', () => {
    const snapshot = legacySnapshot();
    snapshot.appliedMigrations = [BASELINE_MIGRATION];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'apply-access-migration',
      resolveBaseline: false,
    });
  });

  it('отказывается продолжать частично применённую миграцию', () => {
    const snapshot = legacySnapshot();
    snapshot.userColumns.push('emailVerifiedAt');

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_ACCESS_MIGRATION',
    });
  });

  it('отказывается при противоречии истории и объектов базы', () => {
    const snapshot = legacySnapshot();
    snapshot.appliedMigrations = [BASELINE_MIGRATION, ACCESS_MIGRATION];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'MIGRATION_HISTORY_CONTRADICTS_SCHEMA',
    });
  });

  it('не пытается превратить пустую базу в существующую', () => {
    const snapshot = legacySnapshot();
    snapshot.userColumns = [];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'BASELINE_USER_SCHEMA_MISSING',
    });
  });
});
