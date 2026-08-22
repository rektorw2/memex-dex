import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { EXIT_PRESETS } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';

/**
 * Свои деньги.
 *
 * Каждый маршрут этого модуля закрыт правом, которое не отбирается
 * никогда: `PORTFOLIO_READ` для просмотра, `PROTECTIVE_EXIT` для планов
 * выхода. Проверки стоят не для того, чтобы что-то запретить, — они
 * стоят для того, чтобы намерение было записано в коде. Право,
 * которое просто «всегда есть», однажды окажется в списке отбираемых,
 * и заметить это будет нечем.
 */
export const portfolioRoutes: FastifyPluginAsync = async (app) => {
  app.get('/portfolio', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'PORTFOLIO_READ', reply)) return reply;

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

  app.get('/portfolio/history', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'PORTFOLIO_READ', reply)) return reply;

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

  // ─────────────────────── План выхода из позиции ──────────────────────

  /**
   * Список планов.
   *
   * Под теми же правами, что и применение: показывать выбор тому,
   * кто не может им воспользоваться, значит обещать возможность,
   * которой нет.
   */
  /*
   * Планы выхода принадлежат владельцу позиции, а не лидеру.
   *
   * Раньше здесь стояло требование быть лидером копитрейдинга. Для
   * новой модели это ошибка: защитный выход — это страховка уже
   * вложенных денег, и она обязана быть доступна при любом плане
   * и любой роли. Человек с истёкшей подпиской, у которого открыта
   * позиция, должен иметь возможность поставить стоп-лосс — иначе
   * окончание оплаты оставляет его без защиты ровно тогда, когда
   * защита нужнее всего.
   */
  app.get('/exit-presets', { preHandler: [app.authenticate] }, async () => ({
    presets: EXIT_PRESETS.map((p) => ({
      key: p.key,
      label: p.label,
      description: p.description,
    })),
  }));

  /** Доступные планы и текущий по конкретной позиции. */
  app.get('/positions/:tokenId/exit-plan', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'PROTECTIVE_EXIT', reply)) return reply;

    const { tokenId } = z.object({ tokenId: z.string() }).parse(req.params);
    const { getExitPlan } = await import('../services/exit-plan.js');

    return {
      presets: EXIT_PRESETS.map((p) => ({
        key: p.key,
        label: p.label,
        description: p.description,
      })),
      plan: await getExitPlan(req.user.sub, tokenId),
    };
  });

  /**
   * Смена плана выхода.
   *
   * Одна операция, а не «отменить, потом поставить»: между двумя
   * запросами позиция осталась бы без плана вовсе, и цена не спрашивает,
   * успел ли человек нажать вторую кнопку.
   */
  app.put('/positions/:tokenId/exit-plan', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'PROTECTIVE_EXIT', reply)) return reply;

    const { tokenId } = z.object({ tokenId: z.string() }).parse(req.params);
    const body = z.object({ preset: z.string().min(1).max(20) }).parse(req.body);

    const { setExitPlan } = await import('../services/exit-plan.js');
    const result = await setExitPlan(req.user.sub, tokenId, body.preset);

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'position.exit_plan',
        entity: 'Position',
        entityId: tokenId,
        after: {
          preset: result.preset,
          cancelled: result.cancelled,
          created: result.created,
        } as never,
      },
    });

    return result;
  });
};
