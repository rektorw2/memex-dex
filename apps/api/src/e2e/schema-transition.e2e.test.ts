import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import {
  KNOWN_MIGRATIONS,
  INTENT_LIFECYCLE_MIGRATION,
  PHASE4_RECONCILIATION_MIGRATION,
  SIGNING_IDENTITY_MIGRATION,
  SOLANA_NETWORK_PROOF_MIGRATION,
  TRANSACTION_INTENT_MIGRATION,
  planProductionSchemaRepair,
} from '../lib/production-schema-repair.js';
import { readProductionSchemaSnapshot, type RawQuery } from '../lib/production-schema-snapshot.js';
import { migrationNames } from './harness.js';

/**
 * Переход боевой схемы через настоящий `prisma migrate deploy`.
 *
 * Проверяется то, что произойдёт при выкладке на базе, отставшей на
 * поздние миграции Phase 4. Это ровно то состояние, в котором
 * была боевая база: планировщик отвечал `ready` на схеме без
 * `FundingSafetyLatch`, приложение стартовало, и первый же запрос
 * `/agent` падал.
 *
 * Два правила, купленные дорого.
 *
 * Первое: **файлы миграций здесь не выполняются вручную**. Прежняя
 * версия отдавала `migration.sql` в `$executeRawUnsafe` и получала
 * `42601: cannot insert multiple commands into a prepared statement` —
 * тот же дефект, который до этого уже чинили в подготовке стенда.
 * Отставшее состояние теперь собирается настоящей CLI на временном
 * каталоге миграций, куда скопированы только ранние.
 *
 * Второе: **у каждого теста своя база**. Общая на всех давала
 * `database "..._transition" already exists` и перемотку схемы из-под
 * соседнего теста. Имя содержит `e2e`, создаётся и удаляется здесь же.
 */

const require_ = createRequire(import.meta.url);
const ROOT = new URL('../../../../', import.meta.url).pathname;

/**
 * Поздние миграции Phase 4 — те, которых не было в боевой базе.
 *
 * Порядок совпадает с порядком применения: планировщик перечисляет
 * непринятые в том же порядке, и сравнение списков заодно проверяет,
 * что новая миграция встала в конец, а не в середину.
 */
const LATE = [
  PHASE4_RECONCILIATION_MIGRATION,
  TRANSACTION_INTENT_MIGRATION,
  INTENT_LIFECYCLE_MIGRATION,
  SIGNING_IDENTITY_MIGRATION,
  SOLANA_NETWORK_PROOF_MIGRATION,
];

const EARLY = KNOWN_MIGRATIONS.filter((name) => !LATE.includes(name));

let db: PrismaClient;
let dbName: string;
let dbUrl: string;
let schemaDir: string;

/** Уникальное имя базы. `e2e` в имени — условие защиты стенда. */
function newDatabaseName(): string {
  return `memex_e2e_transition_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

function urlFor(name: string): string {
  const base = process.env.E2E_DATABASE_URL!;
  const at = base.lastIndexOf('/');
  const query = base.slice(at + 1).split('?')[1];
  return `${base.slice(0, at)}/${name}${query ? `?${query}` : ''}`;
}

/**
 * Временный каталог схемы с подмножеством миграций.
 *
 * `cwd` процесса CLI ставится сюда же: иначе Prisma нашла бы корневой
 * `prisma.config.ts`, где путь к миграциям задан явно, и взяла бы
 * полный каталог вместо нужного подмножества.
 */
function makeSchemaDir(migrations: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'memex-e2e-schema-'));
  writeFileSync(join(dir, 'schema.prisma'), readFileSync(`${ROOT}prisma/schema.prisma`, 'utf8'));

  const target = join(dir, 'migrations');
  mkdirSync(target);
  cpSync(`${ROOT}prisma/migrations/migration_lock.toml`, join(target, 'migration_lock.toml'));
  for (const name of migrations) {
    cpSync(`${ROOT}prisma/migrations/${name}`, join(target, name), { recursive: true });
  }
  return dir;
}

/** Добавить миграции в уже существующий временный каталог. */
function addMigrations(dir: string, migrations: string[]): void {
  for (const name of migrations) {
    cpSync(`${ROOT}prisma/migrations/${name}`, join(dir, 'migrations', name), { recursive: true });
  }
}

/** Настоящий `prisma migrate deploy`. Без оболочки, адрес — только в окружении. */
function migrateDeploy(dir: string): { status: number | null; output: string } {
  const result = spawnSync(
    process.execPath,
    [require_.resolve('prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
    {
      cwd: dir,
      env: { ...process.env, DATABASE_URL: dbUrl, DIRECT_DATABASE_URL: dbUrl },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split('\n')
    .filter((line) => !/postgres(ql)?:\/\//i.test(line))
    .join('\n');

  return { status: result.status, output };
}

/** Снимок и вердикт планировщика — как их видит загрузчик на старте. */
async function plan(migrations: string[] | null = migrationNames()) {
  const query: RawQuery = (sql, params) =>
    db.$queryRawUnsafe(sql, ...(params as unknown[])) as Promise<{ name: string }[]>;
  return planProductionSchemaRepair(await readProductionSchemaSnapshot(query, migrations));
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ${name}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ${table} AND column_name = ${column}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

beforeEach(async () => {
  dbName = newDatabaseName();
  dbUrl = urlFor(dbName);
  await prisma.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`);

  // Отставшее состояние: только ранние миграции, настоящей CLI.
  schemaDir = makeSchemaDir([...EARLY]);
  const prepared = migrateDeploy(schemaDir);
  expect(prepared.status, prepared.output).toBe(0);

  db = new PrismaClient({ datasources: { db: { url: dbUrl } } });
}, 180_000);

afterEach(async () => {
  await db?.$disconnect();
  rmSync(schemaDir, { recursive: true, force: true });

  /*
   * Удаляется только временная база этого теста — та, чьё имя мы
   * сами и сгенерировали. Ничего другого стенд не трогает.
   */
  expect(dbName, 'удалять можно только временную базу стенда').toMatch(/^memex_e2e_transition_/);
  await prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
}, 120_000);

describe('база отстала на поздние миграции Phase 4', () => {
  it('планировщик требует ровно их', async () => {
    const verdict = await plan();

    expect(verdict.action, 'отставшая база не готова').toBe('apply-migrations');
    if (verdict.action !== 'apply-migrations') throw new Error('недостижимо');
    expect(verdict.pending).toEqual(LATE);
  });

  it('объектов поздних миграций в схеме нет', async () => {
    // Негативный контроль: состояние действительно отставшее.
    expect(await tableExists('FundingSafetyLatch')).toBe(false);
    expect(await tableExists('TransactionIntent')).toBe(false);
    expect(await tableExists('SigningIdentity')).toBe(false);
    expect(await tableExists('SolanaNetworkProof')).toBe(false);
  });

  it('ранние миграции при этом применены', async () => {
    // Иначе «отставшая база» была бы просто пустой.
    expect(await tableExists('PaperAgentRun')).toBe(true);
    expect(await tableExists('SolanaDepositEvent')).toBe(true);
  });
});

describe('настоящий migrate deploy доводит схему', () => {
  it('применяет все поздние миграции и создаёт объекты', async () => {
    addMigrations(schemaDir, LATE);
    const result = migrateDeploy(schemaDir);
    expect(result.status, result.output).toBe(0);

    expect(await tableExists('FundingSafetyLatch'), 'предохранитель зачисления').toBe(true);
    expect(await tableExists('SolanaDepositAddressCursor')).toBe(true);
    expect(await tableExists('TransactionIntent'), 'намерение транзакции').toBe(true);
    expect(await tableExists('SigningAttempt')).toBe(true);
    expect(await tableExists('SigningIdentity'), 'реестр подписантов').toBe(true);
    expect(await tableExists('SolanaNetworkProof'), 'доказательство проверки сети').toBe(true);
    expect(await columnExists('TransactionIntent', 'proposalId'), 'колонки жизненного цикла').toBe(
      true,
    );
    expect(await columnExists('SolanaDepositEvent', 'reconcileNotBefore')).toBe(true);
  });

  it('после применения планировщик отвечает ready', async () => {
    addMigrations(schemaDir, LATE);
    expect(migrateDeploy(schemaDir).status).toBe(0);

    expect(await plan()).toEqual({ action: 'ready' });
  });

  it('повторный deploy идемпотентен и не дублирует историю', async () => {
    addMigrations(schemaDir, LATE);
    expect(migrateDeploy(schemaDir).status).toBe(0);
    const second = migrateDeploy(schemaDir);

    expect(second.status, second.output).toBe(0);
    expect(await plan(), 'повтор ничего не меняет').toEqual({ action: 'ready' });

    const duplicates = await db.$queryRawUnsafe<Array<{ migration_name: string }>>(
      `SELECT migration_name FROM "_prisma_migrations" GROUP BY migration_name HAVING count(*) > 1`,
    );
    expect(duplicates, 'миграция не записана дважды').toEqual([]);
  });
});

describe('противоречия останавливают запуск', () => {
  it('история без схемы — отказ', async () => {
    /*
     * Запись о миграции есть, объектов нет. Prisma такую миграцию
     * больше не накатит, а приложение обратится к несуществующей
     * таблице на первом же запросе.
     *
     * Пишется одна строка истории — это не применение миграции,
     * поэтому многокомандного SQL здесь нет.
     */
    await db.$executeRawUnsafe(
      `INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","finished_at","applied_steps_count")
       VALUES (gen_random_uuid()::text, 'e2e', $1, now(), 1)`,
      PHASE4_RECONCILIATION_MIGRATION,
    );

    expect(await plan()).toEqual({
      action: 'refuse',
      reason: 'PHASE4_RECONCILIATION_HISTORY_CONTRADICTS_SCHEMA',
    });
  });

  it('схема без истории — отказ', async () => {
    /*
     * След `db push`: объекты созданы мимо истории. Миграция
     * применяется настоящей CLI, после чего запись истории
     * удаляется — так состояние получается без ручного SQL.
     */
    addMigrations(schemaDir, [PHASE4_RECONCILIATION_MIGRATION]);
    expect(migrateDeploy(schemaDir).status).toBe(0);
    await db.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
      PHASE4_RECONCILIATION_MIGRATION,
    );

    expect(await plan()).toEqual({
      action: 'refuse',
      reason: 'PHASE4_RECONCILIATION_SCHEMA_AHEAD_OF_HISTORY',
    });
  });

  it('частично применённая миграция — отказ', async () => {
    /*
     * Ровно боевое состояние: часть объектов есть, последнего нет.
     * Собирается тоже без ручного SQL: миграция применяется целиком
     * настоящей CLI, после чего удаляется один созданный ею объект
     * и запись истории.
     */
    addMigrations(schemaDir, [PHASE4_RECONCILIATION_MIGRATION]);
    expect(migrateDeploy(schemaDir).status).toBe(0);

    await db.$executeRawUnsafe('DROP TABLE "FundingSafetyLatch"');
    await db.$executeRawUnsafe(
      `DELETE FROM "_prisma_migrations" WHERE migration_name = $1`,
      PHASE4_RECONCILIATION_MIGRATION,
    );

    expect(await plan()).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PHASE4_RECONCILIATION_MIGRATION',
    });
  });

  it('незнакомая миграция в каталоге — отказ даже на готовой схеме', async () => {
    addMigrations(schemaDir, LATE);
    expect(migrateDeploy(schemaDir).status).toBe(0);

    expect(await plan([...migrationNames(), '20270101000000_unreviewed'])).toEqual({
      action: 'refuse',
      reason: 'UNKNOWN_MIGRATION_PRESENT',
    });
  });
});
