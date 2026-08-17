/**
 * Чтение фактической схемы базы и вердикт о её готовности.
 *
 * Отделено от договора (`schema-contract.ts`) намеренно: договор
 * и сравнение — чистые, их проверяют тестами без Postgres, а здесь
 * остаётся только то, что без базы проверить нельзя, — два запроса
 * к системным каталогам.
 *
 * Проверка строго на чтение. Ни одна ветка этого модуля не создаёт
 * и не меняет объектов базы: `db push` на старте боевого процесса —
 * это молчаливая миграция в момент наибольшей нагрузки, и обнаружить
 * её последствия было бы нечем.
 */

import { prisma } from './prisma.js';
import { logger } from './logger.js';
import { compareSchema, type DbSnapshot, type SchemaCheckResult } from './schema-contract.js';

export * from './schema-contract.js';

// ──────────────────────────── Чтение снимка ─────────────────────────────────

interface ColumnRow {
  table_name: string;
  column_name: string;
}

interface IndexRow {
  table_name: string;
  columns: string[];
}

/**
 * Снимок текущей схемы.
 *
 * Два запроса только на чтение к системным каталогам. Ни `CREATE`,
 * ни `ALTER`, ни `db push` здесь нет: задача — узнать состояние,
 * а не привести его в порядок.
 */
export async function readSnapshot(): Promise<DbSnapshot> {
  const columns = await prisma.$queryRaw<ColumnRow[]>`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
  `;

  const uniques = await prisma.$queryRaw<IndexRow[]>`
    SELECT c.relname AS table_name,
           array_agg(a.attname ORDER BY k.ord) AS columns
    FROM pg_class c
    JOIN pg_index ix ON c.oid = ix.indrelid
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    CROSS JOIN LATERAL unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
    WHERE n.nspname = current_schema()
      AND ix.indisunique
    GROUP BY c.relname, i.relname
  `;

  const tables: Record<string, string[]> = {};
  for (const row of columns) {
    (tables[row.table_name] ??= []).push(row.column_name);
  }

  return {
    tables,
    uniques: uniques.map((u) => ({ table: u.table_name, columns: u.columns })),
  };
}

// ──────────────────────────── Состояние модуля ──────────────────────────────

let cached: SchemaCheckResult | null = null;

/**
 * Проверка схемы.
 *
 * Недоступная база и устаревшая схема различаются намеренно: первое
 * лечится ожиданием, второе — командой `npm run db:push`, и путать
 * их значит чинить не то.
 */
export async function checkSchema(): Promise<SchemaCheckResult> {
  const checkedAt = new Date().toISOString();

  try {
    const missingObjects = compareSchema(await readSnapshot());

    cached = {
      status: missingObjects.length === 0 ? 'ok' : 'outdated',
      missingObjects,
      checkedAt,
    };
  } catch (e: any) {
    // Наружу уходит только код. Текст ошибки драйвера содержит хост
    // и имя пользователя базы, а этот объект попадает в открытый ответ.
    cached = {
      status: 'unavailable',
      missingObjects: [],
      checkedAt,
      errorCode: e?.code ?? e?.name ?? 'unknown',
    };
  }

  return cached;
}

/** Последний известный результат. null — проверка ещё не выполнялась. */
export function lastSchemaCheck(): SchemaCheckResult | null {
  return cached;
}

/**
 * Можно ли запускать то, что зависит от таблиц кошельков.
 *
 * Недоступная база отличается от устаревшей схемы: подключение может
 * восстановиться само, и запрещать из-за него запуск воркера значило
 * бы оставить пересчёт выключенным до перезапуска процесса.
 */
export function isLedgerSchemaReady(): boolean {
  return cached?.status !== 'outdated';
}

/**
 * Проверка при старте с записью в журнал.
 *
 * Возвращает признак готовности, чтобы вызывающий решил, что
 * запускать. Исключение наружу не бросается: отказ проверки не должен
 * мешать подняться остальному API.
 */
export async function guardSchemaOnStartup(): Promise<boolean> {
  const result = await checkSchema();

  if (result.status === 'ok') return true;

  if (result.status === 'unavailable') {
    logger.warn(
      { errorCode: result.errorCode },
      'проверка схемы не выполнена: база недоступна, воркеры кошельков не запущены',
    );
    return false;
  }

  logger.error(
    { missing: result.missingObjects.slice(0, 20), action: 'DATABASE_SCHEMA_UPDATE_REQUIRED' },
    'схема базы отстала от кода: воркеры кошельков не запущены, выполните npm run db:push',
  );

  return false;
}

/** Для тестов: сбросить запомненный результат. */
export function resetSchemaCheck(): void {
  cached = null;
}
