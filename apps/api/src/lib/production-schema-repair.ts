/**
 * Что можно безопасно доприменить к боевой базе при запуске.
 *
 * Здесь нет SQL и побочных эффектов. Классификация вынесена отдельно,
 * чтобы отказ на частично изменённой схеме проверялся без живой базы.
 *
 * Это не «запусти все миграции». Загрузчик знает конечный список
 * переходов, каждый из которых прочитан человеком и признан
 * аддитивным. Появилась миграция, которой он не знает, — он
 * останавливается и требует, чтобы её сначала прочитали. Иначе
 * первое же неосторожное `ALTER` уехало бы в production вместе
 * с обычным деплоем.
 *
 * Отдельная история — почему этот файл вообще существует. Проект
 * долго жил на `db push`, и боевая база оказалась в состоянии,
 * которого нет ни в одной миграции: таблицы есть, истории нет.
 * Отсюда `resolveBaseline`.
 */

export const BASELINE_MIGRATION = '0_baseline';
export const ACCESS_MIGRATION = '20260821120000_add_subscriptions_and_trial';
export const MARKET_AGE_MIGRATION = '20260823040000_add_token_market_age';
export const CHECK_QUEUE_MIGRATION = '20260823120000_add_check_queue_and_price_age';

/**
 * Миграции, которые загрузчику разрешено применять.
 *
 * Список ведётся руками намеренно. Каждая строка здесь означает:
 * человек открыл файл миграции, убедился, что она только добавляет,
 * и берёт на себя её применение без окна обслуживания.
 */
export const KNOWN_MIGRATIONS = [
  BASELINE_MIGRATION,
  ACCESS_MIGRATION,
  MARKET_AGE_MIGRATION,
  CHECK_QUEUE_MIGRATION,
] as const;

export const BASE_USER_COLUMNS = ['id', 'email', 'passwordHash'] as const;

export const ACCESS_USER_COLUMNS = [
  'emailVerifiedAt',
  'emailCodeHash',
  'emailCodeIssuedAt',
  'emailCodeExpires',
  'emailCodeAttempts',
] as const;

export const ACCESS_TABLES = [
  'Subscription',
  'EntitlementAudit',
  'PaymentCustomer',
  'SubscriptionPayment',
  'WebhookReceipt',
] as const;

export const ACCESS_ENUMS = [
  'PlanCode',
  'SubscriptionStatus',
  'SubscriptionSource',
  'PaymentProvider',
  'PaymentState',
  'KycState',
] as const;

/** Колонки возраста рынка. Обе появляются одной миграцией. */
export const MARKET_AGE_TOKEN_COLUMNS = ['poolCreatedAt', 'firstSeenAt'] as const;

/** Состояние очереди проверки и возраст котировки. */
export const CHECK_QUEUE_TOKEN_COLUMNS = [
  'scamCheckAttempts',
  'scamCheckNextAt',
  'scamProviderError',
  'priceUpdatedAt',
] as const;

export interface ProductionSchemaSnapshot {
  userColumns: string[];
  /**
   * Колонки таблицы `Token`.
   *
   * Раньше снимок их не читал, и загрузчик не мог заметить, что
   * Prisma Client ждёт `poolCreatedAt`, которого в базе нет.
   */
  tokenColumns: string[];
  tables: string[];
  enums: string[];
  /** null означает, что таблицы истории Prisma ещё нет. */
  appliedMigrations: string[] | null;
  /**
   * Имена миграций, лежащих в репозитории.
   *
   * Нужны, чтобы отличить известный переход от появившегося
   * без ведома загрузчика.
   *
   * `null` — каталог прочитать не удалось. Это отказ, а не «проверка
   * пропускается»: иначе любая ошибка чтения снимала бы единственную
   * защиту от применения непрочитанной миграции. Поле обязательное
   * именно поэтому — забыть его нельзя.
   */
  migrationsOnDisk: string[] | null;
}

export type ProductionSchemaPlan =
  | { action: 'ready' }
  /**
   * Применить `migrate deploy`.
   *
   * `pending` перечисляет, чего именно не хватает: это попадает
   * в журнал и в сообщение об ошибке, если после применения схема
   * так и не сошлась.
   */
  | { action: 'apply-migrations'; resolveBaseline: boolean; pending: string[] }
  | { action: 'refuse'; reason: string };

/** Все ли артефакты набора на месте, нет ли их вовсе, или половина. */
type Presence = 'all' | 'none' | 'partial';

function presenceOf(flags: boolean[]): Presence {
  if (flags.every(Boolean)) return 'all';
  if (flags.some(Boolean)) return 'partial';
  return 'none';
}

/** Что делать с одной миграцией: применять, пропустить или встать. */
type MigrationVerdict =
  | { kind: 'applied' }
  | { kind: 'pending' }
  | { kind: 'refuse'; reason: string };

/**
 * Схема и история про одну миграцию.
 *
 * Четыре состояния, и три из них требуют разного ответа.
 *
 * Половина артефактов — применение оборвалось посередине.
 * История без схемы — запись есть, колонок нет: повторное применение
 * не случится, Prisma Client уйдёт за несуществующей колонкой.
 * Схема без истории — обратное: колонки есть, а Prisma считает
 * миграцию непринятой и попробует накатить её при следующем деплое.
 * Упадёт не сегодня, а когда в репозиторий добавят следующую, и
 * связать падение с этим состоянием будет уже нечем.
 *
 * Ни одно из трёх нельзя доправить вслепую: неизвестно, что ещё
 * не доехало и почему.
 */
interface RefusalReasons {
  /** Половина артефактов на месте. */
  partial: string;
  /** История говорит «применена», а в схеме её нет. */
  historyAhead: string;
  /** Схема изменена, а в истории записи нет. */
  schemaAhead: string;
}

function verdictFor(
  presence: Presence,
  inHistory: boolean,
  reasons: RefusalReasons,
): MigrationVerdict {
  if (presence === 'partial') return { kind: 'refuse', reason: reasons.partial };

  if (presence === 'none') {
    return inHistory ? { kind: 'refuse', reason: reasons.historyAhead } : { kind: 'pending' };
  }

  return inHistory ? { kind: 'applied' } : { kind: 'refuse', reason: reasons.schemaAhead };
}

export function planProductionSchemaRepair(
  snapshot: ProductionSchemaSnapshot,
): ProductionSchemaPlan {
  const user = new Set(snapshot.userColumns);
  const token = new Set(snapshot.tokenColumns ?? []);
  const tables = new Set(snapshot.tables);
  const enums = new Set(snapshot.enums);
  const applied = new Set(snapshot.appliedMigrations ?? []);

  /*
   * Каталог миграций обязан читаться.
   *
   * Прежде `null` означал «сверять не с чем, проверка пропускается»,
   * и любая ошибка чтения молча снимала единственную защиту от
   * применения непрочитанной миграции. Отсутствие каталога — это
   * сломанный образ, а не повод ослабить проверку.
   */
  if (snapshot.migrationsOnDisk == null) {
    return { action: 'refuse', reason: 'MIGRATIONS_DIRECTORY_UNREADABLE' };
  }

  /*
   * Незнакомая миграция останавливает загрузчик.
   *
   * `migrate deploy` применяет всё, что не применено, поэтому
   * единственная защита от неосторожного `ALTER` — знать заранее,
   * что именно будет применено.
   */
  const onDisk = new Set(snapshot.migrationsOnDisk);

  if (snapshot.migrationsOnDisk.some((name) => !(KNOWN_MIGRATIONS as readonly string[]).includes(name))) {
    return { action: 'refuse', reason: 'UNKNOWN_MIGRATION_PRESENT' };
  }

  // Обратный случай: каталог читается, но пуст или неполон. Тогда
  // `migrate deploy` не применит недостающее и молча завершится
  // успехом.
  if (KNOWN_MIGRATIONS.some((name) => !onDisk.has(name))) {
    return { action: 'refuse', reason: 'KNOWN_MIGRATION_FILE_MISSING' };
  }

  if (BASE_USER_COLUMNS.some((column) => !user.has(column))) {
    return { action: 'refuse', reason: 'BASELINE_USER_SCHEMA_MISSING' };
  }

  /*
   * Дальше — по одной миграции.
   *
   * Baseline сюда не входит намеренно: отсутствие его записи
   * в истории — это и есть наследие `db push`, и лечится оно
   * `migrate resolve`, а не отказом.
   */
  const steps: { name: string; presence: Presence; reasons: RefusalReasons }[] = [
    {
      name: ACCESS_MIGRATION,
      presence: presenceOf([
        ...ACCESS_USER_COLUMNS.map((column) => user.has(column)),
        ...ACCESS_TABLES.map((table) => tables.has(table)),
        ...ACCESS_ENUMS.map((type) => enums.has(type)),
      ]),
      reasons: {
        partial: 'PARTIAL_ACCESS_MIGRATION',
        historyAhead: 'MIGRATION_HISTORY_CONTRADICTS_SCHEMA',
        schemaAhead: 'ACCESS_SCHEMA_AHEAD_OF_HISTORY',
      },
    },
    {
      name: MARKET_AGE_MIGRATION,
      presence: presenceOf(MARKET_AGE_TOKEN_COLUMNS.map((column) => token.has(column))),
      reasons: {
        partial: 'PARTIAL_MARKET_AGE_MIGRATION',
        historyAhead: 'MARKET_AGE_HISTORY_CONTRADICTS_SCHEMA',
        schemaAhead: 'MARKET_AGE_SCHEMA_AHEAD_OF_HISTORY',
      },
    },
    {
      name: CHECK_QUEUE_MIGRATION,
      presence: presenceOf(CHECK_QUEUE_TOKEN_COLUMNS.map((column) => token.has(column))),
      reasons: {
        partial: 'PARTIAL_CHECK_QUEUE_MIGRATION',
        historyAhead: 'CHECK_QUEUE_HISTORY_CONTRADICTS_SCHEMA',
        schemaAhead: 'CHECK_QUEUE_SCHEMA_AHEAD_OF_HISTORY',
      },
    },
  ];

  const pending: string[] = [];

  for (const step of steps) {
    const verdict = verdictFor(step.presence, applied.has(step.name), step.reasons);

    if (verdict.kind === 'refuse') return { action: 'refuse', reason: verdict.reason };
    if (verdict.kind === 'pending') pending.push(step.name);
  }

  // Всё на месте — второй запуск ничего не делает. Идемпотентность
  // здесь обязательна: entrypoint выполняется на каждом деплое.
  if (pending.length === 0) return { action: 'ready' };

  return {
    action: 'apply-migrations',
    resolveBaseline: !applied.has(BASELINE_MIGRATION),
    pending,
  };
}
