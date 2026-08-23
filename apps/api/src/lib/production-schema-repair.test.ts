import { describe, expect, it } from 'vitest';
import {
  ACCESS_ENUMS,
  ACCESS_MIGRATION,
  ACCESS_TABLES,
  ACCESS_USER_COLUMNS,
  BASELINE_MIGRATION,
  BASE_USER_COLUMNS,
  KNOWN_MIGRATIONS,
  CHECK_QUEUE_MIGRATION,
  CHECK_QUEUE_TOKEN_COLUMNS,
  MARKET_AGE_MIGRATION,
  MARKET_AGE_TOKEN_COLUMNS,
  OKX_SIGNAL_MIGRATION,
  OKX_SIGNAL_TABLES,
  planProductionSchemaRepair,
  type ProductionSchemaSnapshot,
} from './production-schema-repair.js';

/**
 * Что загрузчик делает с боевой базой при запуске.
 *
 * Проверка здесь дешевле любой другой: ошибка в этом файле означает
 * либо неприменённую миграцию и пятисотые на боевых маршрутах, либо
 * `ALTER`, уехавший в production вместе с обычным деплоем.
 *
 * Один такой разрыв уже случился. Миграция возраста рынка приехала
 * в репозиторий, а загрузчик про неё не знал: он проверял только
 * артефакты доступа, находил их на месте и возвращал `ready`,
 * после чего `migrate deploy` не вызывался вовсе.
 */

/** База до миграции доступа: `db push` создал таблицы, истории нет. */
function legacySnapshot(): ProductionSchemaSnapshot {
  return {
    userColumns: [...BASE_USER_COLUMNS],
    tokenColumns: ['id', 'chain', 'address'],
    tables: ['User', 'Token', 'WalletActivity'],
    enums: ['UserRole'],
    appliedMigrations: null,
    migrationsOnDisk: [...KNOWN_MIGRATIONS],
  };
}

/** База с применённой миграцией доступа, но без возраста рынка. */
function accessOnlySnapshot(): ProductionSchemaSnapshot {
  return {
    userColumns: [...BASE_USER_COLUMNS, ...ACCESS_USER_COLUMNS],
    tokenColumns: ['id', 'chain', 'address'],
    tables: ['User', 'Token', ...ACCESS_TABLES],
    enums: [...ACCESS_ENUMS],
    appliedMigrations: [BASELINE_MIGRATION, ACCESS_MIGRATION],
    migrationsOnDisk: [...KNOWN_MIGRATIONS],
  };
}

/** Всё применено. */
function readySnapshot(): ProductionSchemaSnapshot {
  const s = accessOnlySnapshot();
  s.tokenColumns = [...s.tokenColumns, ...MARKET_AGE_TOKEN_COLUMNS, ...CHECK_QUEUE_TOKEN_COLUMNS];
  s.tables = [...s.tables, ...OKX_SIGNAL_TABLES];
  s.appliedMigrations = [...KNOWN_MIGRATIONS];
  return s;
}

describe('готовая база', () => {
  it('не трогается', () => {
    expect(planProductionSchemaRepair(readySnapshot())).toEqual({ action: 'ready' });
  });

  it('повторный запуск ничего не делает', () => {
    // Entrypoint выполняется на каждом деплое; второй проход
    // обязан быть пустым.
    const first = planProductionSchemaRepair(readySnapshot());
    const second = planProductionSchemaRepair(readySnapshot());

    expect(first).toEqual({ action: 'ready' });
    expect(second).toEqual(first);
  });

  it('после перехода migrate deploy больше не нужен', () => {
    // Состояние «до» требует применения, состояние «после» — нет.
    const before = planProductionSchemaRepair(accessOnlySnapshot());
    expect(before.action).toBe('apply-migrations');

    const after = accessOnlySnapshot();
    after.tokenColumns = [
      ...after.tokenColumns,
      ...MARKET_AGE_TOKEN_COLUMNS,
      ...CHECK_QUEUE_TOKEN_COLUMNS,
    ];
    after.appliedMigrations = [...KNOWN_MIGRATIONS];
    after.tables = [...after.tables, ...OKX_SIGNAL_TABLES];

    expect(planProductionSchemaRepair(after)).toEqual({ action: 'ready' });
  });
});

describe('переход с прежней схемы', () => {
  it('база без доступа получает все недостающие миграции', () => {
    expect(planProductionSchemaRepair(legacySnapshot())).toEqual({
      action: 'apply-migrations',
      resolveBaseline: true,
      pending: [ACCESS_MIGRATION, MARKET_AGE_MIGRATION, CHECK_QUEUE_MIGRATION, OKX_SIGNAL_MIGRATION],
    });
  });

  it('baseline не помечается второй раз', () => {
    const snapshot = legacySnapshot();
    snapshot.appliedMigrations = [BASELINE_MIGRATION];

    const plan = planProductionSchemaRepair(snapshot);

    expect(plan).toMatchObject({ action: 'apply-migrations', resolveBaseline: false });
  });

  it('база с доступом получает только возраст рынка', () => {
    // Ровно то состояние, которое загрузчик объявлял готовым:
    // артефакты доступа на месте, колонок возраста нет.
    expect(planProductionSchemaRepair(accessOnlySnapshot())).toEqual({
      action: 'apply-migrations',
      resolveBaseline: false,
      pending: [MARKET_AGE_MIGRATION, CHECK_QUEUE_MIGRATION, OKX_SIGNAL_MIGRATION],
    });
  });
});

describe('отказ при неожиданном состоянии', () => {
  it('пустая база не превращается в существующую', () => {
    const snapshot = legacySnapshot();
    snapshot.userColumns = [];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'BASELINE_USER_SCHEMA_MISSING',
    });
  });

  it('половина миграции доступа', () => {
    const snapshot = legacySnapshot();
    snapshot.userColumns.push('emailVerifiedAt');

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_ACCESS_MIGRATION',
    });
  });

  it.each([...MARKET_AGE_TOKEN_COLUMNS])('только колонка %s из двух', (column) => {
    // Досыпать недостающую вслепую нельзя: неизвестно, что ещё
    // не доехало и почему применение оборвалось.
    const snapshot = accessOnlySnapshot();
    snapshot.tokenColumns = [...snapshot.tokenColumns, column];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_MARKET_AGE_MIGRATION',
    });
  });

  it('история доступа противоречит схеме', () => {
    const snapshot = legacySnapshot();
    snapshot.appliedMigrations = [BASELINE_MIGRATION, ACCESS_MIGRATION];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'MIGRATION_HISTORY_CONTRADICTS_SCHEMA',
    });
  });

  it('история возраста рынка противоречит схеме', () => {
    // История утверждает, что миграция применена, а колонок нет:
    // повторное применение упало бы, а молчать об этом нельзя.
    const snapshot = accessOnlySnapshot();
    snapshot.appliedMigrations = [...KNOWN_MIGRATIONS];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'MARKET_AGE_HISTORY_CONTRADICTS_SCHEMA',
    });
  });

  it('история Signal противоречит схеме', () => {
    const snapshot = readySnapshot();
    snapshot.tables = snapshot.tables.filter((table) => table !== 'OkxSignal');

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'OKX_SIGNAL_HISTORY_CONTRADICTS_SCHEMA',
    });
  });

  it('незнакомая миграция в репозитории останавливает загрузчик', () => {
    /*
     * Главная защита файла. `migrate deploy` применяет всё
     * непринятое, поэтому единственный способ не выпустить
     * неосторожный ALTER в production — знать заранее, что именно
     * будет применено.
     */
    const snapshot = accessOnlySnapshot();
    snapshot.migrationsOnDisk = [...KNOWN_MIGRATIONS, '20270101000000_drop_everything'];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'UNKNOWN_MIGRATION_PRESENT',
    });
  });

  it('незнакомая миграция важнее любого другого состояния', () => {
    const snapshot = readySnapshot();
    snapshot.migrationsOnDisk = [...KNOWN_MIGRATIONS, '20270101000000_surprise'];

    expect(planProductionSchemaRepair(snapshot).action).toBe('refuse');
  });

  it('нечитаемый каталог миграций останавливает загрузчик', () => {
    /*
     * Прежде здесь стоял обратный тест: каталога нет — проверка
     * пропускается, работаем дальше. Это и был последний путь,
     * по которому непрочитанная миграция могла уехать
     * в production: достаточно ошибки чтения.
     *
     * Схема при этом полностью готова — и всё равно отказ. Готовая
     * схема ничего не говорит о том, что лежит в каталоге.
     */
    const snapshot = readySnapshot();
    snapshot.migrationsOnDisk = null;

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'MIGRATIONS_DIRECTORY_UNREADABLE',
    });
  });

  it('пустой каталог миграций останавливает загрузчик', () => {
    // Каталог читается, но миграций в нём нет: образ собран
    // неправильно. `migrate deploy` не применил бы ничего
    // и завершился бы успехом.
    const snapshot = legacySnapshot();
    snapshot.migrationsOnDisk = [];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'KNOWN_MIGRATION_FILE_MISSING',
    });
  });

  it('пропавший файл нужной миграции останавливает загрузчик', () => {
    const snapshot = legacySnapshot();
    snapshot.migrationsOnDisk = [BASELINE_MIGRATION, ACCESS_MIGRATION, MARKET_AGE_MIGRATION];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'KNOWN_MIGRATION_FILE_MISSING',
    });
  });
});

describe('схема впереди истории', () => {
  /*
   * Обратное противоречие: колонки есть, а записи о миграции нет.
   *
   * Считать это готовностью нельзя. Prisma по-прежнему видит
   * миграцию непринятой и попробует накатить её при следующем
   * деплое — на колонку, которая уже существует. Упадёт не сегодня,
   * а когда в репозиторий добавят следующую миграцию, и связать
   * падение с этим состоянием будет уже нечем.
   */

  it('колонки возраста есть, записи о миграции нет', () => {
    const snapshot = accessOnlySnapshot();
    snapshot.tokenColumns = [...snapshot.tokenColumns, ...MARKET_AGE_TOKEN_COLUMNS];
    // Очередь ещё не применялась — до неё проверка просто не дойдёт.

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'MARKET_AGE_SCHEMA_AHEAD_OF_HISTORY',
    });
  });

  it('артефакты доступа есть, записи о миграции нет', () => {
    const snapshot = readySnapshot();
    snapshot.appliedMigrations = [BASELINE_MIGRATION, MARKET_AGE_MIGRATION, CHECK_QUEUE_MIGRATION];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'ACCESS_SCHEMA_AHEAD_OF_HISTORY',
    });
  });

  it('схема изменена вручную, истории нет вовсе', () => {
    // Наследие `db push`, дошедшее до колонок возраста. Здесь
    // `migrate resolve --applied 0_baseline` уже не спасает:
    // следом `migrate deploy` упал бы на существующей колонке.
    const snapshot = readySnapshot();
    snapshot.appliedMigrations = null;

    expect(planProductionSchemaRepair(snapshot).action).toBe('refuse');
  });

  it('отсутствие baseline в истории отказом не считается', () => {
    // Это ровно то состояние, ради которого загрузчик и написан:
    // таблицы от `db push`, истории нет. Лечится `migrate resolve`.
    const snapshot = legacySnapshot();

    expect(planProductionSchemaRepair(snapshot)).toMatchObject({
      action: 'apply-migrations',
      resolveBaseline: true,
    });
  });
});

describe('список известных миграций', () => {
  it('совпадает с каталогом в репозитории', async () => {
    /*
     * Ровно та проверка, которой не хватило. Миграция появилась
     * в репозитории, а список известных остался прежним — и загрузчик
     * молча не применил её.
     */
    const { readdirSync } = await import('node:fs');

    // Путь от файла, а не от рабочего каталога: vitest запускается
    // из `apps/api`, загрузчик — из корня образа.
    const dir = new URL('../../../../prisma/migrations', import.meta.url);

    const onDisk = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();

    expect(onDisk).toEqual([...KNOWN_MIGRATIONS].sort());
  });
});
