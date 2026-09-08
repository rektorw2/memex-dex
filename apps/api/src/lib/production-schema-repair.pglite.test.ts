import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

import {
  KNOWN_MIGRATIONS,
  ACCESS_MIGRATION,
  MARKET_AGE_MIGRATION,
  PHASE4_RECONCILIATION_MIGRATION,
  TRANSACTION_INTENT_MIGRATION,
  INTENT_LIFECYCLE_MIGRATION,
  SIGNING_IDENTITY_MIGRATION,
  SOLANA_NETWORK_PROOF_MIGRATION,
  PAPER_EXIT_PLAN_MIGRATION,
  BASELINE_MIGRATION,
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

/**
 * Что планировщик обязан потребовать после перечисленных миграций.
 *
 * Ожидание строится из каталога, а не переписывается руками. Прежде
 * после каждого шага стоял свой список, и при добавлении миграции их
 * приходилось править все: правился первый, остальные оставались
 * вчерашними — и молчали, потому что первый же `expect` останавливал
 * сценарий и до них дело не доходило.
 *
 * Сравнением источника с самим собой это не является. Production
 * `pending` собирается из **шагов планировщика**, а они ведутся
 * отдельным списком; ожидание здесь идёт от `KNOWN_MIGRATIONS`.
 * Расхождение между «миграция известна» и «у миграции есть шаг
 * проверки» — ровно тот разрыв, из-за которого база без
 * `FundingSafetyLatch` однажды объявила себя готовой. Матрица ниже
 * дополнительно проверяет каждую позднюю миграцию поимённо и во всех
 * пяти состояниях.
 */
function pendingAfter(...applied: readonly string[]): string[] {
  const done = new Set<string>([BASELINE_MIGRATION, ...applied]);
  return KNOWN_MIGRATIONS.filter((name) => !done.has(name));
}

/** Порядок применения: каталог без baseline. */
const IN_ORDER = KNOWN_MIGRATIONS.filter((name) => name !== BASELINE_MIGRATION);

describe('загрузчик на настоящей схеме', () => {
  it('проводит базу через все миграции по очереди', async () => {
    const db = await PGlite.create();

    // Шаг 0. Прежняя боевая база: `db push` создал таблицы,
    // истории миграций нет вовсе.
    await db.exec(sqlOf(BASELINE_MIGRATION));

    expect(await planOf(db), 'на прежней схеме нужны все миграции').toEqual({
      action: 'apply-migrations',
      resolveBaseline: true,
      pending: pendingAfter(),
    });

    // Шаг 1. `migrate resolve --applied 0_baseline`.
    await markApplied(db, BASELINE_MIGRATION);

    expect(await planOf(db)).toMatchObject({ resolveBaseline: false });

    /*
     * Дальше — по одной миграции за шаг, в порядке каталога.
     *
     * Каждая применяется настоящим SQL и отмечается в истории так же,
     * как это делает `migrate deploy`. После каждого шага ожидание
     * пересчитывается: остаться должно ровно то, что ещё не
     * применено, и в том же порядке.
     */
    const applied: string[] = [];

    for (const migration of IN_ORDER) {
      await db.exec(sqlOf(migration));
      await markApplied(db, migration);
      applied.push(migration);

      const rest = pendingAfter(...applied);
      const plan = await planOf(db);

      if (rest.length === 0) {
        expect(plan, `после ${migration} схема должна сойтись`).toEqual({ action: 'ready' });
      } else {
        expect(plan, `после ${migration} остаётся ${rest.length}`).toEqual({
          action: 'apply-migrations',
          resolveBaseline: false,
          pending: rest,
        });
      }
    }

    /*
     * Страховки к производному ожиданию.
     *
     * Цикл по пустому или устаревшему каталогу не падает — он просто
     * не выполняет шагов, и прогон остаётся зелёным. Поэтому здесь
     * названо поимённо то, что цикл обязан был сделать.
     */
    expect([...KNOWN_MIGRATIONS], 'каталог знает о доказательстве сети').toContain(
      SOLANA_NETWORK_PROOF_MIGRATION,
    );
    expect([...KNOWN_MIGRATIONS], 'каталог знает о плане выхода').toContain(
      PAPER_EXIT_PLAN_MIGRATION,
    );
    expect(KNOWN_MIGRATIONS.at(-1), 'он последний в каталоге').toBe(
      PAPER_EXIT_PLAN_MIGRATION,
    );
    expect(applied, 'сценарий применил доказательство проверки сети').toContain(
      SOLANA_NETWORK_PROOF_MIGRATION,
    );
    expect(applied.at(-1), 'и применил план выхода последним — перед ready').toBe(
      PAPER_EXIT_PLAN_MIGRATION,
    );
    expect(applied, 'применено ровно то и в том порядке, что в каталоге').toEqual(IN_ORDER);

    // Сам helper тоже проверен: без этих двух строк он мог бы
    // возвращать пустой список и делать зелёным любой шаг.
    expect(pendingAfter(), 'baseline из ожидания исключён').not.toContain(BASELINE_MIGRATION);
    expect(pendingAfter(), 'до первого шага ждать есть чего').not.toEqual([]);
    expect(pendingAfter(...IN_ORDER), 'применено всё — ждать нечего').toEqual([]);

    // Следующий деплой ничего не делает.
    expect(await planOf(db), 'повтор идемпотентен').toEqual({ action: 'ready' });

    await db.close();
  }, 30_000);

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

/**
 * Шесть состояний каждой поздней миграции Phase 4 — на настоящем
 * Postgres.
 *
 * Юнит-тесты рядом строят снимок руками, и это их предел: если
 * `readProductionSchemaSnapshot` спрашивает не ту системную таблицу
 * или пишет имя индекса с другим регистром, рукописный снимок этого
 * не покажет. Здесь состояние базы создают сами миграции, а снимок
 * читается теми же запросами, что и в production.
 */

/**
 * Разбор миграции на отдельные операторы.
 *
 * Нужен для состояния «применение оборвалось посередине»: половина
 * объектов создана, половины нет. Ни в одной миграции репозитория
 * нет `$$`-блоков, поэтому деления по `;` достаточно; если это
 * когда-нибудь перестанет быть правдой, `db.exec` упадёт на
 * искалеченном операторе — молча тест не пройдёт.
 */
function statementsOf(sql: string): string[] {
  return sql
    .split(/;\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.replace(/--[^\n]*/g, '').trim().length > 0);
}

/** Применить всё, что идёт в каталоге до указанной миграции. */
async function applyBefore(db: PGlite, migration: string): Promise<void> {
  for (const name of KNOWN_MIGRATIONS) {
    if (name === migration) return;
    await db.exec(sqlOf(name));
    await markApplied(db, name);
  }
  throw new Error(`${migration} нет в KNOWN_MIGRATIONS`);
}

const LATE_PHASE4 = [
  { migration: PHASE4_RECONCILIATION_MIGRATION, prefix: 'PHASE4_RECONCILIATION' },
  { migration: TRANSACTION_INTENT_MIGRATION, prefix: 'TRANSACTION_INTENT' },
  { migration: INTENT_LIFECYCLE_MIGRATION, prefix: 'INTENT_LIFECYCLE' },
  { migration: SIGNING_IDENTITY_MIGRATION, prefix: 'SIGNING_IDENTITY' },
  { migration: SOLANA_NETWORK_PROOF_MIGRATION, prefix: 'SOLANA_NETWORK_PROOF' },
  { migration: PAPER_EXIT_PLAN_MIGRATION, prefix: 'PAPER_EXIT_PLAN' },
] as const;

describe('матрица поздних миграций не отстала от каталога', () => {
  it('доказательство сети в ней названо поимённо', () => {
    /*
     * Явное утверждение рядом с `describe.each`. Матрица по
     * устаревшему списку не падает — она просто не выполняет
     * тестов для забытой миграции, и прогон остаётся зелёным.
     */
    const covered = LATE_PHASE4.map((row) => row.migration);

    expect(covered).toContain(SOLANA_NETWORK_PROOF_MIGRATION);
    expect(covered).toContain(PAPER_EXIT_PLAN_MIGRATION);
    expect(covered, 'поздних миграций Phase 4').toHaveLength(6);
    expect(covered, 'дубликатов нет').toEqual([...new Set(covered)]);

    // Опечатка в имени превратила бы `applyBefore` в применение
    // всего каталога, и матрица проверяла бы уже готовую схему.
    for (const migration of covered) {
      expect([...KNOWN_MIGRATIONS], migration).toContain(migration);
    }
  });
});

describe.each(LATE_PHASE4)('поздняя миграция $migration на настоящем Postgres', ({
  migration,
  prefix,
}) => {
  it('полностью отсутствующая попадает в pending', async () => {
    const db = await PGlite.create();
    await applyBefore(db, migration);

    const plan = await planOf(db);

    expect(plan).toMatchObject({ action: 'apply-migrations' });
    if (plan.action !== 'apply-migrations') throw new Error('недостижимо');
    expect(plan.pending).toContain(migration);

    await db.close();
  }, 20_000);

  it('полностью применённая даёт ready', async () => {
    const db = await PGlite.create();
    for (const name of KNOWN_MIGRATIONS) {
      await db.exec(sqlOf(name));
      await markApplied(db, name);
    }

    expect(await planOf(db)).toEqual({ action: 'ready' });

    await db.close();
  }, 20_000);

  it('история без схемы останавливает запуск', async () => {
    /*
     * Запись в `_prisma_migrations` есть, объектов нет. Prisma
     * такую миграцию больше не накатит, а приложение обратится
     * к несуществующей таблице на первом же запросе.
     */
    const db = await PGlite.create();
    await applyBefore(db, migration);
    await markApplied(db, migration);

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: `${prefix}_HISTORY_CONTRADICTS_SCHEMA`,
    });

    await db.close();
  }, 20_000);

  it('схема без истории останавливает запуск', async () => {
    // След `db push`: объекты созданы мимо истории. Молчание здесь
    // означает упавший деплой при следующей миграции в репозитории.
    const db = await PGlite.create();
    await applyBefore(db, migration);
    await db.exec(sqlOf(migration));

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: `${prefix}_SCHEMA_AHEAD_OF_HISTORY`,
    });

    await db.close();
  }, 20_000);

  it('оборванное применение останавливает запуск', async () => {
    /*
     * Ровно то состояние, что было в production: колонки и часть
     * таблиц есть, последнего объекта нет. Досыпать недостающее
     * вслепую нельзя — решение принимает человек.
     */
    const db = await PGlite.create();
    await applyBefore(db, migration);

    const parts = statementsOf(sqlOf(migration));
    expect(parts.length, 'миграция из одного оператора не может быть частичной').toBeGreaterThan(1);
    for (const part of parts.slice(0, -1)) await db.exec(`${part};`);

    expect(await planOf(db)).toEqual({
      action: 'refuse',
      reason: `PARTIAL_${prefix}_MIGRATION`,
    });

    await db.close();
  }, 20_000);

  it('незнакомая миграция важнее готовности', async () => {
    // Полная схема не отменяет проверку каталога: неизвестный
    // файл рядом означает, что репозиторий и контейнер разошлись.
    const db = await PGlite.create();
    for (const name of KNOWN_MIGRATIONS) {
      await db.exec(sqlOf(name));
      await markApplied(db, name);
    }

    expect(await planOf(db, [...onDisk(), '20270101000000_unreviewed'])).toEqual({
      action: 'refuse',
      reason: 'UNKNOWN_MIGRATION_PRESENT',
    });

    await db.close();
  }, 20_000);
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
