import { readFileSync, readdirSync } from 'node:fs';
import { expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { paperAgentRoutes } from '../modules/paper-agent.js';
import {
  createPaperTestSignal,
  createPaperTestToken,
  setPaperTestPrice,
} from '../services/paper-test-source.js';
import { configurePaperAllocationAccounts } from '../services/paper-agent-allocation.js';
import { ensurePaperAgentConfig, setPaperAgentEnabledCache } from '../workers/paper-agent.js';

/**
 * Общая обвязка сквозного стенда.
 *
 * Что здесь настоящее: база, схема, миграции, клиент Prisma, воркер,
 * служба распределения капитала и HTTP-маршрут. Ни один из них не
 * подменён — стенд только готовит данные и смотрит результат.
 *
 * Что подменено, и почему это допустимо:
 *   • часы — иначе сценарий «решение опоздало» пришлось бы ждать;
 *   • сеть — `fetch` запрещён целиком. Это не удобство, а проверка:
 *     PAPER-режим не имеет права никуда ходить, и запрет ловит это
 *     надёжнее, чем перечисление конкретных адресов.
 *
 * Внешний поставщик рыночных данных заменён управляемым источником —
 * тем самым, что живёт в `services/paper-test-source.ts` и в
 * production выключен.
 */

const ROOT = new URL('../../../../', import.meta.url).pathname;
const ADMIN = 'ADMIN';

/** Таблицы, которые стенд очищает между сценариями. */
const TABLES = [
  'PaperAgentCapitalLedger',
  'PaperAgentAllocation',
  'PaperAgentAccountSession',
  'PaperAgentAllocationPolicy',
  'PaperAgentNotification',
  'PaperAgentRun',
  'PaperAgentStrategy',
  'PaperAgentControl',
  'OkxSignal',
  'Token',
  'AuditLog',
  'TransactionIntent',
  'SigningAttempt',
  'SigningIdentity',
  'SolanaNetworkProof',
  'FundingSafetyLatch',
  'Withdrawal',
  'WithdrawalOperation',
  'SolanaTransaction',
] as const;

/** Каталог миграций в порядке применения. */
export function migrationNames(): string[] {
  return readdirSync(`${ROOT}prisma/migrations`, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function migrationSql(name: string): string {
  return readFileSync(`${ROOT}prisma/migrations/${name}/migration.sql`, 'utf8');
}

/**
 * Убедиться, что схема на месте.
 *
 * Саму схему накатывает `global-setup.ts` настоящей командой
 * `prisma migrate deploy` до запуска тестов. Здесь остаётся только
 * проверка — и она нужна: без неё первый же сценарий падал бы на
 * непонятной ошибке отсутствующей таблицы вместо ясного сообщения.
 *
 * Своего применения миграций у стенда больше нет. Прежняя версия
 * отдавала весь `migration.sql` одним `$executeRawUnsafe` и получала
 * от PostgreSQL `42601: cannot insert multiple commands into a
 * prepared statement`; делить файл по `;` вручную нельзя — точка с
 * запятой встречается внутри литералов и `$$`-блоков.
 */
export async function assertSchemaReady(): Promise<void> {
  const rows = await prisma.$queryRawUnsafe<Array<{ migration_name: string }>>(
    'SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL',
  );
  const applied = new Set(rows.map((row) => row.migration_name));
  const missing = migrationNames().filter((name) => !applied.has(name));

  expect(missing, 'схема должна быть накатана до запуска сценариев').toEqual([]);
}

/** Очистить данные, оставив схему. */
export async function resetData(): Promise<void> {
  const list = TABLES.map((name) => `"${name}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
  setPaperAgentEnabledCache(false);
}

export interface PaperSetup {
  capitalUsd: string;
  maxOpenPositions: number;
  reservePct?: number;
  minimumPositionUsd?: string;
}

/**
 * Настроить агента так, как это делает администратор через интерфейс.
 *
 * Вызываются те же функции, что и HTTP-маршруты: конфигурация
 * стратегий, распределение капитала, включение агента.
 *
 * Режим FIXED. Размер позиции в нём выводится, а не задаётся:
 * `maxExposurePct = 100 − reservePct`, `maxPositionPct` = экспозиция,
 * делённая на число слотов. Отсюда следствие, важное для сценариев:
 * при равных позициях экспозиция и число слотов заканчиваются
 * одновременно, и первым срабатывает предел числа позиций.
 */
export async function setupPaperAgent(input: PaperSetup): Promise<void> {
  await ensurePaperAgentConfig();
  await configurePaperAllocationAccounts({
    mode: 'FIXED',
    capitalUsd: input.capitalUsd,
    fixed: {
      maxOpenPositions: input.maxOpenPositions,
      reservePct: input.reservePct ?? 30,
      minimumPositionUsd: input.minimumPositionUsd,
    },
  });
  await enableAgent(true);
}

export interface AutopilotSetup {
  capitalUsd: string;
  riskProfile: 'CONSERVATIVE' | 'BALANCED' | 'AGGRESSIVE';
  /** Переопределения лимитов — тот же путь, что у администратора. */
  overrides?: Record<string, unknown>;
}

/**
 * Настроить агента в режиме AUTOPILOT.
 *
 * Нужен сценариям про пределы. В FIXED дневной лимит равен 10 000, а
 * остановка по просадке — 100 %: оба практически недостижимы, и
 * проверять их там пришлось бы правкой данных мимо продуктового пути.
 * У профилей AUTOPILOT эти пределы осмысленные, а переопределения —
 * штатная возможность администратора.
 */
export async function setupAutopilotAgent(input: AutopilotSetup): Promise<void> {
  await ensurePaperAgentConfig();
  await configurePaperAllocationAccounts({
    mode: 'AUTOPILOT',
    capitalUsd: input.capitalUsd,
    autopilot: {
      riskProfile: input.riskProfile,
      overrides: input.overrides as never,
    },
  });
  await enableAgent(true);
}

/** Kill switch: тот же атомарный переход, что и в маршруте администратора. */
export async function enableAgent(isEnabled: boolean): Promise<void> {
  await prisma.paperAgentControl.update({ where: { id: 'primary' }, data: { isEnabled } });
  setPaperAgentEnabledCache(isEnabled);
}

export interface TestTokenInput {
  symbol?: string;
  priceUsd: number | null;
  /** Возраст рынка. По умолчанию — свежий, чтобы проходить фильтр. */
  poolCreatedAt?: Date | null;
}

export async function createToken(input: TestTokenInput, now: Date) {
  const created = await createPaperTestToken(ADMIN, {
    symbol: input.symbol ?? 'TST',
    name: 'Тестовый токен стенда',
    priceUsd: input.priceUsd,
    poolCreatedAt:
      input.poolCreatedAt === undefined
        ? new Date(now.getTime() - 5 * 60_000)
        : input.poolCreatedAt,
  });
  if (!created.ok) throw new Error(`создание тестового токена отклонено: ${created.reason}`);
  return created.value;
}

export async function setPrice(tokenId: string, priceUsd: number | null): Promise<void> {
  const updated = await setPaperTestPrice(ADMIN, tokenId, priceUsd);
  if (!updated.ok) throw new Error(`изменение цены отклонено: ${updated.reason}`);
}

export interface TestSignalInput {
  tokenId: string;
  amountUsd?: number;
  walletTypes?: string[];
  /** Насколько раньше «сейчас» отправлен сигнал. */
  signaledAgoMs?: number;
  receivedAgoMs?: number;
  priceUsd?: number | null;
}

export async function emitSignal(input: TestSignalInput, now: Date) {
  const created = await createPaperTestSignal(ADMIN, {
    tokenId: input.tokenId,
    walletTypes: input.walletTypes ?? ['smart_money'],
    amountUsd: input.amountUsd ?? 10_000,
    signaledAt: new Date(now.getTime() - (input.signaledAgoMs ?? 2_000)),
    receivedAt: new Date(now.getTime() - (input.receivedAgoMs ?? 500)),
    priceUsd: input.priceUsd === undefined ? 1 : input.priceUsd,
  });
  if (!created.ok) throw new Error(`создание тестового сигнала отклонено: ${created.reason}`);
  return created.value;
}

/** Сервер с настоящим маршрутом `/paper-agent`. */
export async function agentServer(role: 'USER' | 'ADMIN' = 'USER'): Promise<FastifyInstance> {
  const app = Fastify();
  (app as never as { decorateRequest: (n: string, v: unknown) => void }).decorateRequest(
    'user',
    null,
  );
  app.decorate('authenticate', async (req: { user?: unknown }) => {
    (req as { user: unknown }).user = { sub: 'e2e-user', role };
  });
  app.decorate('requireAdmin', async (req: { user?: unknown }, reply: { code: (n: number) => { send: (b: unknown) => unknown } }) => {
    if (role !== 'ADMIN') {
      reply.code(403).send({ code: 'FORBIDDEN' });
      return;
    }
    (req as { user: unknown }).user = { sub: 'e2e-admin', role };
  });
  await app.register(paperAgentRoutes);
  return app;
}

/**
 * Снимок `/paper-agent` глазами обычного человека.
 *
 * Пользователь заводится настоящий: маршрут читает роль из базы,
 * и без строки он получил бы 401.
 */
export async function paperAgentSnapshot(): Promise<Record<string, any>> {
  await prisma.user.upsert({
    where: { id: 'e2e-user' },
    create: {
      id: 'e2e-user',
      email: 'e2e@example.invalid',
      passwordHash: 'x',
      role: 'USER',
    },
    update: {},
  });
  const app = await agentServer('USER');
  try {
    const response = await app.inject({ method: 'GET', url: '/paper-agent' });
    expect(response.statusCode, 'снимок /paper-agent должен отдаваться').toBe(200);
    return response.json();
  } finally {
    await app.close();
  }
}

/**
 * Доказательство, что PAPER никуда не ходил и ничего не подписывал.
 *
 * Три независимых утверждения, и все поведенческие:
 *   • ни одной попытки подписи и ни одного намерения в базе;
 *   • ни одной записи о выводе;
 *   • ни одного исходящего запроса (сеть запрещена целиком).
 *
 * Проверяется после каждого сценария: контур подписи не должен
 * оживать ни при каком стечении обстоятельств в бумажном режиме.
 */
export async function expectNoSigningOrBroadcast(): Promise<void> {
  const [intents, attempts, withdrawals, operations, transactions] = await Promise.all([
    prisma.transactionIntent.count(),
    prisma.signingAttempt.count(),
    prisma.withdrawal.count(),
    prisma.withdrawalOperation.count(),
    prisma.solanaTransaction.count(),
  ]);

  expect(intents, 'намерений транзакций быть не должно').toBe(0);
  expect(attempts, 'попыток подписи быть не должно').toBe(0);
  expect(withdrawals, 'выводов быть не должно').toBe(0);
  expect(operations, 'операций вывода быть не должно').toBe(0);
  expect(transactions, 'транзакций Solana быть не должно').toBe(0);
}

/**
 * Запрет сети на время сценария.
 *
 * Возвращает функцию восстановления. Любой исходящий запрос роняет
 * тест с понятным сообщением, а не уходит наружу.
 */
export function forbidNetwork(): () => void {
  const original = globalThis.fetch;
  const calls: string[] = [];

  globalThis.fetch = (async (input: unknown) => {
    const target = typeof input === 'string' ? input : String((input as { url?: string })?.url);
    calls.push(target);
    throw new Error(`PAPER-режим обратился в сеть: ${target}`);
  }) as typeof globalThis.fetch;

  return () => {
    globalThis.fetch = original;
    expect(calls, 'исходящих запросов быть не должно').toEqual([]);
  };
}

/** Активный PAPER-счёт. */
export function activeSession() {
  return prisma.paperAgentAccountSession.findFirstOrThrow({
    where: { kind: 'ACTIVE', status: { in: ['ACTIVE', 'DRAINING'] } },
    orderBy: { createdAt: 'desc' },
  });
}

/** Единственный baseline-run сигнала. */
export async function baselineRun(signalId: string) {
  const control = await prisma.paperAgentControl.findUniqueOrThrow({ where: { id: 'primary' } });
  const strategy = await prisma.paperAgentStrategy.findUniqueOrThrow({
    where: { key: control.baselineStrategyKey },
  });
  return prisma.paperAgentRun.findUniqueOrThrow({
    where: { signalId_strategyId: { signalId, strategyId: strategy.id } },
  });
}

/**
 * Распределения, которые действительно двигают деньги активного счёта.
 *
 * Shadow-стратегия ведёт собственный счёт со своим капиталом, и её
 * распределения — не дубль экономического действия, а параллельный
 * эксперимент. Считать их вместе с активными значит принимать
 * работающее разделение за ошибку: именно это и произошло в первом
 * прогоне, где тест увидел два `OPEN` и назвал это дублем.
 */
export function activeAllocations(sessionId: string, state: 'OPEN' | 'CLOSED' | 'SKIPPED') {
  return prisma.paperAgentAllocation.findMany({
    where: { sessionId, isShadow: false, state },
  });
}

/**
 * Всё, что нужно, чтобы понять решение о капитале.
 *
 * Возвращается одной строкой и печатается в сообщении упавшего
 * теста. Без этого отказ выглядит как «ожидали PAPER_OPEN, получили
 * SKIPPED», и приходится гадать, какой из семи пределов сработал.
 */
export async function allocationDiagnostics(runId: string): Promise<string> {
  const session = await activeSession();
  const allocation = await prisma.paperAgentAllocation.findFirst({
    where: { runId, isShadow: false },
  });
  const run = await prisma.paperAgentRun.findUnique({ where: { id: runId } });

  return [
    `decisionCode=${run?.decisionCode ?? '—'}`,
    `state=${run?.state ?? '—'}`,
    `allocationCode=${allocation?.decisionCode ?? '—'}`,
    `allocationReason=${allocation?.allocationReason ?? '—'}`,
    `initial=${money(session.initialCapitalUsd)}`,
    `free=${money(session.freeBalanceUsd)}`,
    `reserved=${money(session.reservedBalanceUsd)}`,
    `inPositions=${money(session.inPositionsUsd)}`,
    `openPositions=${session.openPositions}`,
    `dailyEntries=${session.dailyEntries}`,
    `drawdownPct=${money(session.drawdownPct)}`,
    `reservePct=${money(session.reservePct)}`,
    `maxExposurePct=${money(session.maxExposurePct)}`,
    `maxPositionPct=${money(session.maxPositionPct)}`,
    `maxOpenPositions=${session.maxOpenPositions}`,
    `minimumPositionUsd=${money(session.minimumPositionUsd)}`,
    `dailyEntryLimit=${session.dailyEntryLimit}`,
    `drawdownStopPct=${money(session.drawdownStopPct)}`,
    `allocatedUsd=${allocation?.allocatedUsd == null ? '—' : money(allocation.allocatedUsd)}`,
  ].join(' ');
}

/** Записи журнала капитала активного счёта, по возрастанию. */
export async function ledgerOf(sessionId: string) {
  return prisma.paperAgentCapitalLedger.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'asc' },
  });
}

/**
 * Состояние основного капитала.
 *
 * Всё, что двигается только настоящей денежной операцией: свободный
 * остаток, резерв, деньги в позициях, реализованный результат, счётчики
 * входов и позиций, события журнала.
 *
 * Идемпотентность требует неизменности именно этого снимка. Повторный
 * проход не имеет права изменить здесь ни одного значения.
 */
export async function principalState(sessionId?: string) {
  const session = sessionId
    ? await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: sessionId } })
    : await activeSession();
  const ledger = await ledgerOf(session.id);

  return {
    free: money(session.freeBalanceUsd),
    reserved: money(session.reservedBalanceUsd),
    inPositions: money(session.inPositionsUsd),
    realized: money(session.realizedPnlUsd),
    openPositions: session.openPositions,
    dailyEntries: session.dailyEntries,
    events: ledger.map((row) => `${row.eventType}:${row.eventKey}`),
  };
}

/**
 * Состояние переоценки.
 *
 * Меняется законно и без всякой денежной операции: пришла новая
 * котировка — изменились нереализованный результат, equity и просадка.
 * Требовать здесь неизменности значило бы запретить агенту следить
 * за ценой.
 *
 * `ledgerVersion` живёт тоже здесь. Это версия оптимистичной
 * блокировки строки счёта, а не номер записи журнала: она растёт при
 * любом условном обновлении, включая переоценку. Первая версия теста
 * приняла её рост за появление новой записи — и ошиблась именно она,
 * потому что новых событий в журнале при этом не было.
 */
export async function valuationState(sessionId?: string) {
  const session = sessionId
    ? await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: sessionId } })
    : await activeSession();

  return {
    equity: money(session.equityUsd),
    unrealized: money(session.unrealizedPnlUsd),
    drawdownPct: money(session.drawdownPct),
  };
}

/**
 * Версия оптимистичной блокировки — отдельно от денег.
 *
 * Она намеренно не входит в `valuationState`. Один раз она туда
 * входила, и тест упал на её росте при повторном проходе, где ни
 * один доллар не сдвинулся: сравнение «всей переоценки целиком»
 * приняло служебный счётчик за денежную величину. Держать её рядом
 * с деньгами — приглашение повторить эту ошибку.
 */
export async function concurrencyVersion(sessionId?: string): Promise<number> {
  const session = sessionId
    ? await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: sessionId } })
    : await activeSession();

  return session.ledgerVersion;
}

/**
 * Точная сумма сохранённых составляющих счёта.
 *
 * Считается в `Decimal`, а не в `number`: на восьмом знаке двоичная
 * плавающая точка уже врёт, и проверка точного равенства через
 * `Number` проверяла бы саму себя, а не бухгалтерию.
 */
export async function persistedEquityParts(sessionId?: string): Promise<{
  equity: string;
  sum: string;
}> {
  const session = sessionId
    ? await prisma.paperAgentAccountSession.findUniqueOrThrow({ where: { id: sessionId } })
    : await activeSession();

  const sum = new P.Decimal(session.freeBalanceUsd)
    .plus(session.reservedBalanceUsd)
    .plus(session.inPositionsUsd)
    .plus(session.unrealizedPnlUsd);

  return { equity: new P.Decimal(session.equityUsd).toFixed(), sum: sum.toFixed() };
}

/**
 * Выполнить действие, которое обязано упереться в ограничение базы.
 *
 * Prisma пишет пойманное нарушение уникальности в свой журнал ошибок.
 * В отрицательной проверке это ожидаемый результат, а не авария, и
 * лишняя строка в выводе мешает читать настоящие сбои. Глушится
 * только вывод и только на время такой проверки — само ограничение
 * остаётся на месте и продолжает работать.
 */
export async function expectUniqueViolation(
  action: () => Promise<unknown>,
  message: string,
): Promise<void> {
  const original = console.error;
  console.error = () => {};
  try {
    await expect(action(), message).rejects.toMatchObject({ code: 'P2002' });
  } finally {
    console.error = original;
  }
}

/** Число в JS из денежного поля Prisma. */
export function money(value: unknown): number {
  if (value == null) return Number.NaN;
  return Number(value.toString());
}
