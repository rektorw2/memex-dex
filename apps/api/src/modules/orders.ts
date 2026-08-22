import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { requiredLock } from '@memex/core';
import { prisma, serializable } from '../lib/prisma.js';
import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';
import { executeOrder } from '../services/execution.js';
import { placeOrderForUser, cancelOrderForUser } from '../services/order-intake.js';
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

    /*
     * Право проверяется по направлению сделки, а не по маршруту.
     *
     * Покупка — платная возможность: за неё берут деньги, и после
     * окончания подписки она закрывается. Продажа — нет и никогда
     * не будет: актив принадлежит человеку, а не платформе, и запереть
     * его в позиции из-за неоплаченного счёта нельзя.
     *
     * Один маршрут на оба направления — не недосмотр, а причина
     * делать проверку именно здесь: разведи их по разным маршрутам,
     * и однажды кто-то закроет весь маршрут целиком.
     */
    const ent = await entitlementOfRequest(req);
    const needed = body.side === 'BUY' ? 'MANUAL_TRADE' : 'SELL_OWN_ASSET';
    if (denyIfMissing(ent, needed, reply)) return reply;

    // Идемпотентность: повтор запроса с тем же ключом не создаёт второй ордер.
    // Без этого двойной клик на мобильном = две покупки.
    const idemKey = req.headers['idempotency-key'] as string | undefined;
    if (idemKey) {
      const existing = await prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
      if (existing) return existing.response;
    }

    // Вся логика — в общем сервисе. Здесь только разбор запроса и ответ:
    // второй способ торговать (по ключу из скрипта) обязан идти тем же
    // путём, иначе проверки со временем разойдутся.
    const response = await placeOrderForUser(userId, {
      chain: body.chain,
      tokenInId: body.tokenInId,
      tokenOutId: body.tokenOutId,
      side: body.side,
      type: body.type,
      amountIn: body.amountIn,
      limitPrice: body.limitPrice ?? null,
      triggerPrice: body.triggerPrice ?? null,
      trailingBps: body.trailingBps ?? null,
      slippageBps: body.slippageBps,
      expiresAt: body.expiresAt ?? null,
      callId: body.callId ?? null,
    });

    if (idemKey) {
      await prisma.idempotencyKey
        .create({ data: { key: idemKey, userId, response: response as never } })
        .catch(() => {});
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

    const r = await cancelOrderForUser(req.user.sub, id);
    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return reply.send(r.order);
  });

  /** Предпросмотр: сколько получит пользователь, без создания ордера. */
  app.post('/orders/quote', { preHandler: [app.authenticate] }, async (req, reply) => {
    /*
     * Котировка — шаг покупки, а не отдельная услуга.
     *
     * Оставить её открытой значило бы дать человеку без плана
     * посчитать сделку, дойти до кнопки и получить отказ там.
     * Отказывать надо в начале пути, а не в конце.
     *
     * Продажа своего актива котируется по тому же маршруту, поэтому
     * право проверяется по направлению, как и у самой заявки.
     */
    const side = (req.body as { side?: 'BUY' | 'SELL' } | undefined)?.side;
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, side === 'SELL' ? 'SELL_OWN_ASSET' : 'MANUAL_TRADE', reply)) {
      return reply;
    }

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
