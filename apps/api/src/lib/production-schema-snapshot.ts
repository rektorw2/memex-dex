/**
 * Чтение состояния схемы из живой базы.
 *
 * Вынесено из загрузчика ради одной проверки. Список колонок,
 * которых ждёт планировщик, написан руками, и юнит-тесты сверяют
 * его сам с собой: опечатка в `poolCreatedAt` прошла бы их все
 * и остановила деплой уже в production.
 *
 * Поэтому те же самые запросы прогоняются по настоящему Postgres
 * с настоящими миграциями. Копия запросов в тесте доказывала бы
 * правильность копии.
 *
 * Работает через `$queryRawUnsafe`, потому что вызывающих двое —
 * Prisma и PGlite — и тегированные шаблоны Prisma сюда не проходят.
 * Внешних значений в SQL нет: все параметры ниже — константы файла.
 */

import type { ProductionSchemaSnapshot } from './production-schema-repair.js';

/** Минимум, который умеют и Prisma, и PGlite. */
export type RawQuery = (sql: string, params: unknown[]) => Promise<{ name: string }[]>;

const COLUMNS_OF = `
  SELECT column_name AS name
  FROM information_schema.columns
  WHERE table_schema = current_schema() AND table_name = $1
`;

const TABLES = `
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = current_schema()
`;

const ENUMS = `
  SELECT t.typname AS name
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE n.nspname = current_schema() AND t.typtype = 'e'
`;

const HISTORY_TABLE = `
  SELECT table_name AS name
  FROM information_schema.tables
  WHERE table_schema = current_schema() AND table_name = '_prisma_migrations'
`;

const APPLIED = `
  SELECT migration_name AS name
  FROM "_prisma_migrations"
  WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
`;

/**
 * Снимок схемы.
 *
 * `migrationsOnDisk` приходит снаружи: каталог миграций к базе
 * отношения не имеет, а в тесте он подставляется свой.
 */
export async function readProductionSchemaSnapshot(
  query: RawQuery,
  migrationsOnDisk: string[] | null,
): Promise<ProductionSchemaSnapshot> {
  const names = (rows: { name: string }[]) => rows.map((row) => row.name);

  const [userColumns, tokenColumns, tables, enums] = await Promise.all([
    query(COLUMNS_OF, ['User']),
    query(COLUMNS_OF, ['Token']),
    query(TABLES, []),
    query(ENUMS, []),
  ]);

  /*
   * История читается только при наличии таблицы.
   *
   * До первой миграции её нет вовсе, и запрос упал бы. `null`
   * здесь — не «миграций не применяли», а «истории не существует»:
   * именно это состояние и оставил после себя `db push`.
   */
  const hasHistory = (await query(HISTORY_TABLE, [])).length === 1;

  return {
    userColumns: names(userColumns),
    tokenColumns: names(tokenColumns),
    tables: names(tables),
    enums: names(enums),
    appliedMigrations: hasHistory ? names(await query(APPLIED, [])) : null,
    migrationsOnDisk,
  };
}
