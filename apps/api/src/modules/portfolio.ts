import type { FastifyPluginAsync } from 'fastify';
import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export const portfolioRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portfolio', { preHandler: [app.authenticate] }, async (req) => {
    const userId = req.user.sub;

    const [balances, positions, feeAgg] = await Promise.all([
      prisma.balance.findMany({ where: { userId }, include: { token: true } }),
      prisma.position.findMany({
        where: { userId, quantity: { gt: 0 } },
        include: { token: true },
      }),
      prisma.feeLedger.aggregate({ where: { userId }, _sum: { amountUsd: true } }),
    ]);

    let totalValueUsd = new P.Decimal(0);
    let totalCostUsd = new P.Decimal(0);

    const holdings = positions.map((p) => {
      const price = p.token.priceUsd ?? new P.Decimal(0);
      const value = p.quantity.mul(price);
      const unrealized = value.minus(p.costBasisUsd);
      totalValueUsd = totalValueUsd.plus(value);
      totalCostUsd = totalCostUsd.plus(p.costBasisUsd);

      return {
        tokenId: p.tokenId,
        symbol: p.token.symbol,
        chain: p.token.chain,
        logoUrl: p.token.logoUrl,
        quantity: p.quantity.toString(),
        avgCostUsd: p.avgCostUsd.toString(),
        currentPriceUsd: price.toString(),
        valueUsd: value.toFixed(2),
        unrealizedPnlUsd: unrealized.toFixed(2),
        unrealizedPnlPct: p.costBasisUsd.gt(0)
          ? unrealized.div(p.costBasisUsd).mul(100).toFixed(2)
          : '0.00',
        realizedPnlUsd: p.realizedPnlUsd.toFixed(2),
        // Доля позиции, с которой будет взята комиссия при продаже —
        // показываем заранее, чтобы удержание не стало сюрпризом.
        copiedSharePct: p.quantity.gt(0)
          ? p.copiedQuantity.div(p.quantity).mul(100).toFixed(1)
          : '0.0',
      };
    });

    const cash = balances
      .filter((b) => b.token.isQuote)
      .reduce((s, b) => s.plus(b.available.plus(b.locked).mul(b.token.priceUsd ?? 0)), new P.Decimal(0));

    return {
      totalValueUsd: totalValueUsd.plus(cash).toFixed(2),
      cashUsd: cash.toFixed(2),
      investedUsd: totalCostUsd.toFixed(2),
      unrealizedPnlUsd: totalValueUsd.minus(totalCostUsd).toFixed(2),
      totalFeesPaidUsd: (feeAgg._sum.amountUsd ?? new P.Decimal(0)).toFixed(2),
      holdings: holdings.sort((a, b) => Number(b.valueUsd) - Number(a.valueUsd)),
      balances: balances.map((b) => ({
        symbol: b.token.symbol,
        chain: b.token.chain,
        available: b.available.toString(),
        locked: b.locked.toString(),
      })),
    };
  });

  app.get('/portfolio/history', { preHandler: [app.authenticate] }, async (req) => {
    const trades = await prisma.trade.findMany({
      where: { userId: req.user.sub, status: 'CONFIRMED' },
      include: { order: { include: { tokenIn: true, tokenOut: true } } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    return trades.map((t) => ({
      id: t.id,
      date: t.createdAt,
      side: t.order.side,
      source: t.order.source,
      symbol: t.order.side === 'BUY' ? t.order.tokenOut.symbol : t.order.tokenIn.symbol,
      valueUsd: t.valueUsd.toFixed(2),
      priceUsd: t.priceUsd.toString(),
      realizedPnlUsd: t.realizedPnlUsd.toFixed(2),
      performanceFeeUsd: t.performanceFeeUsd.toFixed(2),
      txSignature: t.txSignature,
    }));
  });
};
