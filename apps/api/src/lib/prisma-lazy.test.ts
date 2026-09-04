import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Клиент базы не создаётся при импорте.
 *
 * Дефект, ради которого написан этот файл: `new PrismaClient()` на
 * уровне модуля начинает грузить движок запросов отдельным промисом,
 * которого никто не ждёт. Когда движок не грузится, промис отваливается
 * как unhandled rejection — и набор тестов показывает ноль падений,
 * завершаясь кодом 1. «Зелёный» прогон, красный для CI.
 *
 * Проверяется не «вызвался ли конструктор», а последствие: сколько
 * раз клиент был создан к моменту, когда модуль всего лишь подключили.
 */

const constructions = vi.hoisted(() => ({ count: 0 }));

vi.mock('@prisma/client', () => {
  class FakePrismaClient {
    constructor() {
      constructions.count += 1;
    }
    user = { findMany: async () => [] };
    walletFavorite = { count: async () => 0, findMany: async () => [] };
    async $queryRaw() { return [{ ok: 1 }]; }
    async $disconnect() { return undefined; }
    async $transaction(fn: (tx: unknown) => Promise<unknown>) { return fn(this); }
  }
  return { PrismaClient: FakePrismaClient, Prisma: {}, PlanCode: {}, SubscriptionStatus: {}, SubscriptionSource: {} };
});

beforeEach(() => {
  constructions.count = 0;
  vi.resetModules();
});

describe('клиент базы создаётся лениво', () => {
  it('импорт модуля не создаёт клиент', async () => {
    await import('./prisma.js');

    // Импорт — это объявление доступа к базе, а не обращение к ней.
    expect(constructions.count).toBe(0);
  });

  it('импорт обёртки избранного тоже не создаёт клиент', async () => {
    // Чтение делегата на уровне модуля будило клиент через прокси:
    // модуль подключили — движок поднялся.
    await import('./prisma-favorites.js');

    expect(constructions.count).toBe(0);
  });

  it('первое обращение создаёт клиент', async () => {
    const { prisma } = await import('./prisma.js');
    await prisma.$queryRaw`SELECT 1`;

    expect(constructions.count).toBe(1);
  });

  it('второе обращение переиспользует тот же клиент', async () => {
    const { prisma } = await import('./prisma.js');
    await prisma.$queryRaw`SELECT 1`;
    await prisma.$queryRaw`SELECT 1`;

    expect(constructions.count).toBe(1);
  });

  it('методы делегатов остаются вызываемыми', async () => {
    const { prisma } = await import('./prisma.js');

    await expect(prisma.user.findMany()).resolves.toEqual([]);
  });

  it('избранное работает через обёртку', async () => {
    const { favorites } = await import('./prisma-favorites.js');

    await expect(favorites.count()).resolves.toBe(0);
    expect(constructions.count).toBe(1);
  });

  it('транзакция проходит через тот же клиент', async () => {
    const { serializable } = await import('./prisma.js');

    await expect(serializable(async () => 'ok')).resolves.toBe('ok');
  });

  it('отключение несозданного клиента его не создаёт', async () => {
    const { prisma } = await import('./prisma.js');
    await prisma.$disconnect();

    // Поднимать движок на выходе из процесса — ровно та ошибка,
    // от которой уходим.
    expect(constructions.count).toBe(0);
  });

  it('сообщает, был ли клиент создан', async () => {
    const { prisma, prismaWasInstantiated } = await import('./prisma.js');

    expect(prismaWasInstantiated()).toBe(false);
    await prisma.$queryRaw`SELECT 1`;
    expect(prismaWasInstantiated()).toBe(true);
  });
});
