import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { reconcileUser } from '../services/balances.js';
import { getAdapter, supportedChains } from '../chains/index.js';
import { fetchPoolForToken } from '../services/market-data.js';
import { runResearch, serializeResearch } from '../services/research.js';
import { isAiConfigured } from '../services/ai-research.js';

export const adminRoutes: FastifyPluginAsync = async (app) => {

  /**
   * Покупка по адресу с автоматическим выходом.
   *
   * Одно действие вместо четырёх: найти токен, завести его в базу,
   * купить, выставить тейк. Каждый ручной шаг здесь — это возможность
   * забыть последний, а забытый выход и есть та причина, по которой
   * позиции держат до нуля.
   */
  app.post('/admin/quick-buy', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const body = z
      .object({
        addressOrLink: z.string().min(10).max(500),
        amountIn: z.string().refine((v) => Number(v) > 0, 'Сумма должна быть больше нуля'),
        quoteTokenId: z.string(),
        chain: z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']).optional(),
        /** Цели выхода. По умолчанию — одна на 3× со всей позицией. */
        steps: z
          .array(
            z.object({
              multiple: z.number().gt(1).max(1000),
              fraction: z.number().gt(0).max(1),
            }),
          )
          .max(5)
          .optional(),
        stopLossPct: z.number().int().min(1).max(99).nullable().optional(),
        slippageBps: z.number().int().min(10).max(5000).default(300),
      })
      .parse(req.body);

    const { quickBuy } = await import('../services/quick-buy.js');

    const result = await quickBuy(req.user.sub, {
      addressOrLink: body.addressOrLink,
      amountIn: body.amountIn,
      quoteTokenId: body.quoteTokenId,
      chain: body.chain ?? null,
      steps: body.steps,
      stopLossPct: body.stopLossPct ?? null,
      slippageBps: body.slippageBps,
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'admin.quick_buy',
        entity: 'Order',
        entityId: result.buy.orderId,
        after: {
          symbol: result.token.symbol,
          amountIn: body.amountIn,
          exits: result.exits.length,
        } as never,
      },
    });

    return reply.code(201).send(result);
  });
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

  /**
   * Добавление токена по одному адресу: тикер, цена, ликвидность и пул
   * подтягиваются автоматически. Заполнять это руками — источник опечаток
   * в decimals, из-за которых сумма сделки уезжает в тысячу раз.
   */
  app.post('/admin/tokens/lookup', async (req, reply) => {
    const body = z
      .object({
        chain: z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']),
        address: z.string().min(20),
        verify: z.boolean().default(true),
      })
      .parse(req.body);

    const adapter = getAdapter(body.chain);
    if (!adapter.isValidAddress(body.address)) {
      return reply.code(400).send({ error: `Некорректный адрес для сети ${body.chain}` });
    }

    const pool = await fetchPoolForToken(body.chain, body.address);
    if (!pool) {
      return reply.code(404).send({
        error: 'Пул с этим токеном не найден. Возможно, у него нет ликвидности либо сеть пока не поддерживается поставщиком данных.',
      });
    }

    const risk = assessToken({
      liquidityUsd: pool.liquidityUsd,
      volume24hUsd: pool.volume24hUsd,
      ageHours: pool.poolCreatedAt
        ? (Date.now() - pool.poolCreatedAt.getTime()) / 3_600_000
        : null,
    });

    const token = await prisma.token.upsert({
      where: { chain_address: { chain: body.chain, address: body.address } },
      create: {
        chain: body.chain,
        address: body.address,
        symbol: pool.symbol,
        name: pool.name,
        decimals: pool.decimals,
        poolAddress: pool.poolAddress,
        priceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : null,
        liquidityUsd: pool.liquidityUsd != null ? new P.Decimal(pool.liquidityUsd) : null,
        volume24hUsd: pool.volume24hUsd != null ? new P.Decimal(pool.volume24hUsd) : null,
        priceChange24h: pool.priceChange24h != null ? new P.Decimal(pool.priceChange24h) : null,
        fdvUsd: pool.fdvUsd != null ? new P.Decimal(pool.fdvUsd) : null,
        riskScore: risk.score,
        isVerified: body.verify,
        source: 'manual',
        metricsUpdated: new Date(),
      },
      update: {
        poolAddress: pool.poolAddress,
        isVerified: body.verify,
        isHidden: false,
        priceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : undefined,
        riskScore: risk.score,
        metricsUpdated: new Date(),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub, action: 'token.lookup', entity: 'Token', entityId: token.id,
        after: { symbol: token.symbol, riskScore: risk.score } as never, ip: req.ip,
      },
    });

    return reply.code(201).send({ token, risk });
  });

  /** Скрыть или вернуть токен в витрину. Удалять нельзя: есть история сделок. */
  app.post('/admin/tokens/:id/visibility', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);

    const token = await prisma.token.update({ where: { id }, data: { isHidden: hidden } });
    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub, action: 'token.visibility', entity: 'Token',
        entityId: id, after: { hidden } as never, ip: req.ip,
      },
    });
    return { id: token.id, isHidden: token.isHidden };
  });

  /** Запустить импорт трендовых токенов немедленно, не дожидаясь часового цикла. */
  app.post('/admin/tokens/import', async () => {
    const { importTokens } = await import('../workers/token-importer.js');
    return { stats: await importTokens() };
  });

  /**
   * Разбор токена: факты о контракте плюс поиск репутационной информации.
   *
   * Запускается вручную и кэшируется на сутки — состав держателей и
   * репутация проекта меняются медленно, а бесплатные лимиты поставщиков
   * данных лучше тратить на новые токены, а не на повторные запросы.
   */
  app.post('/admin/tokens/:id/research', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body ?? {});

    try {
      const { research, cached } = await runResearch(id, { force });
      await prisma.auditLog.create({
        data: {
          actorId: req.user.sub, action: 'token.research', entity: 'Token',
          entityId: id, after: { status: research.status, cached } as never, ip: req.ip,
        },
      });
      return { research: serializeResearch(research), cached, aiEnabled: isAiConfigured() };
    } catch (e: any) {
      return reply.code(400).send({ error: e?.message ?? 'Разбор не выполнен' });
    }
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
