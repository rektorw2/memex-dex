import { spawnSync } from 'node:child_process';
import { prisma } from './lib/prisma.js';
import {
  ACCESS_ENUMS,
  ACCESS_TABLES,
  ACCESS_USER_COLUMNS,
  BASE_USER_COLUMNS,
  planProductionSchemaRepair,
  type ProductionSchemaSnapshot,
} from './lib/production-schema-repair.js';

interface NameRow {
  name: string;
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<NameRow[]>`
    SELECT table_name AS name
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ${name}
  `;
  return rows.length === 1;
}

async function readSnapshot(): Promise<ProductionSchemaSnapshot> {
  const [userColumns, tables, enums] = await Promise.all([
    prisma.$queryRaw<NameRow[]>`
      SELECT column_name AS name
      FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'User'
    `,
    prisma.$queryRaw<NameRow[]>`
      SELECT table_name AS name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
    `,
    prisma.$queryRaw<NameRow[]>`
      SELECT t.typname AS name
      FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = current_schema() AND t.typtype = 'e'
    `,
  ]);

  let appliedMigrations: string[] | null = null;
  if (await tableExists('_prisma_migrations')) {
    const rows = await prisma.$queryRaw<NameRow[]>`
      SELECT migration_name AS name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL
    `;
    appliedMigrations = rows.map((row) => row.name);
  }

  return {
    userColumns: userColumns.map((row) => row.name),
    tables: tables.map((row) => row.name),
    enums: enums.map((row) => row.name),
    appliedMigrations,
  };
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

  console.log('production schema: applying verified additive access migration');
  if (plan.resolveBaseline) {
    runPrisma(['migrate', 'resolve', '--applied', '0_baseline']);
  }
  runPrisma(['migrate', 'deploy']);

  const after = planProductionSchemaRepair(await readSnapshot());
  if (after.action !== 'ready') {
    throw new Error(`production schema verification failed; expected ${describeExpectedState()}`);
  }

  console.log('production schema: access migration applied and verified');
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
