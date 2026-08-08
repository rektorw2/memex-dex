import { PrismaClient, type Prisma } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
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
