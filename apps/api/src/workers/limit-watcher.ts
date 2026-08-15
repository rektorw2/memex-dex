import { Prisma as P } from '@prisma/client';
import { evaluateTrigger, rescaleRemaining } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { executeOrder } from '../services/execution.js';
import { logger } from '../lib/logger.js';
import * as balances from '../services/balances.js';
import { reservesFunds } from '../services/order-locking.js';
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
            if (reservesFunds(order.type) && remaining.gt(0)) {
              await balances.unlock(tx, {
                userId: order.userId, tokenId: order.tokenInId,
                amount: remaining, refId: order.id,
              });
            }
            await tx.order.update({ where: { id: order.id }, data: { status: 'EXPIRED' } });
          });

          // Истёкший ордер лидера снимает и зеркальные копии: они
          // ставились сроком до того же момента, но подписчик мог
          // выставить свой ордер на секунду позже, и без явного
          // снятия копия пережила бы оригинал.
          await cancelMirrorsFor(order.id, 'EXPIRED');
          break;

        case 'execute': {
          // Атомарный захват: обновляем только если ордер всё ещё открыт.
          const claimed = await prisma.order.updateMany({
            where: { id: order.id, status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
            data: { status: 'PENDING' },
          });
          if (claimed.count === 0) break; // другой инстанс уже взял

          logger.info({ orderId: order.id, reason: decision.reason }, 'сработал отложенный ордер');

          // Стоп ничего не резервировал, поэтому за время ожидания
          // позиция могла уменьшиться: часть могла уйти по цели или
          // быть продана вручную. Продаём то, что есть сейчас, —
          // иначе исполнение отклонится по нехватке средств ровно
          // тогда, когда стоп нужен.
          if (!reservesFunds(order.type)) {
            const clamped = await clampToAvailable(order.id);
            if (!clamped) break;
          }

          let filled = false;
          await executeOrder(order.id)
            .then(() => {
              filled = true;
            })
            .catch(async (e) => {
              logger.error({ err: e?.message, orderId: order.id }, 'исполнение отложенного ордера упало');
              // Возвращаем в книгу — сбой сети не должен убивать ордер пользователя.
              await prisma.order.updateMany({
                where: { id: order.id, status: 'PENDING' },
                data: { status: 'OPEN', rejectReason: e?.message?.slice(0, 200) },
              });
            });

          // Раздача подписчикам после срабатывания отложенного ордера.
          //
          // Раньше её здесь не было, и это ломало копитрейдинг целиком для
          // лидеров, торгующих лимитками: fan-out вызывался только из
          // обработчика рыночных ордеров, а сработавшую лимитку никто
          // не раздавал. Сбой был молчаливым — ни ошибки, ни записи в лог,
          // просто у подписчиков не появлялось сделок.
          if (filled) {
            await maybeFanout(order.id);
            // Остальные ордера выхода по этой же позиции теперь
            // выставлены на количество, которого уже нет.
            await rescaleExitOrders(order.id);
          }
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

/**
 * Раздача исполненного ордера подписчикам, если его поставил лидер.
 *
 * Проверка роли живёт здесь, а не в fanoutLeaderTrade: там она означала бы
 * бросок исключения на каждом ордере обычного пользователя, то есть шум
 * в логах вместо полезной информации.
 */
async function maybeFanout(orderId: string): Promise<void> {
  try {
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { status: true, source: true, user: { select: { role: true } } },
    });

    if (!order) return;
    if (order.user.role !== 'TRADER') return;
    // Копия не может быть источником копирования — иначе получится каскад.
    if (order.source === 'COPY_TRADE') return;
    if (order.status !== 'FILLED' && order.status !== 'PARTIALLY_FILLED') return;

    const { fanoutLeaderTrade } = await import('../services/copytrade.js');
    const r = await fanoutLeaderTrade(orderId);
    logger.info({ orderId, created: r.created, skipped: r.skipped.length }, 'раздача сработавшей лимитки');
  } catch (e: any) {
    // Сбой раздачи не должен откатывать уже исполненную сделку лидера:
    // его ордер состоялся, деньги списаны, отменить это нельзя.
    logger.error({ err: e?.message, orderId }, 'раздача сработавшей лимитки не удалась');
  }
}

/** Снятие зеркальных копий, если истёкший ордер поставил лидер. */
async function cancelMirrorsFor(
  orderId: string,
  status: 'EXPIRED' | 'CANCELLED' | 'REJECTED',
): Promise<void> {
  try {
    const { cancelMirroredOrders } = await import('../services/copytrade.js');
    await cancelMirroredOrders(orderId, status);
  } catch (e: any) {
    logger.error({ err: e?.message, orderId }, 'снятие зеркальных копий не удалось');
  }
}

/**
 * Пересчёт оставшихся ордеров выхода после срабатывания одного из них.
 *
 * Проблема, которую это закрывает: план выхода ставит на одну позицию
 * несколько ордеров — цели на разные кратности и стоп на весь объём.
 * Когда срабатывает любой из них, позиция уменьшается, а остальные
 * ордера продолжают висеть на количество, которого уже нет. При их
 * срабатывании они отклонятся — то есть ровно тогда, когда нужны.
 *
 * Особенно это верно для стопа: он выставлен на всю позицию, и после
 * частичной фиксации по первой цели становится больше остатка.
 */
async function rescaleExitOrders(filledOrderId: string): Promise<void> {
  try {
    const filled = await prisma.order.findUnique({
      where: { id: filledOrderId },
      select: { userId: true, tokenInId: true, side: true, type: true },
    });

    // Пересчитывать нужно только после продажи: покупка позицию
    // не уменьшает.
    if (!filled || filled.side !== 'SELL') return;
    if (!['TAKE_PROFIT', 'STOP_LOSS', 'LIMIT'].includes(filled.type)) return;

    const [position, siblings] = await Promise.all([
      prisma.position.findUnique({
        where: { userId_tokenId: { userId: filled.userId, tokenId: filled.tokenInId } },
        select: { quantity: true },
      }),
      prisma.order.findMany({
        where: {
          userId: filled.userId,
          tokenInId: filled.tokenInId,
          side: 'SELL',
          status: { in: ['OPEN', 'PARTIALLY_FILLED'] },
          id: { not: filledOrderId },
        },
        orderBy: { triggerPrice: 'asc' },
      }),
    ]);

    if (siblings.length === 0) return;

    const remaining = position?.quantity ?? new P.Decimal(0);

    const scaled = rescaleRemaining(
      remaining.toString(),
      siblings.map((o) => ({ id: o.id, quantity: o.amountIn.minus(o.filledIn).toString() })),
    );

    for (const s of scaled) {
      const order = siblings.find((o) => o.id === s.id);
      if (!order) continue;

      if (!reservesFunds(order.type)) continue;
      const wasLocked = order.amountIn.minus(order.filledIn);
      const nowLocked = new P.Decimal(s.quantity);
      if (nowLocked.equals(wasLocked)) continue;

      await serializable(async (tx) => {
        const freed = wasLocked.minus(nowLocked);
        if (freed.gt(0)) {
          await balances.unlock(tx, {
            userId: order.userId,
            tokenId: order.tokenInId,
            amount: freed,
            refId: order.id,
          });
        }

        if (nowLocked.lte(0)) {
          // Продавать нечего — ордер снимается, а не остаётся нулевым:
          // нулевой ордер в книге выглядит как действующий план выхода,
          // которого на самом деле нет.
          await tx.order.update({
            where: { id: order.id },
            data: {
              status: 'CANCELLED',
              rejectReason: 'Позиция закрыта другим ордером выхода',
            },
          });
        } else {
          await tx.order.update({
            where: { id: order.id },
            data: { amountIn: nowLocked.plus(order.filledIn) },
          });
        }
      });
    }

    logger.info(
      { filledOrderId, adjusted: scaled.length, remaining: remaining.toString() },
      'ордера выхода пересчитаны под остаток позиции',
    );
  } catch (e: any) {
    // Сбой пересчёта не откатывает уже исполненную продажу.
    logger.error({ err: e?.message, filledOrderId }, 'пересчёт ордеров выхода не удался');
  }
}

/**
 * Ограничение объёма стопа фактическим остатком.
 *
 * Возвращает false, если продавать нечего — тогда ордер снимается:
 * стоп на закрытую позицию это мусор в книге, который при каждом
 * проходе воркера пытается исполниться и пишет ошибку в лог.
 */
async function clampToAvailable(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { userId: true, tokenInId: true, amountIn: true, filledIn: true },
  });
  if (!order) return false;

  const balance = await prisma.balance.findUnique({
    where: { userId_tokenId: { userId: order.userId, tokenId: order.tokenInId } },
    select: { available: true },
  });

  const available = balance?.available ?? new P.Decimal(0);
  const wanted = order.amountIn.minus(order.filledIn);

  if (available.lte(0)) {
    await prisma.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED', rejectReason: 'Позиция уже закрыта' },
    });
    logger.info({ orderId }, 'стоп снят: позиция закрыта');
    return false;
  }

  if (available.lt(wanted)) {
    await prisma.order.update({
      where: { id: orderId },
      data: { amountIn: available.plus(order.filledIn) },
    });
    logger.info(
      { orderId, wanted: wanted.toString(), available: available.toString() },
      'объём стопа уменьшен до фактического остатка',
    );
  }

  return true;
}
