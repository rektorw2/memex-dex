import { spawnSync } from 'node:child_process';
import { migrationsOnDisk } from './lib/migrations-on-disk.js';
import { prisma } from './lib/prisma.js';
import {
  ACCESS_ENUMS,
  ACCESS_TABLES,
  ACCESS_USER_COLUMNS,
  BASE_USER_COLUMNS,
  CHECK_QUEUE_TOKEN_COLUMNS,
  MARKET_AGE_TOKEN_COLUMNS,
  OKX_SIGNAL_ATH_COLUMNS,
  planProductionSchemaRepair,
  type ProductionSchemaSnapshot,
} from './lib/production-schema-repair.js';
import { readProductionSchemaSnapshot } from './lib/production-schema-snapshot.js';

function readSnapshot(): Promise<ProductionSchemaSnapshot> {
  // Те же самые запросы прогоняются по PGlite в тесте: список
  // ожидаемых колонок написан руками, и сверять его с самим собой
  // бесполезно.
  return readProductionSchemaSnapshot(
    (sql, params) => prisma.$queryRawUnsafe<{ name: string }[]>(sql, ...params),
    migrationsOnDisk(),
  );
}

function runPrisma(args: string[]): void {
  const cli = 'node_modules/prisma/build/index.js';
  const migrationUrl = process.env.DIRECT_DATABASE_URL?.trim() || process.env.DATABASE_URL;
  const result = spawnSync(process.execPath, [cli, ...args, '--schema=prisma/schema.prisma'], {
    cwd: process.cwd(),
    // Приложение продолжает ходить через пул, а DDL при наличии прямой
    // строки идёт в обход pgbouncer. Значение нигде не печатается.
    env: { ...process.env, DATABASE_URL: migrationUrl },
    stdio: 'inherit',
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Prisma завершилась с кодом ${result.status ?? 'unknown'}`);
  }
}

function describeExpectedState(): string {
  return [
    ...BASE_USER_COLUMNS.map((name) => `User.${name}`),
    ...ACCESS_USER_COLUMNS.map((name) => `User.${name}`),
    ...MARKET_AGE_TOKEN_COLUMNS.map((name) => `Token.${name}`),
    ...CHECK_QUEUE_TOKEN_COLUMNS.map((name) => `Token.${name}`),
    ...OKX_SIGNAL_ATH_COLUMNS.map((name) => `OkxSignal.${name}`),
    ...ACCESS_TABLES,
    ...ACCESS_ENUMS,
  ].join(', ');
}

async function main(): Promise<void> {
  const before = await readSnapshot();
  const plan = planProductionSchemaRepair(before);

  if (plan.action === 'ready') {
    console.log('production schema: ready');
    return;
  }

  if (plan.action === 'refuse') {
    throw new Error(`production schema repair refused: ${plan.reason}`);
  }

  // Имена миграций — не секрет и полезны в журнале деплоя: по ним
  // видно, что именно применялось.
  console.log(`production schema: applying verified additive migrations: ${plan.pending.join(', ')}`);

  if (plan.resolveBaseline) {
    runPrisma(['migrate', 'resolve', '--applied', '0_baseline']);
  }
  runPrisma(['migrate', 'deploy']);

  /*
   * Схема перечитывается заново.
   *
   * Успешный код возврата `migrate deploy` означает, что команда
   * не упала, а не что колонки появились. Проверяет только чтение.
   */
  const after = planProductionSchemaRepair(await readSnapshot());
  if (after.action !== 'ready') {
    throw new Error(`production schema verification failed; expected ${describeExpectedState()}`);
  }

  console.log('production schema: migrations applied and verified');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
