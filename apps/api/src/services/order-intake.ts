import { Prisma as P, type Chain, type OrderSource } from '@prisma/client';
import { requiredLock } from '@memex/core';
import { reservesFunds } from './order-locking.js';
import { prisma, serializable } from '../lib/prisma.js';
import { executeOrder } from './execution.js';
import { fanoutLeaderTrade, mirrorLeaderPendingOrder, cancelMirroredOrders } from './copytrade.js';
import * as balances from './balances.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

/**
 * Единая точка постановки ордера.
 *
 * Вынесено из обработчика HTTP сознательно. Появился второй способ
 * торговать — по ключу из скрипта, — и соблазн написать для него
 * отдельный, «более прямой» путь очень велик. Так делать нельзя:
 * две ветки постановки ордера расходятся не сразу, а через месяц,
 * когда правку внесут в одну и забудут в другой. Расхождение при этом
 * будет незаметным — оба пути работают, просто по-разному считают
 * блокировку средств или пропускают проверку проскальзывания.
 *
 * Поэтому здесь всё: валидация зависимостей между полями, резерв
 * средств, исполнение рыночных, раздача подписчикам. Обработчики
 * сверху только разбирают запрос и отвечают.
 */

export interface PlaceOrderInput {
  chain: Chain;
  tokenInId: string;
  tokenOutId: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'TAKE_PROFIT' | 'TRAILING_STOP';
  amountIn: string;
  limitPrice?: string | null;
  triggerPrice?: string | null;
  trailingBps?: number | null;
  slippageBps: number;
  expiresAt?: Date | null;
  callId?: string | null;
  source?: OrderSource;
}

export interface PlaceOrderResult {
  order: { id: string; type: string; status: string; amountIn: string };
  executed: unknown;
}

function bad(message: string): never {
  throw Object.assign(new Error(message), { statusCode: 400 });
}

export async function placeOrderForUser(
  userId: string,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  if (!(Number(input.amountIn) > 0)) bad('Сумма должна быть больше нуля');

  if (input.type === 'LIMIT' && !input.limitPrice) {
    bad('Для лимитного ордера нужна цена');
  }
  if (['STOP_LOSS', 'TAKE_PROFIT'].includes(input.type) && !input.triggerPrice) {
    bad('Для стоп/тейк ордера нужна цена срабатывания');
  }
  if (input.type === 'TRAILING_STOP' && !input.trailingBps) {
    bad('Для скользящего стопа нужен отступ в bps');
  }
  if (input.slippageBps > env.MAX_SLIPPAGE_BPS) {
    bad(`Проскальзывание выше лимита платформы (${env.MAX_SLIPPAGE_BPS} bps)`);
  }
  if (input.tokenInId === input.tokenOutId) {
    bad('Нельзя обменять токен сам на себя');
  }

  const order = await serializable(async (tx) => {
    const created = await tx.order.create({
      data: {
        userId,
        chain: input.chain,
        tokenInId: input.tokenInId,
        tokenOutId: input.tokenOutId,
        side: input.side,
        type: input.type,
        source: input.source ?? (input.callId ? 'CALL' : 'MANUAL'),
        status: input.type === 'MARKET' ? 'PENDING' : 'OPEN',
        amountIn: new P.Decimal(input.amountIn),
        limitPrice: input.limitPrice ? new P.Decimal(input.limitPrice) : null,
        triggerPrice: input.triggerPrice ? new P.Decimal(input.triggerPrice) : null,
        trailingBps: input.trailingBps ?? null,
        slippageBps: input.slippageBps,
        expiresAt: input.expiresAt ?? null,
        callId: input.callId ?? null,
      },
    });

    // Отложенный ордер резервирует средства сразу — иначе к моменту
    // срабатывания пользователь потратит их на другую сделку.
    // Исключение — стоп-лосс: см. order-locking.ts.
    if (reservesFunds(input.type)) {
      await balances.lock(tx, {
        userId,
        tokenId: input.tokenInId,
        amount: requiredLock({ amountIn: input.amountIn }).toString(),
        refId: created.id,
      });
    }
    return created;
  });

  let executed: unknown = null;
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { role: true },
  });

  if (input.type === 'MARKET') {
    executed = await executeOrder(order.id);

    if (user.role === 'TRADER') {
      // Раздача не ждётся: при пятистах подписчиках ответ лидеру
      // растянулся бы на минуты.
      fanoutLeaderTrade(order.id).catch((e) =>
        logger.error({ err: e?.message, orderId: order.id }, 'fan-out упал'),
      );
    }
  } else if (user.role === 'TRADER') {
    // Отложенный ордер лидера копируется дважды за свою жизнь, и это
    // не дублирование: здесь — подписчикам в режиме MIRROR, которым
    // нужна та же цена входа; позже, при срабатывании — остальным,
    // рыночным ордером из limit-watcher.
    mirrorLeaderPendingOrder(order.id).catch((e) =>
      logger.error({ err: e?.message, orderId: order.id }, 'зеркалирование упало'),
    );
  }

  return {
    order: {
      id: order.id,
      type: order.type,
      status: order.status,
      amountIn: order.amountIn.toString(),
    },
    executed,
  };
}

export type CancelResult =
  | { ok: true; order: { id: string; status: string } }
  | { ok: false; status: number; error: string };

export async function cancelOrderForUser(
  userId: string,
  orderId: string,
): Promise<CancelResult> {
  const result = await serializable<CancelResult>(async (tx) => {
    const order = await tx.order.findUnique({ where: { id: orderId } });

    // Чужой ордер и несуществующий дают одинаковый ответ: иначе по коду
    // ответа можно перебором выяснить, какие идентификаторы существуют.
    if (!order || order.userId !== userId) {
      return { ok: false, status: 404, error: 'Ордер не найден' };
    }
    if (!['OPEN', 'PARTIALLY_FILLED', 'PENDING'].includes(order.status)) {
      return { ok: false, status: 400, error: `Нельзя отменить ордер в статусе ${order.status}` };
    }

    const unlockAmount = order.amountIn.minus(order.filledIn);
    if (reservesFunds(order.type) && unlockAmount.gt(0)) {
      await balances.unlock(tx, {
        userId: order.userId,
        tokenId: order.tokenInId,
        amount: unlockAmount,
        refId: order.id,
      });
    }

    const updated = await tx.order.update({
      where: { id: orderId },
      data: { status: 'CANCELLED' },
    });

    return { ok: true, order: { id: updated.id, status: updated.status } };
  });

  // Копии снимаются вслед за оригиналом, но уже вне транзакции: они
  // затрагивают чужие балансы, и держать под ними блокировку строк
  // на всё время раздачи незачем.
  if (result.ok) {
    cancelMirroredOrders(orderId, 'CANCELLED').catch((e) =>
      logger.error({ err: e?.message, orderId }, 'снятие зеркальных копий упало'),
    );
  }

  return result;
}
