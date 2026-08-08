import { prisma } from '../lib/prisma.js';
import { executeOrder } from '../services/execution.js';
import { logger } from '../lib/logger.js';

/**
 * Исполнение копий, созданных fan-out'ом.
 *
 * Отдельный воркер, а не синхронный вызов: при 500 подписчиках синхронное
 * исполнение растянет HTTP-ответ лидеру на минуты. Копии исполняются
 * пачками с ограничением параллелизма, чтобы не выжечь rate limit RPC
 * и не устроить самому себе проскальзывание на тонком пуле.
 */

const BATCH_SIZE = 10;
const TICK_MS = 1_000;
let running = false;

export async function processCopyBatch() {
  const pending = await prisma.order.findMany({
    where: { source: 'COPY_TRADE', status: 'PENDING' },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  if (pending.length === 0) return 0;

  const results = await Promise.allSettled(pending.map((o) => executeOrder(o.id)));

  results.forEach((r, i) => {
    const order = pending[i]!;
    if (r.status === 'rejected') {
      logger.warn({ orderId: order.id, err: String(r.reason?.message ?? r.reason) }, 'копия не исполнена');
      prisma.order
        .update({
          where: { id: order.id },
          data: { status: 'REJECTED', rejectReason: String(r.reason?.message ?? r.reason).slice(0, 200) },
        })
        .catch(() => {});
    }
  });

  return pending.length;
}

export function startCopyExecutor() {
  if (running) return;
  running = true;
  const loop = async () => {
    while (running) {
      const processed = await processCopyBatch().catch((e) => {
        logger.error({ err: e?.message }, 'сбой воркера копий');
        return 0;
      });
      // Если очередь пустая — спим; если полная — сразу берём следующую пачку.
      if (processed === 0) await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  void loop();
  logger.info('воркер копитрейдинга запущен');
}

export function stopCopyExecutor() {
  running = false;
}
