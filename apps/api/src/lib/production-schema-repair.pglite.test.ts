import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import {
  KNOWN_MIGRATIONS,
  ACCESS_MIGRATION,
  MARKET_AGE_MIGRATION,
  planProductionSchemaRepair,
} from './production-schema-repair.js';
import { readProductionSchemaSnapshot, type RawQuery } from './production-schema-snapshot.js';

/**
 * Планировщик против настоящих миграций.
 *
 * Юнит-тесты рядом проверяют логику решений, но не могут поймать
 * главную ошибку этого файла: список ожидаемых колонок написан
 * руками, и тест сверяет его с тем же списком. Опечатка
 * в `poolCreatedAt` прошла бы их все, а деплой остановился бы
 * в production.
 *
 * Здесь колонки берутся из SQL миграций, а состояние — из живого
 * Postgres. PGlite — это Postgres в WebAssembly: тот же
 * information_schema, те же имена, тот же регистр.
 *
 * Проверяется ровно та последовательность, которую увидит боевая
 * база: сначала прежняя схема без истории, потом каждая миграция
 * по очереди, и на каждом шаге — что скажет загрузчик.
 */

const ROOT = new URL('../../../../', import.meta.url).pathname;

const sqlOf = (name: string) =>
  readFileSync(`${ROOT}prisma/migrations/${name}/migration.sql`, 'utf8');

/** Каталог миграций, как его видит загрузчик в контейнере. */
const onDisk = () =>
  readdirSync(`${ROOT}prisma/migrations`, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

/** Адаптер PGlite под тот же интерфейс, через который ходит Prisma. */
function queryVia(db: PGlite): RawQuery {
  return async (sql, params) => {
    const r = await db.query<{ name: string }>(sql, params as never[]);
    return r.rows;
  };
}

/**
 * Отметка в истории Prisma.
 *
 * Загрузчик читает её наравне со схемой, поэтому подделывать
 * состояние «миграция применена» нельзя: `migrate deploy` пишет
 * сюда, и тест обязан писать так же.
 */
async function markApplied(db: PGlite, name: string): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
      "id" varchar(36) PRIMARY KEY,
      "checksum" varchar(64) NOT NULL,
      "finished_at" timestamptz,
      "migration_name" varchar(255) NOT NULL,
      "logs" text,
      "rolled_back_at" timestamptz,
      "started_at" timestamptz NOT NULL DEFAULT now(),
      "applied_steps_count" integer NOT NULL DEFAULT 0
    );
    INSERT INTO "_prisma_migrations" ("id","checksum","migration_name","finished_at","applied_steps_count")
    VALUES (gen_random_uuid()::text, 'x', '${name}', now(), 1);
  `);
}

const planOf = (db: PGlite, migrations: string[] | null = onDisk()) =>
  readProductionSchemaSnapshot(queryVia(db), migrations).then(planProductionSchemaRepair);

describe('загрузчик на настоящей схеме', () => {
  it('проводит базу через все миграции по очереди', async () => {
    const db = await PGlite.create();

    // Шаг 0. Прежняя боевая база: `db push` создал таблицы,
    // истории миграций нет вовсе.
    await db.exec(sqlOf('0_baseline'));

    expect(await planOf(db), 'на прежней схеме нужны обе миграции').toEqual({
      action: 'apply-migrations',
      resolveBaseline: true,
      pending: [ACCESS_MIGRATION, MARKET_AGE_MIGRATION],
    });

    // Шаг 1. `migrate resolve --applied 0_baseline`.
    await markApplied(db, '0_baseline');

    expect(await planOf(db)).toMatchObject({ resolveBaseline: false });

    // Шаг 2. Миграция доступа.
    await db.exec(sqlOf(ACCESS_MIGRATION));
    await markApplied(db, ACCESS_MIGRATION);

    expect(await planOf(db), 'остаётся возраст рынка').toEqual({
      action: 'apply-migrations',
      resolveBaseline: false,
      pending: [MARKET_AGE_MIGRATION],
    });

    // Шаг 3. Возраст рынка — та миграция, которую прежний
    // загрузчик не замечал вовсе.
    await db.exec(sqlOf(MARKET_AGE_MIGRATION));
    await markApplied(db, MARKET_AGE_MIGRATION);

    expect(await planOf(db), 'схема сошлась').toEqual({ action: 'ready' });

    // Шаг 4. Следующий деплой ничего не делает.
    expect(await planOf(db)).toEqual({ action: 'ready' });

    await db.close();
  });

  it('видит незнакомую миграцию в каталоге', async () => {
    const db = await PGlite.create();
    await db.exec(sqlOf('0_baseline'));

    const plan = await planOf(db, [...onDisk(), '20270101000000_unreviewed']);

    expect(plan).toEqual({ action: 'refuse', reason: 'UNKNOWN_MIGRATION_PRESENT' });

    await db.close();
  });

  it('замечает оборванную миграцию возраста рынка', async () => {
    // Половина колонок: применение упало посередине. Досыпать
    // недостающую вслепую нельзя.
    const db = await PGlite.create();
    await db.exec(sqlOf('0_baseline'));
    await db.exec(sqlOf(ACCESS_MIGRATION));
    await markApplied(db, '0_baseline');
    await markApplied(db, ACCESS_MIGRATION);
    await db.exec(`ALTER TABLE "Token" ADD COLUMN "poolCreatedAt" TIMESTAMP(3);`);

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_MARKET_AGE_MIGRATION',
    });

    await db.close();
  });

  it('не верит истории, если колонок нет', async () => {
    const db = await PGlite.create();
    await db.exec(sqlOf('0_baseline'));
    await db.exec(sqlOf(ACCESS_MIGRATION));
    for (const name of KNOWN_MIGRATIONS) await markApplied(db, name);

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: 'MARKET_AGE_HISTORY_CONTRADICTS_SCHEMA',
    });

    await db.close();
  });

  it('видит колонки, которых нет в истории', async () => {
    /*
     * Обратное противоречие, и самое коварное: схема готова,
     * приложение работает, загрузчик молчал бы. А Prisma считает
     * миграцию непринятой и уронит деплой тогда, когда в репозиторий
     * добавят следующую.
     *
     * Колонки создаются настоящей миграцией, но запись в историю
     * не попадает — ровно то, что оставляет после себя `db push`.
     */
    const db = await PGlite.create();
    await db.exec(sqlOf('0_baseline'));
    await db.exec(sqlOf(ACCESS_MIGRATION));
    await markApplied(db, '0_baseline');
    await markApplied(db, ACCESS_MIGRATION);
    await db.exec(sqlOf(MARKET_AGE_MIGRATION));

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: 'MARKET_AGE_SCHEMA_AHEAD_OF_HISTORY',
    });

    await db.close();
  });

  it('нечитаемый каталог миграций останавливает даже готовую базу', async () => {
    // Готовность схемы ничего не говорит о содержимом каталога,
    // и ошибка чтения не должна снимать проверку.
    const db = await PGlite.create();
    for (const name of KNOWN_MIGRATIONS) {
      await db.exec(sqlOf(name));
      await markApplied(db, name);
    }

    expect(await planOf(db, null)).toEqual({
      action: 'refuse',
      reason: 'MIGRATIONS_DIRECTORY_UNREADABLE',
    });

    await db.close();
  });

  it('отказывается работать с пустой базой', async () => {
    // Ни одной таблицы: это не боевая база, а чужое подключение
    // или пустая строка соединения. Накатывать сюда нельзя.
    const db = await PGlite.create();

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: 'BASELINE_USER_SCHEMA_MISSING',
    });

    await db.close();
  });
});

describe('имена, которых ждёт загрузчик', () => {
  it('колонки возраста рынка действительно создаются миграцией', async () => {
    /*
     * Смысл всего файла. `MARKET_AGE_TOKEN_COLUMNS` — рукописный
     * список; ошибка в нём означает вечный `PARTIAL_...` или
     * молчаливый `ready` на несошедшейся схеме.
     *
     * Сверка идёт с полной схемой: планировщик признал её готовой
     * выше только потому, что нашёл в базе ровно те имена.
     */
    const db = await PGlite.create();
    for (const name of KNOWN_MIGRATIONS) {
      await db.exec(sqlOf(name));
      await markApplied(db, name);
    }

    expect(await planOf(db)).toEqual({ action: 'ready' });

    await db.close();
  });

  it('список известных миграций совпадает с каталогом', () => {
    expect(onDisk().sort()).toEqual([...KNOWN_MIGRATIONS].sort());
  });
});
