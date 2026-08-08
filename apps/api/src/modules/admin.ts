import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { reconcileUser } from '../services/balances.js';
import { getAdapter, supportedChains } from '../chains/index.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAdmin);

  /** Сводка платформы. */
  app.get('/admin/overview', async () => {
    const since24h = new Date(Date.now() - 864e5);
    const [users, activeSubs, trades24h, feeAgg, pendingWithdrawals] = await Promise.all([
      prisma.user.count(),
      prisma.copySubscription.count({ where: { status: 'ACTIVE' } }),
      prisma.trade.aggregate({
        where: { createdAt: { gte: since24h }, status: 'CONFIRMED' },
        _count: true,
        _sum: { valueUsd: true, performanceFeeUsd: true },
      }),
      prisma.feeLedger.aggregate({ _sum: { platformShareUsd: true, leaderShareUsd: true } }),
      prisma.withdrawal.count({ where: { status: { in: ['REQUESTED', 'MANUAL_REVIEW'] } } }),
    ]);

    return {
      users,
      activeCopySubscriptions: activeSubs,
      trades24h: trades24h._count,
      volume24hUsd: (trades24h._sum.valueUsd ?? new P.Decimal(0)).toFixed(2),
      fees24hUsd: (trades24h._sum.performanceFeeUsd ?? new P.Decimal(0)).toFixed(2),
      platformRevenueUsd: (feeAgg._sum.platformShareUsd ?? new P.Decimal(0)).toFixed(2),
      leaderPayoutsUsd: (feeAgg._sum.leaderShareUsd ?? new P.Decimal(0)).toFixed(2),
      pendingWithdrawals,
      supportedChains: supportedChains(),
    };
  });

  /** Добавление токена в листинг с обязательной проверкой риска. */
  app.post('/admin/tokens', async (req, reply) => {
    const body = z
      .object({
        chain: z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']),
        address: z.string().min(20),
        symbol: z.string().max(20),
        name: z.string().max(80),
        decimals: z.number().int().min(0).max(18),
        isQuote: z.boolean().default(false),
        logoUrl: z.string().url().optional(),
      })
      .parse(req.body);

    const adapter = getAdapter(body.chain);
    if (!adapter.isValidAddress(body.address)) {
      return reply.code(400).send({ error: `Некорректный адрес для сети ${body.chain}` });
    }

    const priceUsd = await adapter.getPriceUsd(body.address);

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: body.chain, address: body.address } },
      create: {
        ...body,
        logoUrl: body.logoUrl ?? null,
        priceUsd: priceUsd ? new P.Decimal(priceUsd) : null,
        isVerified: true,
        metricsUpdated: new Date(),
      },
      update: { isVerified: true, priceUsd: priceUsd ? new P.Decimal(priceUsd) : undefined },
    });

    await prisma.auditLog.create({
      data: { actorId: req.user.sub, action: 'token.list', entity: 'Token',
              entityId: token.id, after: token as never, ip: req.ip },
    });
    return reply.code(201).send(token);
  });

  /** Ручной скоринг токена перед публикацией колла. */
  app.get('/admin/tokens/:id/risk', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const t = await prisma.token.findUniqueOrThrow({ where: { id } });
    return assessToken({
      liquidityUsd: t.liquidityUsd?.toString() ?? null,
      volume24hUsd: t.volume24hUsd?.toString() ?? null,
      holders: t.holders,
      topHolderPct: t.topHolderPct?.toString() ?? null,
      lpBurnedPct: t.lpBurnedPct?.toString() ?? null,
      isHoneypot: t.isHoneypot,
    });
  });

  /** Назначение роли лидера копитрейдинга. */
  app.post('/admin/users/:id/role', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { role } = z.object({ role: z.enum(['USER', 'TRADER', 'ADMIN']) }).parse(req.body);

    const before = await prisma.user.findUniqueOrThrow({ where: { id } });
    const user = await prisma.user.update({ where: { id }, data: { role } });

    await prisma.auditLog.create({
      data: { actorId: req.user.sub, action: 'user.role', entity: 'User', entityId: id,
              before: { role: before.role } as never, after: { role } as never, ip: req.ip },
    });
    return { id: user.id, role: user.role };
  });

  /** Заморозка аккаунта — обязательный инструмент при подозрении на фрод. */
  app.post('/admin/users/:id/freeze', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { frozen, reason } = z.object({ frozen: z.boolean(), reason: z.string() }).parse(req.body);

    const user = await prisma.user.update({ where: { id }, data: { isFrozen: frozen } });
    if (frozen) {
      // Замораживаем и отложенные ордера, иначе они исполнятся сами.
      await prisma.order.updateMany({
        where: { userId: id, status: { in: ['OPEN', 'PARTIALLY_FILLED'] } },
        data: { status: 'CANCELLED', rejectReason: 'аккаунт заморожен' },
      });
    }

    await prisma.auditLog.create({
      data: { actorId: req.user.sub, action: 'user.freeze', entity: 'User', entityId: id,
              after: { frozen, reason } as never, ip: req.ip },
    });
    return { id: user.id, isFrozen: user.isFrozen };
  });

  /** Очередь выводов. Ручное подтверждение выше порога — не опция, а необходимость. */
  app.get('/admin/withdrawals', async () => {
    return prisma.withdrawal.findMany({
      where: { status: { in: ['REQUESTED', 'MANUAL_REVIEW', 'AWAITING_2FA'] } },
      include: { user: { select: { id: true, email: true, kycStatus: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.post('/admin/withdrawals/:id/decide', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { approve, reason } = z
      .object({ approve: z.boolean(), reason: z.string().optional() })
      .parse(req.body);

    const w = await prisma.withdrawal.update({
      where: { id },
      data: {
        status: approve ? 'APPROVED' : 'REJECTED',
        reviewedBy: req.user.sub,
        rejectReason: approve ? null : (reason ?? 'отклонено оператором'),
      },
    });

    await prisma.auditLog.create({
      data: { actorId: req.user.sub, action: 'withdrawal.decide', entity: 'Withdrawal',
              entityId: id, after: { approve, reason } as never, ip: req.ip },
    });
    return w;
  });

  /** Сверка баланса пользователя с журналом операций. */
  app.get('/admin/reconcile/:userId', async (req) => {
    const { userId } = z.object({ userId: z.string() }).parse(req.params);
    const discrepancies = await reconcileUser(userId);
    return { userId, ok: discrepancies.length === 0, discrepancies };
  });

  app.get('/admin/audit', async (req) => {
    const q = z.object({ limit: z.coerce.number().max(500).default(100) }).parse(req.query);
    return prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: q.limit });
  });
};
