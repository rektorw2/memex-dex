import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { calcEquityUsd } from '../services/copytrade.js';
import { env } from '../lib/env.js';

const subscribeSchema = z.object({
  leaderId: z.string(),
  sizing: z.enum(['FIXED_USD', 'PCT_EQUITY', 'PROPORTIONAL']).default('PCT_EQUITY'),
  fixedUsd: z.string().optional(),
  pctEquity: z.number().min(0.5).max(25).optional(),
  maxPerTradeUsd: z.string().optional(),
  maxOpenPositions: z.number().int().min(1).max(50).default(10),
  dailyLossLimitUsd: z.string().optional(),
  allowedChains: z.array(z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE'])).min(1),
  minLiquidityUsd: z.string().optional(),
  maxRiskScore: z.number().int().min(0).max(100).optional(),
  /**
   * Явное согласие с комиссией. Без него подписка не создаётся —
   * это не формальность, а единственная защита от претензии
   * «я не знал, что с меня удержат 10%».
   */
  acceptPerformanceFee: z.literal(true),
});

export const copyRoutes: FastifyPluginAsync = async (app) => {
  /** Витрина лидеров с честной статистикой. */
  app.get('/copy/leaders', async () => {
    const leaders = await prisma.user.findMany({
      where: { role: 'TRADER', isFrozen: false },
      select: { id: true, createdAt: true, _count: { select: { followers: true } } },
    });

    return Promise.all(
      leaders.map(async (l) => {
        const since = new Date(Date.now() - 30 * 864e5);
        const trades = await prisma.trade.findMany({
          where: { userId: l.id, status: 'CONFIRMED', createdAt: { gte: since } },
          select: { realizedPnlUsd: true, valueUsd: true },
        });

        const closed = trades.filter((t) => !t.realizedPnlUsd.isZero());
        const wins = closed.filter((t) => t.realizedPnlUsd.gt(0)).length;
        const totalPnl = trades.reduce((s, t) => s.plus(t.realizedPnlUsd), new P.Decimal(0));
        const volume = trades.reduce((s, t) => s.plus(t.valueUsd), new P.Decimal(0));

        // Максимальная просадка — обязательный показатель. Без неё
        // витрина показывает только победы и вводит людей в заблуждение.
        let peak = new P.Decimal(0);
        let running = new P.Decimal(0);
        let maxDrawdown = new P.Decimal(0);
        for (const t of trades) {
          running = running.plus(t.realizedPnlUsd);
          if (running.gt(peak)) peak = running;
          const dd = peak.minus(running);
          if (dd.gt(maxDrawdown)) maxDrawdown = dd;
        }

        return {
          id: l.id,
          followers: l._count.followers,
          trades30d: trades.length,
          winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
          pnl30dUsd: totalPnl.toFixed(2),
          volume30dUsd: volume.toFixed(2),
          maxDrawdownUsd: maxDrawdown.toFixed(2),
          performanceFeePct: env.PERFORMANCE_FEE_BPS / 100,
          activeSince: l.createdAt,
        };
      }),
    );
  });

  app.post('/copy/subscribe', { preHandler: [app.authenticate] }, async (req, reply) => {
    // Копирование покупок — платная возможность. Отдельно от продажи:
    // подписка на лидера может закончиться, а уже открытые позиции
    // человек продолжает вести сам.
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'LEADER_COPY_BUY', reply)) return reply;

    const body = subscribeSchema.parse(req.body);
    const followerId = req.user.sub;

    if (body.leaderId === followerId) {
      return reply.code(400).send({ error: 'Нельзя подписаться на самого себя' });
    }

    const leader = await prisma.user.findUnique({ where: { id: body.leaderId } });
    if (!leader || leader.role !== 'TRADER') {
      return reply.code(404).send({ error: 'Лидер не найден' });
    }

    const follower = await prisma.user.findUniqueOrThrow({ where: { id: followerId } });
    if (follower.kycStatus !== 'APPROVED') {
      return reply.code(403).send({ error: 'Копитрейдинг доступен после прохождения KYC' });
    }

    // Ограничение сверху на аллокацию — защита пользователя от самого себя.
    if (body.sizing === 'PCT_EQUITY' && (body.pctEquity ?? 0) > env.COPY_MAX_ALLOCATION_PCT) {
      return reply.code(400).send({
        error: `Максимальная доля капитала на сделку — ${env.COPY_MAX_ALLOCATION_PCT}%`,
      });
    }

    const sub = await prisma.copySubscription.upsert({
      where: { followerId_leaderId: { followerId, leaderId: body.leaderId } },
      create: {
        followerId,
        leaderId: body.leaderId,
        sizing: body.sizing,
        fixedUsd: body.fixedUsd ? new P.Decimal(body.fixedUsd) : null,
        pctEquity: body.pctEquity ?? null,
        maxPerTradeUsd: body.maxPerTradeUsd ? new P.Decimal(body.maxPerTradeUsd) : null,
        maxOpenPositions: body.maxOpenPositions,
        dailyLossLimitUsd: body.dailyLossLimitUsd ? new P.Decimal(body.dailyLossLimitUsd) : null,
        allowedChains: body.allowedChains,
        minLiquidityUsd: body.minLiquidityUsd ? new P.Decimal(body.minLiquidityUsd) : null,
        maxRiskScore: body.maxRiskScore ?? null,
        performanceFeeBps: env.PERFORMANCE_FEE_BPS,
        acceptedTermsAt: new Date(),
      },
      update: {
        status: 'ACTIVE',
        sizing: body.sizing,
        pctEquity: body.pctEquity ?? null,
        maxPerTradeUsd: body.maxPerTradeUsd ? new P.Decimal(body.maxPerTradeUsd) : null,
        maxOpenPositions: body.maxOpenPositions,
        allowedChains: body.allowedChains,
        acceptedTermsAt: new Date(),
      },
    });

    return reply.code(201).send({
      subscription: sub,
      terms: {
        performanceFeePct: sub.performanceFeeBps / 100,
        model: 'Комиссия удерживается при выходе из позиции, только с прибыли и только с объёма, набранного по копитрейдингу. Убыточные сделки комиссией не облагаются.',
      },
    });
  });

  app.patch('/copy/subscriptions/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    // Включение копирования — та же платная возможность, что и первая
    // подписка. Без проверки здесь достаточно было бы отключить
    // подписку до окончания оплаты и включить обратно после.
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'LEADER_COPY_BUY', reply)) return reply;

    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { status } = z.object({ status: z.enum(['ACTIVE', 'PAUSED', 'CANCELLED']) }).parse(req.body);

    const sub = await prisma.copySubscription.findUnique({ where: { id } });
    if (!sub || sub.followerId !== req.user.sub) {
      return reply.code(404).send({ error: 'Подписка не найдена' });
    }
    // Отписка не закрывает существующие позиции — пользователь остаётся
    // владельцем токенов и решает сам. Об этом сообщаем явно.
    return {
      subscription: await prisma.copySubscription.update({ where: { id }, data: { status } }),
      note: status === 'CANCELLED'
        ? 'Открытые позиции остаются у вас. Комиссия с них будет удержана при продаже.'
        : null,
    };
  });

  app.get('/copy/subscriptions', { preHandler: [app.authenticate] }, async (req) => {
    const subs = await prisma.copySubscription.findMany({
      where: { followerId: req.user.sub },
      include: { leader: { select: { id: true, role: true } } },
    });
    const equity = await calcEquityUsd(req.user.sub);
    return { equityUsd: equity.toFixed(2), subscriptions: subs };
  });

  /** Детализация всех удержанных комиссий — открыто и с расчётом. */
  app.get('/copy/fees', { preHandler: [app.authenticate] }, async (req) => {
    const fees = await prisma.feeLedger.findMany({
      where: { userId: req.user.sub, type: 'PERFORMANCE' },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });

    const total = fees.reduce((s, f) => s.plus(f.amountUsd), new P.Decimal(0));
    return {
      totalPaidUsd: total.toFixed(2),
      entries: fees.map((f) => ({
        id: f.id,
        date: f.createdAt,
        profitUsd: f.basisPnlUsd.toFixed(2),
        feePct: f.feeBps / 100,
        feeUsd: f.amountUsd.toFixed(2),
        calculation: f.calcSnapshot,
      })),
    };
  });
};
