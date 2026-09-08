import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { migrationNames, migrationSql } from './harness.js';

/**
 * Схема накатана настоящей командой `prisma migrate deploy`.
 *
 * Этот файл существует из-за конкретной поломки. Первая версия стенда
 * применяла миграции сама: читала `migration.sql` и отдавала его одним
 * вызовом `$executeRawUnsafe`. PostgreSQL ответил
 * `42601: cannot insert multiple commands into a prepared statement` —
 * расширенный протокол не принимает несколько команд в одном запросе.
 * Прогон при этом выглядел почти безобидно: один упавший набор и
 * четырнадцать «пропущенных» тестов, то есть ни одного выполненного
 * сценария при почти зелёном отчёте.
 *
 * Очевидная починка — поделить файл по `;` — хуже болезни: точка с
 * запятой встречается внутри строковых литералов, тел функций и
 * `$$`-блоков, и такой разбор ломает миграцию тем незаметнее, чем
 * сложнее она написана.
 *
 * Поэтому схему накатывает Prisma, а этот файл доказывает, что
 * многокомандные миграции действительно применились целиком.
 */

afterAll(async () => {
  await prisma.$disconnect();
});

/** Сколько команд в файле миграции. Оценка сверху, но для отбора хватает. */
function commandCount(sql: string): number {
  return sql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .filter((part) => part.trim().length > 0).length;
}

/** Первая миграция каталога, содержащая больше одной команды. */
function multiCommandMigration(): { name: string; commands: number } {
  for (const name of migrationNames()) {
    const commands = commandCount(migrationSql(name));
    if (commands > 1) return { name, commands };
  }
  throw new Error('в каталоге нет ни одной миграции с несколькими командами');
}

async function tableExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM information_schema.tables
    WHERE table_schema = current_schema() AND table_name = ${name}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function columnExists(table: string, column: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ${table}
      AND column_name = ${column}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

async function indexExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*)::bigint AS count
    FROM pg_indexes
    WHERE schemaname = current_schema() AND indexname = ${name}
  `;
  return Number(rows[0]?.count ?? 0) > 0;
}

describe('миграции применены целиком', () => {
  it('в истории есть все миграции каталога', async () => {
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
      'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
    );
    const applied = new Set(rows.map((row) => row.migration_name));

    expect(migrationNames().filter((name) => !applied.has(name))).toEqual([]);
  });

  it('в каталоге есть многокомандная миграция — иначе проверять нечего', () => {
    /*
     * Негативный контроль к тесту ниже. Если бы все миграции состояли
     * из одной команды, проверка «многокомандная применилась» проходила
     * бы, ничего не проверяя.
     */
    const { commands } = multiCommandMigration();

    expect(commands).toBeGreaterThan(1);
  });

  it('многокомандная миграция применилась целиком, а не первой командой', async () => {
    /*
     * Взята миграция сверки депозитов: `ALTER TABLE` с семью
     * колонками, затем `CREATE INDEX`, затем две `CREATE TABLE`.
     * Ровно тот случай, на котором ломался прежний способ: он
     * выполнил бы первую команду и упал, оставив таблицы без
     * индекса и без двух других таблиц.
     */
    expect(await columnExists('SolanaDepositEvent', 'lastChainSeenAt')).toBe(true);
    expect(await columnExists('SolanaDepositEvent', 'reconcileNotBefore')).toBe(true);
    expect(await indexExists('SolanaDepositEvent_state_reconcileNotBefore_idx')).toBe(true);
    expect(await tableExists('SolanaDepositAddressCursor')).toBe(true);
    expect(await tableExists('FundingSafetyLatch')).toBe(true);
  });

  it('объекты последней миграции тоже на месте', async () => {
    // Порядок применения важен не меньше полноты: обрыв на середине
    // каталога оставил бы ранние миграции применёнными, поздние — нет.
    expect(await tableExists('SigningIdentity')).toBe(true);
    expect(await tableExists('TransactionIntent')).toBe(true);
    expect(await tableExists('SigningAttempt')).toBe(true);
    expect(await columnExists('TransactionIntent', 'proposalId')).toBe(true);
    expect(await indexExists('TransactionIntent_one_live_per_proposal')).toBe(true);
  });

  it('повторный запуск ничего не ломает', async () => {
    /*
     * Идемпотентность проверяется тем же способом, каким её увидит
     * человек: `migrate deploy` уже отработал в глобальной подготовке,
     * а этот прогон — как минимум второй для базы, если она осталась
     * с прошлого раза. История не должна содержать дублей.
     */
    const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string; count: bigint }>>(
      `SELECT migration_name, count(*)::bigint AS count
       FROM "_prisma_migrations"
       GROUP BY migration_name
       HAVING count(*) > 1`,
    );

    expect(rows, 'миграция не должна быть записана дважды').toEqual([]);
  });
});
