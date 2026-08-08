import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { requiredLock } from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { executeOrder } from '../services/execution.js';
import { fanoutLeaderTrade } from '../services/copytrade.js';
import * as balances from '../services/balances.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

const createOrderSchema = z.object({
  chain: z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']),
  tokenInId: z.string(),
  tokenOutId: z.string(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT', 'TRAILING_STOP']),
  amountIn: z.string().refine((v) => Number(v) > 0, 'Сумма должна быть > 0'),
  limitPrice: z.string().optional(),
  triggerPrice: z.string().optional(),
  trailingBps: z.number().int().min(50).max(9000).optional(),
  slippageBps: z.number().int().min(10).max(5000).default(100),
  expiresAt: z.coerce.date().optional(),
  callId: z.string().optional(),
});

export const orderRoutes: FastifyPluginAsync = async (app) => {
  /** Создание ордера. Рыночный исполняется сразу, отложенный уходит воркеру. */
  app.post('/orders', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = createOrderSchema.parse(req.body);
    const userId = req.user.sub;

    // Идемпотентность: повтор запроса с тем же ключом не создаёт второй ордер.
    // Без этого двойной клик на мобильном = две покупки.
    const idemKey = req.headers['idempotency-key'] as string | undefined;
    if (idemKey) {
      const existing = await prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
      if (existing) return existing.response;
    }

    if (body.type === 'LIMIT' && !body.limitPrice) {
      return reply.code(400).send({ error: 'Для лимитного ордера нужна цена' });
    }
    if (['STOP_LOSS', 'TAKE_PROFIT'].includes(body.type) && !body.triggerPrice) {
      return reply.code(400).send({ error: 'Для стоп/тейк ордера нужна цена срабатывания' });
    }
    if (body.slippageBps > env.MAX_SLIPPAGE_BPS) {
      return reply.code(400).send({
        error: `Проскальзывание выше лимита платформы (${env.MAX_SLIPPAGE_BPS} bps)`,
      });
    }

    const order = await serializable(async (tx) => {
      const created = await tx.order.create({
        data: {
          userId,
          chain: body.chain,
          tokenInId: body.tokenInId,
          tokenOutId: body.tokenOutId,
          side: body.side,
          type: body.type,
          source: body.callId ? 'CALL' : 'MANUAL',
          status: body.type === 'MARKET' ? 'PENDING' : 'OPEN',
          amountIn: new P.Decimal(body.amountIn),
          limitPrice: body.limitPrice ? new P.Decimal(body.limitPrice) : null,
          triggerPrice: body.triggerPrice ? new P.Decimal(body.triggerPrice) : null,
          trailingBps: body.trailingBps ?? null,
          slippageBps: body.slippageBps,
          expiresAt: body.expiresAt ?? null,
          callId: body.callId ?? null,
        },
      });

      // Отложенный ордер резервирует средства сразу — иначе к моменту
      // срабатывания пользователь потратит их на другую сделку.
      if (body.type !== 'MARKET') {
        await balances.lock(tx, {
          userId,
          tokenId: body.tokenInId,
          amount: requiredLock({ amountIn: body.amountIn }).toString(),
          refId: created.id,
        });
      }
      return created;
    });

    let executed = null;
    if (body.type === 'MARKET') {
      executed = await executeOrder(order.id);

      // Если ордер поставил лидер копитрейдинга — раздаём подписчикам.
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      if (user.role === 'TRADER') {
        fanoutLeaderTrade(order.id).catch((e) =>
          logger.error({ err: e?.message, orderId: order.id }, 'fan-out упал'),
        );
      }
    }

    const response = { order: { ...order, amountIn: order.amountIn.toString() }, executed };
    if (idemKey) {
      await prisma.idempotencyKey.create({
        data: { key: idemKey, userId, response: response as never },
      }).catch(() => {});
    }
    return reply.code(201).send(response);
  });

  app.get('/orders', { preHandler: [app.authenticate] }, async (req) => {
    const q = z
      .object({
        status: z.string().optional(),
        limit: z.coerce.number().max(200).default(50),
        cursor: z.string().optional(),
      })
      .parse(req.query);

    return prisma.order.findMany({
      where: {
        userId: req.user.sub,
        ...(q.status ? { status: q.status as never } : {}),
      },
      include: { tokenIn: true, tokenOut: true, trades: true },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    });
  });

  app.delete('/orders/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    return serializable(async (tx) => {
      const order = await tx.order.findUnique({ where: { id } });
      if (!order || order.userId !== req.user.sub) {
        return reply.code(404).send({ error: 'Ордер не найден' });
      }
      if (!['OPEN', 'PARTIALLY_FILLED', 'PENDING'].includes(order.status)) {
        return reply.code(400).send({ error: `Нельзя отменить ордер в статусе ${order.status}` });
      }

      const unlockAmount = order.amountIn.minus(order.filledIn);
      if (order.type !== 'MARKET' && unlockAmount.gt(0)) {
        await balances.unlock(tx, {
          userId: order.userId,
          tokenId: order.tokenInId,
          amount: unlockAmount,
          refId: order.id,
        });
      }

      return tx.order.update({ where: { id }, data: { status: 'CANCELLED' } });
    });
  });

  /** Предпросмотр: сколько получит пользователь, без создания ордера. */
  app.post('/orders/quote', { preHandler: [app.authenticate] }, async (req) => {
    const body = createOrderSchema.pick({
      chain: true, tokenInId: true, tokenOutId: true, amountIn: true, slippageBps: true,
    }).parse(req.body);

    const { getAdapter } = await import('../chains/index.js');
    const [tokenIn, tokenOut] = await Promise.all([
      prisma.token.findUniqueOrThrow({ where: { id: body.tokenInId } }),
      prisma.token.findUniqueOrThrow({ where: { id: body.tokenOutId } }),
    ]);

    const amountBase = BigInt(
      new P.Decimal(body.amountIn).mul(new P.Decimal(10).pow(tokenIn.decimals)).toFixed(0),
    );

    const quote = await getAdapter(body.chain).quote({
      chain: body.chain,
      tokenIn: tokenIn.address,
      tokenOut: tokenOut.address,
      amountIn: amountBase,
      slippageBps: body.slippageBps,
    });

    const divisor = new P.Decimal(10).pow(tokenOut.decimals);
    return {
      amountOut: new P.Decimal(quote.amountOut.toString()).div(divisor).toString(),
      minAmountOut: new P.Decimal(quote.minAmountOut.toString()).div(divisor).toString(),
      priceImpactBps: quote.priceImpactBps,
      aggregator: quote.aggregator,
      estimatedNetworkFeeUsd: quote.estimatedNetworkFeeUsd,
      // Предупреждение показывается в UI красным до подтверждения сделки.
      warning:
        quote.priceImpactBps > 500
          ? `Высокое влияние на цену: ${(quote.priceImpactBps / 100).toFixed(1)}%`
          : null,
    };
  });
};
