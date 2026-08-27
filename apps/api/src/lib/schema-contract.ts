/**
 * Договор о том, какой должна быть схема базы для воркеров кошельков.
 *
 * Схема в этом проекте наливается вручную командой `prisma db push`,
 * а код выкатывается автоматически при пуше. Порядок между ними
 * не гарантирован: новый код регулярно оказывается в бою раньше,
 * чем обновлена база.
 *
 * Само по себе это терпимо. Нетерпимо другое: Prisma перечисляет
 * колонки в SELECT явно, поэтому запрос к таблице с недостающей
 * колонкой падает целиком. Один воркер, попытавшийся прочитать
 * очередь, роняет не себя, а весь ответ — и вместе с ним страницы,
 * к базе кошельков отношения не имеющие.
 *
 * Отсюда правило: недостающая схема выключает только то, что от неё
 * зависит. API поднимается, публичные маршруты работают, воркер
 * пересчёта не стартует, а состояние источника честно сообщает,
 * что база отстала и требует обновления.
 *
 * Проверка строго на чтение. Ни одна ветка этого модуля не создаёт
 * и не меняет объектов базы: `db push` на старте боевого процесса —
 * это молчаливая миграция в момент наибольшей нагрузки, и обнаружить
 * её последствия было бы нечем.
 */

export type SchemaStatus = 'ok' | 'outdated' | 'unavailable';

export interface SchemaCheckResult {
  status: SchemaStatus;
  /**
   * Чего не хватает, в виде `Таблица.колонка` и `Таблица(колонки) unique`.
   * Ни строки подключения, ни SQL здесь нет и быть не должно: этот
   * список уходит в открытый ответ маршрута состояния.
   */
  missingObjects: string[];
  checkedAt: string;
  /** Код ошибки подключения. Только код — текст драйвера содержит хост. */
  errorCode?: string;
}

/**
 * Снимок того, что реально есть в базе.
 *
 * Отделён от сравнения намеренно: сравнение — чистая функция,
 * и полный, неполный и пустой снимок проверяются тестами без базы.
 */
export interface DbSnapshot {
  /** Таблица → её колонки. */
  tables: Record<string, string[]>;
  /** Уникальные индексы: таблица и упорядоченный список колонок. */
  uniques: Array<{ table: string; columns: string[] }>;
}

// ──────────────────────────── Что требуется ─────────────────────────────────

/**
 * Минимальная схема, без которой выкаченный API не может работать.
 *
 * Имена — настоящие, из `prisma/schema.prisma`. В частности, срок
 * следующего запуска называется `dueAt`, а не `nextRunAt`: сверять
 * надо с тем, что есть, иначе проверка будет сообщать о поломке
 * там, где её нет.
 *
 * Список намеренно не полон по отношению к схеме: сюда входят поля,
 * которые Prisma читает в критических сценариях регистрации, доступа,
 * оплаты и пересчёта кошельков. Именно поэтому здесь есть и `User`, и
 * таблицы подписок: прежняя проверка видела только кошельки, отвечала
 * `ok`, а регистрация при этом падала на отсутствующей колонке кода
 * подтверждения почты.
 */
export const REQUIRED_TABLES: Record<string, string[]> = {
  User: [
    'id',
    'email',
    'passwordHash',
    'emailVerifiedAt',
    'emailCodeHash',
    'emailCodeIssuedAt',
    'emailCodeExpires',
    'emailCodeAttempts',
  ],
  Subscription: ['id', 'userId', 'plan', 'status', 'startsAt', 'expiresAt', 'source'],
  EntitlementAudit: [
    'id',
    'userId',
    'subscriptionId',
    'previousPlan',
    'nextPlan',
    'reason',
    'source',
    'occurredAt',
  ],
  PaymentCustomer: ['id', 'userId', 'provider', 'kycState', 'tosAccepted'],
  SubscriptionPayment: [
    'id',
    'userId',
    'plan',
    'provider',
    'clientReference',
    'state',
    'priceAmount',
    'termDays',
  ],
  WebhookReceipt: ['id', 'provider', 'eventId', 'eventType', 'outcome', 'receivedAt'],
  OkxSignal: [
    'id',
    'providerKey',
    'chain',
    'address',
    'tokenId',
    'symbol',
    'name',
    'signaledAt',
    'peakPriceUsd',
    'peakObservedAt',
    'walletTypes',
    'triggerWalletAddresses',
    'source',
    'ingestOrigin',
    'paperAgentIngestCode',
  ],
  PaperAgentControl: [
    'id',
    'isEnabled',
    'baselineStrategyKey',
    'telegramShadowEnabled',
    'activeAllocationMode',
    'activeAllocationPolicyKey',
    'activeAllocationPolicyVersion',
    'learningModeEnabled',
    'updatedAt',
  ],
  PaperAgentStrategy: ['id', 'key', 'version', 'kind', 'isEnabled', 'config'],
  PaperAgentRun: [
    'id',
    'signalId',
    'strategyId',
    'providerKey',
    'state',
    'decisionCode',
    'signaledAt',
    'latencyMs',
    'signalOrigin',
    'providerDeliveryLatencyMs',
    'agentDecisionLatencyMs',
    'endToEndLatencyMs',
    'entrySourcePriceUsd',
    'costModelKey',
    'tradeFeeBps',
    'entrySlippageBps',
    'exitSlippageBps',
    'networkFeeUsdPerSide',
    'targetSourcePriceUsd',
    'unrealizedPnlUsd',
    'maxMultiple',
    'maxDrawdownPct',
    'realizedPnlUsd',
  ],
  PaperAgentNotification: [
    'id',
    'eventKey',
    'runId',
    'eventType',
    'payload',
    'inAppStatus',
    'isRead',
    'telegramEligible',
    'telegramStatus',
    'telegramAttempts',
  ],
  PaperAgentAllocationPolicy: [
    'id',
    'policyKey',
    'version',
    'mode',
    'limits',
    'scorePolicyKey',
    'scorePolicyVersion',
    'status',
    'source',
  ],
  PaperAgentAccountSession: [
    'id',
    'kind',
    'mode',
    'status',
    'policyKey',
    'policyVersion',
    'policySnapshot',
    'initialCapitalUsd',
    'freeBalanceUsd',
    'reservedBalanceUsd',
    'inPositionsUsd',
    'equityUsd',
    'ledgerVersion',
  ],
  PaperAgentAllocation: [
    'id',
    'sessionId',
    'runId',
    'isShadow',
    'state',
    'decisionCode',
    'policySnapshot',
    'inputFacts',
    'signalScore',
    'allocatedUsd',
    'realizedPnlUsd',
  ],
  PaperAgentCapitalLedger: [
    'id',
    'eventKey',
    'sessionId',
    'allocationId',
    'eventType',
    'amountUsd',
    'freeBeforeUsd',
    'freeAfterUsd',
    'inPositionsBeforeUsd',
    'inPositionsAfterUsd',
    'equityAfterUsd',
  ],
  WalletActivity: [
    'id',
    'chain',
    'walletAddress',
    'tokenAddress',
    'side',
    'source',
    'tradedAt',
    'appliedToLedger',
    'ledgerState',
    'ledgerAppliedAt',
    'ledgerErrorCode',
    'ledgerAttempts',
  ],
  WalletEconomicTrade: [
    'key',
    'chain',
    'walletAddress',
    'tokenAddress',
    'side',
    'amount',
    'valueUsd',
    'price',
    'tradedAt',
  ],
  WalletSyncQueue: [
    'id',
    'chain',
    'walletAddress',
    // Срок следующего запуска. В схеме именно dueAt.
    'dueAt',
    'attempts',
    'lastErrorCode',
    'lastSyncAt',
    'lastSuccessAt',
    // Поколение и аренда — на них держится защита от гонки.
    'generation',
    'lockedBy',
    'leaseToken',
    'lockedUntil',
  ],
};

/**
 * Уникальность, без которой правильность теряется молча.
 *
 * Очередь: одна задача на пару сеть+кошелёк. Без ограничения два
 * процесса создали бы две строки на один кошелёк и пересчитывали бы
 * его одновременно, получая разные промежуточные состояния позиции.
 *
 * Сделки: канонический ключ. Без него повторная строка истории
 * создала бы вторую запись и удвоила объём позиции — ошибка, которую
 * видно только по расхождению остатка спустя недели.
 *
 * События: устойчивый ключ события, он же защита от двойной записи
 * при пересечении сокета и опроса.
 */
export const REQUIRED_UNIQUES: Array<{ table: string; columns: string[] }> = [
  { table: 'User', columns: ['email'] },
  { table: 'PaymentCustomer', columns: ['userId', 'provider'] },
  { table: 'SubscriptionPayment', columns: ['clientReference'] },
  { table: 'WebhookReceipt', columns: ['provider', 'eventId'] },
  { table: 'OkxSignal', columns: ['providerKey'] },
  { table: 'PaperAgentStrategy', columns: ['key'] },
  { table: 'PaperAgentRun', columns: ['signalId', 'strategyId'] },
  { table: 'PaperAgentNotification', columns: ['eventKey'] },
  { table: 'PaperAgentAllocationPolicy', columns: ['policyKey', 'version'] },
  { table: 'PaperAgentAllocation', columns: ['runId', 'sessionId'] },
  { table: 'PaperAgentCapitalLedger', columns: ['eventKey'] },
  { table: 'WalletSyncQueue', columns: ['chain', 'walletAddress'] },
  { table: 'WalletEconomicTrade', columns: ['key'] },
  { table: 'WalletActivity', columns: ['id'] },
];

// ─────────────────────────── Сравнение, без базы ────────────────────────────

/**
 * Сравнение требуемого с имеющимся.
 *
 * Чистая функция: на вход снимок, на выход список недостающего.
 * Именно поэтому её можно проверить на полном, неполном и пустом
 * снимке, ни разу не подняв Postgres.
 */
export function compareSchema(snapshot: DbSnapshot): string[] {
  const missing: string[] = [];

  for (const [table, columns] of Object.entries(REQUIRED_TABLES)) {
    const actual = snapshot.tables[table];

    if (!actual) {
      // Таблицы нет целиком — перечислять её колонки незачем,
      // это утопило бы настоящую причину в списке следствий.
      missing.push(`${table} (таблица отсутствует)`);
      continue;
    }

    const have = new Set(actual);
    for (const column of columns) {
      if (!have.has(column)) missing.push(`${table}.${column}`);
    }
  }

  for (const required of REQUIRED_UNIQUES) {
    // Таблицы нет — про её индексы уже сказано выше.
    if (!snapshot.tables[required.table]) continue;

    const found = snapshot.uniques.some(
      (u) => u.table === required.table && sameColumns(u.columns, required.columns),
    );

    if (!found) {
      missing.push(`${required.table}(${required.columns.join(', ')}) — нет уникальности`);
    }
  }

  return missing;
}

/**
 * Совпадение состава колонок индекса.
 *
 * Порядок не важен: `unique(chain, walletAddress)` и
 * `unique(walletAddress, chain)` дают одну и ту же гарантию
 * неповторимости, а различаются только полезностью для поиска.
 */
function sameColumns(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
