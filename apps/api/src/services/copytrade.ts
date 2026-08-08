import { Prisma as P } from '@prisma/client';
import { decideCopy, copyExitFraction, D, type Chain as CoreChain } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';

/**
 * Fan-out сделки лидера подписчикам.
 *
 * Ключевые решения:
 *  • Лидер исполняется ПЕРВЫМ, подписчики — после. Иначе платформу можно
 *    обвинить во фронтране собственных клиентов.
 *  • Каждый подписчик обрабатывается независимо: отказ одного не блокирует
 *    остальных. Отказ всегда логируется с причиной.
 *  • Ордера подписчиков создаются со ссылкой parentOrderId — это даёт
 *    полную трассировку «сделка лидера → 340 копий» для аудита и споров.
 *  • Все копии помечаются source=COPY_TRADE: только с этого объёма
 *    впоследствии берётся performance fee.
 */

export interface FanoutResult {
  leaderOrderId: string;
  created: number;
  skipped: Array<{ followerId: string; reason: string }>;
  childOrderIds: string[];
}

export async function fanoutLeaderTrade(leaderOrderId: string): Promise<FanoutResult> {
  const leaderOrder = await prisma.order.findUniqueOrThrow({
    where: { id: leaderOrderId },
    include: { tokenIn: true, tokenOut: true },
  });

  if (leaderOrder.status !== 'FILLED' && leaderOrder.status !== 'PARTIALLY_FILLED') {
    throw new Error('Копируются только исполненные сделки лидера');
  }
  if (leaderOrder.source === 'COPY_TRADE') {
    throw new Error('Копия не может быть источником копирования (защита от каскада)');
  }

  const subs = await prisma.copySubscription.findMany({
    where: { leaderId: leaderOrder.userId, status: 'ACTIVE' },
    include: { follower: true },
  });

  const result: FanoutResult = {
    leaderOrderId,
    created: 0,
    skipped: [],
    childOrderIds: [],
  };

  const tradedToken = leaderOrder.side === 'BUY' ? leaderOrder.tokenOut : leaderOrder.tokenIn;

  for (const sub of subs) {
    try {
      const equity = await calcEquityUsd(sub.followerId);
      const freeQuote = await calcFreeQuoteUsd(sub.followerId, leaderOrder.tokenInId);
      const openPositions = await prisma.position.count({
        where: { userId: sub.followerId, quantity: { gt: 0 } },
      });

      const decision = decideCopy(
        {
          sizing: sub.sizing,
          fixedUsd: sub.fixedUsd?.toString() ?? null,
          pctEquity: sub.pctEquity?.toString() ?? null,
          maxPerTradeUsd: sub.maxPerTradeUsd?.toString() ?? null,
          maxOpenPositions: sub.maxOpenPositions,
          dailyLossLimitUsd: sub.dailyLossLimitUsd?.toString() ?? null,
          allowedChains: sub.allowedChains as CoreChain[],
          minLiquidityUsd: sub.minLiquidityUsd?.toString() ?? env.MIN_LIQUIDITY_USD,
          maxRiskScore: sub.maxRiskScore,
        },
        {
          equityUsd: equity.toString(),
          freeQuoteUsd: freeQuote.toString(),
          openPositions,
          realizedPnlTodayUsd: (await realizedPnlToday(sub.followerId)).toString(),
          isFrozen: sub.follower.isFrozen,
          kycApproved: sub.follower.kycStatus === 'APPROVED',
        },
        {
          chain: leaderOrder.chain as CoreChain,
          tokenAddress: tradedToken.address,
          side: leaderOrder.side,
          valueUsd: leaderOrder.filledIn.toString(),
          tokenLiquidityUsd: tradedToken.liquidityUsd?.toString() ?? null,
          // В базе риск-скор nullable, в ядре — необязательный параметр.
          // null означает «метрика ещё не рассчитана», и фильтр по риску
          // тогда просто не применяется.
          tokenRiskScore: tradedToken.riskScore ?? undefined,
        },
      );

      if (!decision.copy) {
        result.skipped.push({ followerId: sub.followerId, reason: decision.reason });
        continue;
      }

      const amountIn =
        leaderOrder.side === 'BUY'
          ? await usdToTokenAmount(decision.amountUsd.toString(), leaderOrder.tokenInId)
          : await followerExitAmount(sub.followerId, leaderOrder);

      if (amountIn.lte(0)) {
        result.skipped.push({ followerId: sub.followerId, reason: 'нечего продавать' });
        continue;
      }

      const child = await prisma.order.create({
        data: {
          userId: sub.followerId,
          chain: leaderOrder.chain,
          tokenInId: leaderOrder.tokenInId,
          tokenOutId: leaderOrder.tokenOutId,
          side: leaderOrder.side,
          type: 'MARKET',
          source: 'COPY_TRADE',
          status: 'PENDING',
          amountIn,
          // Копии получают более широкий допуск: они входят на секунды позже
          // лидера, и слишком узкое проскальзывание приведёт к массовым отказам.
          slippageBps: Math.min(leaderOrder.slippageBps * 2, env.MAX_SLIPPAGE_BPS),
          parentOrderId: leaderOrder.id,
          callId: leaderOrder.callId,
        },
      });

      result.created++;
      result.childOrderIds.push(child.id);
    } catch (e: any) {
      logger.warn({ err: e?.message, followerId: sub.followerId, leaderOrderId }, 'копия не создана');
      result.skipped.push({ followerId: sub.followerId, reason: e?.message ?? 'внутренняя ошибка' });
    }
  }

  logger.info(
    { leaderOrderId, created: result.created, skipped: result.skipped.length },
    'fan-out копитрейдинга завершён',
  );
  return result;
}

/**
 * Капитал подписчика = сумма всех балансов по рыночным ценам.
 * Позиции сюда НЕ добавляются: удерживаемые токены уже лежат в Balance,
 * Position — это только учёт себестоимости, а не второй кошелёк.
 */
export async function calcEquityUsd(userId: string): Promise<P.Decimal> {
  const bals = await prisma.balance.findMany({ where: { userId }, include: { token: true } });

  let total = new P.Decimal(0);
  for (const b of bals) {
    const price = b.token.priceUsd ?? new P.Decimal(0);
    total = total.plus(b.available.plus(b.locked).mul(price));
  }
  return total;
}

async function calcFreeQuoteUsd(userId: string, quoteTokenId: string): Promise<P.Decimal> {
  const bal = await prisma.balance.findUnique({
    where: { userId_tokenId: { userId, tokenId: quoteTokenId } },
    include: { token: true },
  });
  if (!bal) return new P.Decimal(0);
  return bal.available.mul(bal.token.priceUsd ?? new P.Decimal(0));
}

async function realizedPnlToday(userId: string): Promise<P.Decimal> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const agg = await prisma.trade.aggregate({
    where: { userId, createdAt: { gte: since }, status: 'CONFIRMED' },
    _sum: { realizedPnlUsd: true },
  });
  return agg._sum.realizedPnlUsd ?? new P.Decimal(0);
}

async function usdToTokenAmount(usd: string, tokenId: string): Promise<P.Decimal> {
  const token = await prisma.token.findUniqueOrThrow({ where: { id: tokenId } });
  const price = token.priceUsd;
  if (!price || price.lte(0)) throw new Error(`Нет цены для токена ${token.symbol}`);
  return new P.Decimal(usd).div(price);
}

/**
 * Выход подписчика повторяет ДОЛЮ выхода лидера, а не абсолютный объём.
 * Лидер продал 30% своей позиции — подписчик продаёт 30% своей.
 */
async function followerExitAmount(
  followerId: string,
  leaderOrder: { userId: string; tokenInId: string; filledIn: P.Decimal },
): Promise<P.Decimal> {
  const [leaderPos, followerBal] = await Promise.all([
    prisma.position.findUnique({
      where: { userId_tokenId: { userId: leaderOrder.userId, tokenId: leaderOrder.tokenInId } },
    }),
    prisma.balance.findUnique({
      where: { userId_tokenId: { userId: followerId, tokenId: leaderOrder.tokenInId } },
    }),
  ]);

  if (!followerBal || followerBal.available.lte(0)) return new P.Decimal(0);

  // Количество лидера ДО продажи = остаток + проданное
  const leaderQtyBefore = (leaderPos?.quantity ?? new P.Decimal(0)).plus(leaderOrder.filledIn);
  const fraction = copyExitFraction({
    leaderQtyBefore: leaderQtyBefore.toString(),
    leaderQtySold: leaderOrder.filledIn.toString(),
  });

  return followerBal.available.mul(new P.Decimal(fraction.toString()));
}
