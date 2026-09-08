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
  TRADE_PROVENANCE_MIGRATION,
  TRADE_PROVENANCE_COLUMNS,
  WALLET_SUMMARY_COLUMNS,
  WALLET_SUMMARY_MIGRATION,
  WALLET_ACTIVITY_PNL_COLUMNS,
  WALLET_ACTIVITY_PNL_MIGRATION,
  MARKET_AGE_MIGRATION,
  MARKET_AGE_TOKEN_COLUMNS,
  OKX_SIGNAL_MIGRATION,
  OKX_SIGNAL_ATH_MIGRATION,
  OKX_SIGNAL_ATH_COLUMNS,
  OKX_SIGNAL_TABLES,
  PAPER_AGENT_CONTROL_COLUMNS,
  PAPER_AGENT_MIGRATION,
  PAPER_AGENT_PHASE2_MIGRATION,
  PAPER_AGENT_PHASE3_MIGRATION,
  PAPER_AGENT_SIGNAL_PIPELINE_MIGRATION,
  PHASE4_LIVE_FOUNDATION_MIGRATION,
  PHASE4_LIVE_TABLES,
  PHASE4_LIVE_ENUMS,
  PAPER_AGENT_PHASE2_CONTROL_COLUMNS,
  PAPER_AGENT_PHASE2_RUN_COLUMNS,
  PAPER_AGENT_PHASE3_CONTROL_COLUMNS,
  PAPER_AGENT_ALLOCATION_POLICY_COLUMNS,
  PAPER_AGENT_ACCOUNT_SESSION_COLUMNS,
  PAPER_AGENT_ALLOCATION_COLUMNS,
  PAPER_AGENT_CAPITAL_LEDGER_COLUMNS,
  PAPER_AGENT_NOTIFICATION_COLUMNS,
  PAPER_AGENT_OKX_SIGNAL_COLUMNS,
  PAPER_AGENT_RUN_COLUMNS,
  PAPER_AGENT_SIGNAL_PIPELINE_OKX_COLUMNS,
  PAPER_AGENT_SIGNAL_PIPELINE_RUN_COLUMNS,
  PAPER_AGENT_STRATEGY_COLUMNS,
  PHASE4_RECONCILIATION_MIGRATION,
  PHASE4_RECONCILIATION_EVENT_COLUMNS,
  PHASE4_RECONCILIATION_TABLES,
  PHASE4_RECONCILIATION_INDEXES,
  TRANSACTION_INTENT_MIGRATION,
  TRANSACTION_INTENT_TABLES,
  TRANSACTION_INTENT_INDEXES,
  INTENT_LIFECYCLE_MIGRATION,
  INTENT_LIFECYCLE_COLUMNS,
  INTENT_LIFECYCLE_INDEXES,
  SIGNING_IDENTITY_MIGRATION,
  SIGNING_IDENTITY_TABLES,
  SIGNING_IDENTITY_INDEXES,
  SOLANA_NETWORK_PROOF_MIGRATION,
  SOLANA_NETWORK_PROOF_TABLES,
  SOLANA_NETWORK_PROOF_INDEXES,
  PAPER_EXIT_PLAN_MIGRATION,
  PAPER_EXIT_PLAN_COLUMNS,
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
    okxSignalColumns: [],
    paperAgentControlColumns: [],
    paperAgentStrategyColumns: [],
    paperAgentRunColumns: [],
    paperAgentNotificationColumns: [],
    paperAgentAllocationPolicyColumns: [],
    paperAgentAccountSessionColumns: [],
    paperAgentAllocationColumns: [],
    paperAgentCapitalLedgerColumns: [],
    economicTradeColumns: [],
    traderWalletColumns: [],
    walletActivityColumns: [],
    solanaDepositEventColumns: [],
    transactionIntentColumns: [],
    tables: ['User', 'Token', 'WalletActivity'],
    enums: ['UserRole'],
    indexes: [],
    appliedMigrations: null,
    migrationsOnDisk: [...KNOWN_MIGRATIONS],
  };
}

/** База с применённой миграцией доступа, но без возраста рынка. */
function accessOnlySnapshot(): ProductionSchemaSnapshot {
  return {
    userColumns: [...BASE_USER_COLUMNS, ...ACCESS_USER_COLUMNS],
    tokenColumns: ['id', 'chain', 'address'],
    okxSignalColumns: [],
    paperAgentControlColumns: [],
    paperAgentStrategyColumns: [],
    paperAgentRunColumns: [],
    paperAgentNotificationColumns: [],
    paperAgentAllocationPolicyColumns: [],
    paperAgentAccountSessionColumns: [],
    paperAgentAllocationColumns: [],
    paperAgentCapitalLedgerColumns: [],
    economicTradeColumns: [],
    traderWalletColumns: [],
    walletActivityColumns: [],
    solanaDepositEventColumns: [],
    transactionIntentColumns: [],
    tables: ['User', 'Token', ...ACCESS_TABLES],
    enums: [...ACCESS_ENUMS],
    indexes: [],
    appliedMigrations: [BASELINE_MIGRATION, ACCESS_MIGRATION],
    migrationsOnDisk: [...KNOWN_MIGRATIONS],
  };
}

/** Всё применено. */
function readySnapshot(): ProductionSchemaSnapshot {
  const s = accessOnlySnapshot();
  s.tokenColumns = [...s.tokenColumns, ...MARKET_AGE_TOKEN_COLUMNS, ...CHECK_QUEUE_TOKEN_COLUMNS];
  s.tables = [...s.tables, ...OKX_SIGNAL_TABLES];
  s.okxSignalColumns = [...OKX_SIGNAL_ATH_COLUMNS];
  s.okxSignalColumns.push(...PAPER_AGENT_OKX_SIGNAL_COLUMNS);
  s.paperAgentControlColumns = [...PAPER_AGENT_CONTROL_COLUMNS];
  s.paperAgentStrategyColumns = [...PAPER_AGENT_STRATEGY_COLUMNS];
  s.paperAgentRunColumns = [...PAPER_AGENT_RUN_COLUMNS];
  s.paperAgentControlColumns.push(...PAPER_AGENT_PHASE2_CONTROL_COLUMNS);
  s.paperAgentRunColumns.push(...PAPER_AGENT_PHASE2_RUN_COLUMNS);
  s.paperAgentNotificationColumns = [...PAPER_AGENT_NOTIFICATION_COLUMNS];
  s.paperAgentControlColumns.push(...PAPER_AGENT_PHASE3_CONTROL_COLUMNS);
  s.paperAgentAllocationPolicyColumns = [...PAPER_AGENT_ALLOCATION_POLICY_COLUMNS];
  s.paperAgentAccountSessionColumns = [...PAPER_AGENT_ACCOUNT_SESSION_COLUMNS];
  s.paperAgentAllocationColumns = [...PAPER_AGENT_ALLOCATION_COLUMNS, ...PAPER_EXIT_PLAN_COLUMNS];
  s.paperAgentCapitalLedgerColumns = [...PAPER_AGENT_CAPITAL_LEDGER_COLUMNS];
  s.okxSignalColumns.push(...PAPER_AGENT_SIGNAL_PIPELINE_OKX_COLUMNS);
  s.paperAgentRunColumns.push(...PAPER_AGENT_SIGNAL_PIPELINE_RUN_COLUMNS);
  s.tables.push(
    'PaperAgentControl',
    'PaperAgentStrategy',
    'PaperAgentRun',
    'PaperAgentNotification',
    'PaperAgentAllocationPolicy',
    'PaperAgentAccountSession',
    'PaperAgentAllocation',
    'PaperAgentCapitalLedger',
    ...PHASE4_LIVE_TABLES,
  );
  s.enums.push(...PHASE4_LIVE_ENUMS);
  s.economicTradeColumns = [...TRADE_PROVENANCE_COLUMNS];
  s.traderWalletColumns = [...WALLET_SUMMARY_COLUMNS];
  s.walletActivityColumns = [...WALLET_ACTIVITY_PNL_COLUMNS];
  // Объекты поздних миграций Phase 4.
  s.solanaDepositEventColumns = [...PHASE4_RECONCILIATION_EVENT_COLUMNS];
  s.transactionIntentColumns = [...INTENT_LIFECYCLE_COLUMNS];
  s.tables.push(
    ...PHASE4_RECONCILIATION_TABLES,
    ...TRANSACTION_INTENT_TABLES,
    ...SIGNING_IDENTITY_TABLES,
    ...SOLANA_NETWORK_PROOF_TABLES,
  );
  s.indexes = [
    ...PHASE4_RECONCILIATION_INDEXES,
    ...TRANSACTION_INTENT_INDEXES,
    ...INTENT_LIFECYCLE_INDEXES,
    ...SIGNING_IDENTITY_INDEXES,
    ...SOLANA_NETWORK_PROOF_INDEXES,
  ];
  s.appliedMigrations = [...KNOWN_MIGRATIONS];
  return s;
}

/**
 * Убрать из снимка всё, что принесла одна конкретная миграция.
 *
 * Нужна контрактному тесту: для каждой поздней миграции строится
 * база без неё, и планировщик обязан её потребовать.
 */
function dropSchemaOf(s: ProductionSchemaSnapshot, migration: string): void {
  const withoutTables = (names: readonly string[]) => {
    s.tables = s.tables.filter((t) => !names.includes(t));
  };
  const withoutIndexes = (names: readonly string[]) => {
    s.indexes = s.indexes.filter((i) => !names.includes(i));
  };

  switch (migration) {
    case PHASE4_RECONCILIATION_MIGRATION:
      s.solanaDepositEventColumns = [];
      withoutTables(PHASE4_RECONCILIATION_TABLES);
      withoutIndexes(PHASE4_RECONCILIATION_INDEXES);
      return;
    case TRANSACTION_INTENT_MIGRATION:
      withoutTables(TRANSACTION_INTENT_TABLES);
      withoutIndexes(TRANSACTION_INTENT_INDEXES);
      return;
    case INTENT_LIFECYCLE_MIGRATION:
      s.transactionIntentColumns = [];
      withoutIndexes(INTENT_LIFECYCLE_INDEXES);
      return;
    case SIGNING_IDENTITY_MIGRATION:
      withoutTables(SIGNING_IDENTITY_TABLES);
      withoutIndexes(SIGNING_IDENTITY_INDEXES);
      return;
    case SOLANA_NETWORK_PROOF_MIGRATION:
      withoutTables(SOLANA_NETWORK_PROOF_TABLES);
      withoutIndexes(SOLANA_NETWORK_PROOF_INDEXES);
      return;
    case PAPER_EXIT_PLAN_MIGRATION:
      s.paperAgentAllocationColumns = s.paperAgentAllocationColumns.filter(
        (c) => !PAPER_EXIT_PLAN_COLUMNS.includes(c as never),
      );
      return;
    default:
      throw new Error(`нет правила очистки для ${migration}`);
  }
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

    /*
     * Состояние «после» — та же полная схема, что и в `readySnapshot`.
     * Повторять её здесь вторым списком нельзя: два списка расходятся
     * при добавлении миграции, и тест начинает проверять вчерашний
     * контракт.
     */
    const after = readySnapshot();

    expect(planProductionSchemaRepair(after)).toEqual({ action: 'ready' });
  });
});

describe('переход с прежней схемы', () => {
  it('база без доступа получает все недостающие миграции', () => {
    /*
     * Ожидание выведено из каталога, а не переписано руками.
     *
     * Ручной список приходилось дополнять при каждой новой миграции,
     * и он неизбежно отставал: именно поэтому эти тесты и упали.
     * Сравнение с `KNOWN_MIGRATIONS` не является сверкой источника с
     * самим собой: `pending` собирается из шагов планировщика, а
     * шаги — отдельный список. Расхождение между «миграция известна»
     * и «у миграции есть шаг проверки» — ровно тот разрыв, из-за
     * которого база без `FundingSafetyLatch` однажды получила `ready`.
     */
    expect(planProductionSchemaRepair(legacySnapshot())).toEqual({
      action: 'apply-migrations',
      resolveBaseline: true,
      pending: KNOWN_MIGRATIONS.filter((name) => name !== BASELINE_MIGRATION),
    });
  });

  it('последняя миграция каталога названа поимённо', () => {
    /*
     * Отдельное явное утверждение к производному ожиданию выше.
     * Без него ошибка спряталась бы за сравнением списка со списком:
     * забыть шаг проверки и одновременно забыть миграцию в каталоге
     * — и тест остался бы зелёным.
     */
    const plan = planProductionSchemaRepair(legacySnapshot());

    if (plan.action !== 'apply-migrations') throw new Error('ожидался apply-migrations');
    expect(plan.pending).toContain(SOLANA_NETWORK_PROOF_MIGRATION);
    expect(plan.pending).toContain(PAPER_EXIT_PLAN_MIGRATION);
    expect(plan.pending.at(-1), 'план выхода применяется последним').toBe(
      PAPER_EXIT_PLAN_MIGRATION,
    );
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
      pending: KNOWN_MIGRATIONS.filter(
        (name) => name !== BASELINE_MIGRATION && name !== ACCESS_MIGRATION,
      ),
    });
  });
});

describe('отказ при неожиданном состоянии', () => {
  it('половина миграции paper-агента останавливает запуск', () => {
    const snapshot = readySnapshot();
    snapshot.paperAgentRunColumns = snapshot.paperAgentRunColumns.filter(
      (column) => column !== 'realizedPnlUsd',
    );

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PAPER_AGENT_MIGRATION',
    });
  });

  it('половина Phase 2 paper-агента останавливает запуск', () => {
    const snapshot = readySnapshot();
    snapshot.paperAgentNotificationColumns = snapshot.paperAgentNotificationColumns.filter(
      (column) => column !== 'telegramStatus',
    );

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PAPER_AGENT_PHASE2_MIGRATION',
    });
  });

  it('половина Phase 3 paper-агента останавливает запуск', () => {
    const snapshot = readySnapshot();
    snapshot.paperAgentAllocationColumns = snapshot.paperAgentAllocationColumns.filter(
      (column) => column !== 'allocatedUsd',
    );

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PAPER_AGENT_PHASE3_MIGRATION',
    });
  });

  it('половина миграции происхождения сигналов останавливает запуск', () => {
    const snapshot = readySnapshot();
    snapshot.paperAgentRunColumns = snapshot.paperAgentRunColumns.filter(
      (column) => column !== 'endToEndLatencyMs',
    );

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PAPER_AGENT_SIGNAL_PIPELINE_MIGRATION',
    });
  });

  it('половина Phase 4 foundation останавливает запуск', () => {
    const snapshot = readySnapshot();
    snapshot.tables = snapshot.tables.filter((table) => table !== 'KmsAuditEvent');

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PHASE4_LIVE_FOUNDATION_MIGRATION',
    });
  });

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

  it.each([...OKX_SIGNAL_ATH_COLUMNS])('только колонка ATH %s из двух', (column) => {
    const snapshot = readySnapshot();
    snapshot.okxSignalColumns = [column];

    expect(planProductionSchemaRepair(snapshot)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_OKX_SIGNAL_ATH_MIGRATION',
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

// ═══════════ Поздние миграции Phase 4: разрыв планировщика ═══════════════════

/**
 * Поздние миграции Phase 4 — те, которых не было в боевой базе.
 *
 * Список один на весь блок. Раньше он повторялся в каждом тесте, и
 * при добавлении миграции обновлялся не везде: тесты продолжали
 * проверять вчерашний состав, ничего об этом не сообщая.
 */
const LATE_PHASE4 = [
  PHASE4_RECONCILIATION_MIGRATION,
  TRANSACTION_INTENT_MIGRATION,
  INTENT_LIFECYCLE_MIGRATION,
  SIGNING_IDENTITY_MIGRATION,
  SOLANA_NETWORK_PROOF_MIGRATION,
  PAPER_EXIT_PLAN_MIGRATION,
] as const;

/**
 * База, доехавшая до Phase 4 foundation и остановившаяся там.
 *
 * Ровно это и было в production: поздние миграции лежат
 * в репозитории, но ни в истории, ни в схеме их нет.
 */
function beforeLatePhase4(): ProductionSchemaSnapshot {
  const s = readySnapshot();
  s.appliedMigrations = (s.appliedMigrations ?? []).filter(
    (name) => !LATE_PHASE4.includes(name as (typeof LATE_PHASE4)[number]),
  );
  // Схема тоже без них: таблиц этих миграций в базе нет.
  s.tables = s.tables.filter(
    (t) =>
      ![
        'SolanaDepositAddressCursor',
        'FundingSafetyLatch',
        'TransactionIntent',
        'SigningAttempt',
        'SigningIdentity',
        ...SOLANA_NETWORK_PROOF_TABLES,
      ].includes(t),
  );
  s.solanaDepositEventColumns = [];
  s.transactionIntentColumns = [];
  s.paperAgentAllocationColumns = s.paperAgentAllocationColumns.filter(
    (c) => !PAPER_EXIT_PLAN_COLUMNS.includes(c as never),
  );
  s.indexes = [];
  return s;
}

describe('поздние миграции Phase 4 доходят до планировщика', () => {
  it('база без них не считается готовой', () => {
    /*
     * Тот самый разрыв. Список `KNOWN_MIGRATIONS` знал о поздних
     * миграциях — значит, они не «неизвестные» и запуск
     * не останавливали, — но проверяемых шагов у них не было.
     * Планировщик доходил до конца списка шагов, не находил
     * недостающего и отвечал `ready`.
     *
     * Дальше приложение стартовало на базе без `FundingSafetyLatch`,
     * первый же запрос `/paper-agent` падал, и человек видел
     * «Агент временно недоступен».
     */
    const plan = planProductionSchemaRepair(beforeLatePhase4());

    expect(plan.action).toBe('apply-migrations');
  });

  it('в pending перечислены все поздние миграции', () => {
    const plan = planProductionSchemaRepair(beforeLatePhase4());

    if (plan.action !== 'apply-migrations') throw new Error('ожидался apply-migrations');
    expect(plan.pending).toEqual(expect.arrayContaining([...LATE_PHASE4]));
    // Отдельно и поимённо: производное ожидание выше промолчало бы,
    // если бы миграцию забыли и в списке, и в шагах.
    expect(plan.pending, 'доказательство сети').toContain(SOLANA_NETWORK_PROOF_MIGRATION);
  });

  it('каждая поздняя миграция имеет свой шаг проверки', () => {
    /*
     * Контракт против повторения ошибки: добавить миграцию в список
     * и забыть шаг проверки теперь нельзя. Проверяется поведением,
     * а не сравнением списка с самим собой: для каждой миграции
     * строится база без неё, и планировщик обязан её потребовать.
     */
    for (const name of LATE_PHASE4) {
      const s = readySnapshot();
      s.appliedMigrations = (s.appliedMigrations ?? []).filter((m) => m !== name);
      dropSchemaOf(s, name);

      const plan = planProductionSchemaRepair(s);
      expect(plan.action, `миграция ${name} не проверяется`).toBe('apply-migrations');
      if (plan.action === 'apply-migrations') {
        expect(plan.pending, `миграция ${name} не попала в pending`).toContain(name);
      }
    }
  });
});

// ═══════════ Четыре состояния каждой поздней миграции ════════════════════════

/**
 * Матрица «история × схема» для каждой поздней миграции.
 *
 * Полностью применённая и полностью отсутствующая — простые случаи.
 * Опасны два перекошенных: история говорит «применено», а объектов
 * нет, либо наоборот. Оба означают, что кто-то правил базу мимо
 * миграций, и оба обязаны останавливать запуск, а не молча
 * достраиваться.
 */
describe.each([...LATE_PHASE4])('состояния миграции %s', (name) => {
  it('полностью применённая не требует ничего', () => {
    /*
     * Проверяется не только вердикт, но и что снимок действительно
     * содержит артефакты именно этой миграции. Иначе `ready` мог бы
     * получиться оттого, что о миграции просто забыли, — а это тот
     * самый разрыв, из-за которого база без `FundingSafetyLatch`
     * однажды объявила себя готовой.
     */
    const s = readySnapshot();
    const before = planProductionSchemaRepair(s);
    expect(before).toEqual({ action: 'ready' });

    const withoutIt = readySnapshot();
    dropSchemaOf(withoutIt, name);
    expect(
      planProductionSchemaRepair(withoutIt).action,
      `артефактов ${name} нет в готовом снимке`,
    ).not.toBe('ready');
  });

  it('полностью отсутствующая попадает в pending', () => {
    const s = readySnapshot();
    s.appliedMigrations = (s.appliedMigrations ?? []).filter((m) => m !== name);
    dropSchemaOf(s, name);

    const plan = planProductionSchemaRepair(s);

    expect(plan.action).toBe('apply-migrations');
    if (plan.action !== 'apply-migrations') throw new Error('недостижимо');
    expect(plan.pending).toContain(name);
  });

  it('история без схемы останавливает запуск', () => {
    /*
     * История утверждает, что миграция применена, а объектов нет.
     * Достроить их поверх такой истории значило бы согласиться с
     * записью, которая уже соврала.
     */
    const s = readySnapshot();
    dropSchemaOf(s, name);

    const plan = planProductionSchemaRepair(s);

    expect(plan.action).toBe('refuse');
    if (plan.action !== 'refuse') throw new Error('недостижимо');
    expect(plan.reason).toMatch(/HISTORY_CONTRADICTS_SCHEMA$/);
  });

  it('схема без истории останавливает запуск', () => {
    // Объекты есть, записи нет: `migrate deploy` попытался бы
    // создать их заново и упал на середине.
    const s = readySnapshot();
    s.appliedMigrations = (s.appliedMigrations ?? []).filter((m) => m !== name);

    const plan = planProductionSchemaRepair(s);

    expect(plan.action).toBe('refuse');
    if (plan.action !== 'refuse') throw new Error('недостижимо');
    expect(plan.reason).toMatch(/SCHEMA_AHEAD_OF_HISTORY$/);
  });
});

describe('матрица покрывает и новую миграцию', () => {
  it('доказательство сети названо в списке поздних поимённо', () => {
    /*
     * Явное утверждение рядом с производной матрицей. Без него
     * пустой или устаревший `LATE_PHASE4` дал бы зелёный прогон:
     * `describe.each` по пустому списку не выполняет ни одного теста.
     */
    expect([...LATE_PHASE4]).toContain(SOLANA_NETWORK_PROOF_MIGRATION);
    expect([...LATE_PHASE4]).toContain(PAPER_EXIT_PLAN_MIGRATION);
    expect(LATE_PHASE4.length, 'поздних миграций Phase 4').toBe(6);
  });

  it('частично применённая миграция доказательства останавливает запуск', () => {
    /*
     * Таблица создана, индекса нет. Для планировщика это «половина»,
     * и достраивать её вслепую нельзя: уникальность и порядок
     * чтения задаёт как раз индекс.
     */
    const s = readySnapshot();
    s.indexes = s.indexes.filter(
      (index) => !SOLANA_NETWORK_PROOF_INDEXES.includes(index as never),
    );

    expect(planProductionSchemaRepair(s)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_SOLANA_NETWORK_PROOF_MIGRATION',
    });
  });

  it('частично применённый план выхода останавливает запуск', () => {
    // Есть план, нет состояния: позиция с правилом, но без хода
    // его исполнения. Достраивать колонку вслепую нельзя.
    const s = readySnapshot();
    s.paperAgentAllocationColumns = s.paperAgentAllocationColumns.filter((c) => c !== 'exitState');

    expect(planProductionSchemaRepair(s)).toEqual({
      action: 'refuse',
      reason: 'PARTIAL_PAPER_EXIT_PLAN_MIGRATION',
    });
  });
});
