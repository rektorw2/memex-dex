import { PrismaClient, type Prisma } from '@prisma/client';

/**
 * Клиент базы, создаваемый при первом обращении.
 *
 * Раньше клиент создавался прямо при импорте модуля. Выглядит
 * безобиднее, чем есть: конструктор `PrismaClient` не ждёт запроса —
 * он сразу начинает грузить движок запросов и делает это отдельным
 * промисом, который никто не ожидает. Если движок не загрузился,
 * промис отваливается как unhandled rejection.
 *
 * Последствия были двух видов.
 *
 * В тестах: любой файл, чей граф импортов доходил до этого модуля,
 * ронял один промис — даже если базу он не трогал и все обращения к
 * ней подменял. Набор тестов показывал ноль падений и завершался
 * кодом 1, то есть «зелёный» прогон был красным для CI.
 *
 * В бою: движок поднимался до того, как проверены переменные
 * окружения. Ошибка конфигурации приходила не туда, где её ждут.
 *
 * Ленивое создание убирает оба случая и ничего не прячет: если код
 * действительно пойдёт в базу, он получит ту же самую ошибку, но в
 * месте вызова, где её видно и можно обработать.
 */
let instance: PrismaClient | null = null;

function client(): PrismaClient {
  if (!instance) {
    instance = new PrismaClient({
      log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
    });
  }
  return instance;
}

/** Был ли клиент создан. Нужно, чтобы не поднимать движок ради выключения. */
export function prismaWasInstantiated(): boolean {
  return instance !== null;
}

export const prisma: PrismaClient = new Proxy({} as PrismaClient, {
  get(_target, property, _receiver) {
    /*
     * Отключение того, что не включалось.
     *
     * `$disconnect` вызывается при остановке процесса, в том числе
     * когда до базы дело так и не дошло. Создавать клиент ради того,
     * чтобы его закрыть, значит поднимать движок на выходе — ровно
     * та ошибка, от которой уходим.
     */
    if (property === '$disconnect' && instance === null) {
      return async () => undefined;
    }
    const value = Reflect.get(client(), property, client());
    return typeof value === 'function' ? value.bind(client()) : value;
  },
  has(_target, property) {
    return Reflect.has(client(), property);
  },
});

/**
 * Транзакция уровня SERIALIZABLE с ретраями.
 * Нужна везде, где меняются балансы: два параллельных ордера на один
 * баланс без сериализации приводят к отрицательному остатку.
 */
export async function serializable<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  retries = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < retries; i++) {
    try {
      return await prisma.$transaction(fn, { isolationLevel: 'Serializable', timeout: 15_000 });
    } catch (e: any) {
      lastError = e;
      // P2034 — write conflict / deadlock, повторяем
      if (e?.code === 'P2034') continue;
      throw e;
    }
  }
  throw lastError;
}
