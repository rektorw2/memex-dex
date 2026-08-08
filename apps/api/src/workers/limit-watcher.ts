import { Prisma as P } from '@prisma/client';
import { evaluateTrigger } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { executeOrder } from '../services/execution.js';
import { logger } from '../lib/logger.js';
import * as balances from '../services/balances.js';
import { serializable } from '../lib/prisma.js';

/**
 * Воркер отложенных ордеров: лимитки, стопы, тейки, trailing.
 *
 * Принципы:
 *  • Один проход = один снимок цен. Ордера на один токен оцениваются
 *    по одной и той же цене — иначе внутри пачки возникает несправедливость.
 *  • Ордер захватывается атомарно (status -> PENDING) перед исполнением,
 *    чтобы два инстанса воркера не исполнили его дважды.
 *  • Ошибка по одному ордеру не останавливает цикл.
 */

const TICK_MS = 3_000;
let running = false;

export async function tick() {
  const now = new Date();

  const orders = await prisma.order.findMany({
    where: {
      status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
      type: { in: ['LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP'] },
    },
    include: { tokenIn: true, tokenOut: true },
    take: 500,
  });

  if (orders.length === 0) return;

  // Снимок цен: один запрос на уникальный токен, а не на каждый ордер.
  const tokenIds = [...new Set(orders.flatMap((o) => [o.tokenInId, o.tokenOutId]))];
  const tokens = await prisma.token.findMany({ where: { id: { in: tokenIds } } });
  const priceMap = new Map(tokens.map((t) => [t.id, t.priceUsd]));

  for (const order of orders) {
    try {
      // Цена торгуемого токена, не котировочного.
      const tradedTokenId = order.side === 'BUY' ? order.tokenOutId : order.tokenInId;
      const price = priceMap.get(tradedTokenId);
      if (!price || price.lte(0)) continue;

      const decision = evaluateTrigger(
        {
          id: order.id,
          side: order.side,
          type: order.type,
          limitPriceUsd: order.limitPrice?.toString() ?? null,
          triggerPriceUsd: order.triggerPrice?.toString() ?? null,
          trailingBps: order.trailingBps,
          // peak хранится в triggerPrice для trailing-ордеров
          peakPriceUsd: order.triggerPrice?.toString() ?? null,
          expiresAt: order.expiresAt,
        },
        price.toString(),
        now,
      );

      switch (decision.action) {
        case 'update_peak':
          await prisma.order.update({
            where: { id: order.id },
            data: { triggerPrice: new P.Decimal(decision.peakPriceUsd.toString()) },
          });
          break;

        case 'expire':
          await serializable(async (tx) => {
            const remaining = order.amountIn.minus(order.filledIn);
            if (remaining.gt(0)) {
              await balances.unlock(tx, {
                userId: order.userId, tokenId: order.tokenInId,
                amount: remaining, refId: order.id,
              });
            }
            await tx.order.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
          });
          break;

        case 'execute': {
          // Атомарный захват: обновляем только если ордер всё ещё открыт.
          const claimed = await prisma.order.updateMany({
            where: { id: order.id, status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
            data: { status: 'PENDING' },
          });
          if (claimed.count === 0) break; // другой инстанс уже взял

          logger.info({ orderId: order.id, reason: decision.reason }, 'сработал отложенный ордер');
          await executeOrder(order.id).catch(async (e) => {
            logger.error({ err: e?.message, orderId: order.id }, 'исполнение отложенного ордера упало');
            // Возвращаем в книгу — сбой сети не должен убивать ордер пользователя.
            await prisma.order.updateMany({
              where: { id: order.id, status: 'PENDING' },
              data: { status: 'OPEN', rejectReason: e?.message?.slice(0, 200) },
            });
          });
          break;
        }

        case 'hold':
          break;
      }
    } catch (e: any) {
      logger.error({ err: e?.message, orderId: order.id }, 'ошибка обработки ордера');
    }
  }
}

export function startLimitWatcher() {
  if (running) return;
  running = true;
  const loop = async () => {
    while (running) {
      const started = Date.now();
      await tick().catch((e) => logger.error({ err: e?.message }, 'сбой цикла воркера'));
      const elapsed = Date.now() - started;
      await new Promise((r) => setTimeout(r, Math.max(0, TICK_MS - elapsed)));
    }
  };
  void loop();
  logger.info('воркер отложенных ордеров запущен');
}

export function stopLimitWatcher() {
  running = false;
}
