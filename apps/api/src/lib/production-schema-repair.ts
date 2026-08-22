/**
 * Решение для единственного поддерживаемого перехода боевой базы:
 * baseline уже существует, а миграция подписок ещё не применена.
 *
 * Здесь нет SQL и побочных эффектов. Классификация вынесена отдельно,
 * чтобы отказ на частично изменённой схеме проверялся без живой базы.
 */

export const BASELINE_MIGRATION = '0_baseline';
export const ACCESS_MIGRATION = '20260821120000_add_subscriptions_and_trial';

export const BASE_USER_COLUMNS = ['id', 'email', 'passwordHash'] as const;
export const ACCESS_USER_COLUMNS = [
  'emailVerifiedAt',
  'emailCodeHash',
  'emailCodeIssuedAt',
  'emailCodeExpires',
  'emailCodeAttempts',
] as const;

export const ACCESS_TABLES = [
  'Subscription',
  'EntitlementAudit',
  'PaymentCustomer',
  'SubscriptionPayment',
  'WebhookReceipt',
] as const;

export const ACCESS_ENUMS = [
  'PlanCode',
  'SubscriptionStatus',
  'SubscriptionSource',
  'PaymentProvider',
  'PaymentState',
  'KycState',
] as const;

export interface ProductionSchemaSnapshot {
  userColumns: string[];
  tables: string[];
  enums: string[];
  /** null означает, что таблицы истории Prisma ещё нет. */
  appliedMigrations: string[] | null;
}

export type ProductionSchemaPlan =
  | { action: 'ready' }
  | { action: 'apply-access-migration'; resolveBaseline: boolean }
  | { action: 'refuse'; reason: string };

export function planProductionSchemaRepair(
  snapshot: ProductionSchemaSnapshot,
): ProductionSchemaPlan {
  const user = new Set(snapshot.userColumns);
  const tables = new Set(snapshot.tables);
  const enums = new Set(snapshot.enums);

  if (BASE_USER_COLUMNS.some((column) => !user.has(column))) {
    return { action: 'refuse', reason: 'BASELINE_USER_SCHEMA_MISSING' };
  }

  const accessArtifacts = [
    ...ACCESS_USER_COLUMNS.map((column) => user.has(column)),
    ...ACCESS_TABLES.map((table) => tables.has(table)),
    ...ACCESS_ENUMS.map((type) => enums.has(type)),
  ];

  if (accessArtifacts.every(Boolean)) return { action: 'ready' };

  if (accessArtifacts.some(Boolean)) {
    return { action: 'refuse', reason: 'PARTIAL_ACCESS_MIGRATION' };
  }

  if (snapshot.appliedMigrations?.includes(ACCESS_MIGRATION)) {
    return { action: 'refuse', reason: 'MIGRATION_HISTORY_CONTRADICTS_SCHEMA' };
  }

  return {
    action: 'apply-access-migration',
    resolveBaseline: !snapshot.appliedMigrations?.includes(BASELINE_MIGRATION),
  };
}
