import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { getAdapter } from '../chains/index.js';

const targetSchema = z.object({ priceUsd: z.string(), pct: z.number().min(1).max(100) });

const createCallSchema = z.object({
  tokenId: z.string(),
  title: z.string().min(3).max(120),
  thesis: z.string().min(20, 'Обоснование обязательно — колл без тезиса это не аналитика'),
  risk: z.enum(['LOW', 'MEDIUM', 'HIGH', 'DEGEN']).default('HIGH'),
  entryPriceUsd: z.string(),
  targets: z.array(targetSchema).min(1).max(5),
  stopLossUsd: z.string().optional(),
  suggestedPct: z.number().min(0.1).max(25).optional(),
  timeHorizon: z.string().optional(),
  links: z.record(z.string()).optional(),
  isCopyEnabled: z.boolean().default(false),
  expiresAt: z.coerce.date().optional(),
});

export const callRoutes: FastifyPluginAsync = async (app) => {
  /** Публичная лента коллов — то, ради чего пользователи приходят. */
  app.get('/calls', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        status: z.string().default('PUBLISHED'),
        limit: z.coerce.number().max(100).default(30),
      })
      .parse(req.query);

    const calls = await prisma.call.findMany({
      where: {
        status: q.status as never,
        ...(q.chain ? { chain: q.chain as never } : {}),
      },
      include: {
        token: true,
        author: { select: { id: true, email: false, role: true } },
        _count: { select: { orders: true } },
      },
      orderBy: { publishedAt: 'desc' },
      take: q.limit,
    });

    return calls.map((c) => {
      const current = c.token.priceUsd;
      const entry = c.entryPriceUsd;
      const pnlPct =
        current && entry.gt(0) ? current.minus(entry).div(entry).mul(100) : null;
      return {
        ...c,
        currentPriceUsd: current?.toString() ?? null,
        pnlPct: pnlPct?.toFixed(2) ?? null,
        peakMultiple: c.peakMultiple?.toString() ?? null,
        followers: c._count.orders,
      };
    });
  });

  app.get('/calls/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const call = await prisma.call.findUnique({
      where: { id },
      include: { token: true, author: { select: { id: true, role: true } } },
    });
    if (!call || call.status === 'DRAFT') return reply.code(404).send({ error: 'Колл не найден' });
    return call;
  });

  /** Создание колла — только админ. */
  app.post('/admin/calls', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const body = createCallSchema.parse(req.body);
    const token = await prisma.token.findUniqueOrThrow({ where: { id: body.tokenId } });

    // Скоринг перед публикацией: не даём выпустить колл на явный ханипот.
    const risk = assessToken({
      liquidityUsd: token.liquidityUsd?.toString() ?? null,
      volume24hUsd: token.volume24hUsd?.toString() ?? null,
      holders: token.holders,
      topHolderPct: token.topHolderPct?.toString() ?? null,
      lpBurnedPct: token.lpBurnedPct?.toString() ?? null,
      isHoneypot: token.isHoneypot,
    });

    if (!risk.tradeable) {
      return reply.code(400).send({
        error: 'Токен не проходит проверку безопасности',
        riskScore: risk.score,
        flags: risk.flags,
      });
    }

    const totalPct = body.targets.reduce((s, t) => s + t.pct, 0);
    if (totalPct > 100) {
      return reply.code(400).send({ error: 'Сумма долей по целям превышает 100%' });
    }

    const call = await prisma.call.create({
      data: {
        authorId: req.user.sub,
        tokenId: body.tokenId,
        chain: token.chain,
        title: body.title,
        thesis: body.thesis,
        risk: body.risk,
        status: 'DRAFT',
        entryPriceUsd: new P.Decimal(body.entryPriceUsd),
        targets: body.targets as never,
        stopLossUsd: body.stopLossUsd ? new P.Decimal(body.stopLossUsd) : null,
        suggestedPct: body.suggestedPct ?? null,
        timeHorizon: body.timeHorizon ?? null,
        links: (body.links ?? {}) as never,
        isCopyEnabled: body.isCopyEnabled,
        expiresAt: body.expiresAt ?? null,
        peakPriceUsd: new P.Decimal(body.entryPriceUsd),
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub, action: 'call.create', entity: 'Call',
        entityId: call.id, after: { riskScore: risk.score, flags: risk.flags } as never, ip: req.ip,
      },
    });

    return reply.code(201).send({ call, risk });
  });

  /** Публикация — отдельным действием, чтобы черновик можно было вычитать. */
  app.post('/admin/calls/:id/publish', { preHandler: [app.requireAdmin] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const call = await prisma.call.findUniqueOrThrow({ where: { id }, include: { token: true } });

    if (call.status !== 'DRAFT') {
      return reply.code(400).send({ error: 'Публиковать можно только черновик' });
    }

    // Фиксируем цену входа по факту публикации, а не по факту создания —
    // иначе результат колла будет посчитан от устаревшей цены.
    const livePrice = await getAdapter(call.chain).getPriceUsd(call.token.address);

    const published = await prisma.call.update({
      where: { id },
      data: {
        status: 'PUBLISHED',
        publishedAt: new Date(),
        entryPriceUsd: livePrice ? new P.Decimal(livePrice) : call.entryPriceUsd,
        peakPriceUsd: livePrice ? new P.Decimal(livePrice) : call.entryPriceUsd,
      },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub, action: 'call.publish', entity: 'Call', entityId: id,
        before: { status: 'DRAFT' } as never,
        after: { status: 'PUBLISHED', entryPriceUsd: published.entryPriceUsd.toString() } as never,
        ip: req.ip,
      },
    });

    app.broadcast?.('call:published', published);
    return published;
  });

  app.post('/admin/calls/:id/close', { preHandler: [app.requireAdmin] }, async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { status } = z
      .object({ status: z.enum(['HIT_TARGET', 'STOPPED_OUT', 'CANCELLED', 'EXPIRED']) })
      .parse(req.body);

    const call = await prisma.call.findUniqueOrThrow({ where: { id }, include: { token: true } });
    const price = call.token.priceUsd ?? call.entryPriceUsd;
    const resultPct = call.entryPriceUsd.gt(0)
      ? price.minus(call.entryPriceUsd).div(call.entryPriceUsd).mul(100)
      : new P.Decimal(0);

    const updated = await prisma.call.update({
      where: { id },
      data: { status, closedPriceUsd: price, resultPct },
    });

    await prisma.auditLog.create({
      data: { actorId: req.user.sub, action: 'call.close', entity: 'Call', entityId: id,
              after: { status, resultPct: resultPct.toString() } as never, ip: req.ip },
    });
    return updated;
  });

  /** Публичная статистика автора — без неё коллам нет доверия. */
  app.get('/calls/stats/:authorId', async (req) => {
    const { authorId } = z.object({ authorId: z.string() }).parse(req.params);
    const calls = await prisma.call.findMany({
      where: { authorId, status: { not: 'DRAFT' } },
      select: { resultPct: true, peakMultiple: true, status: true },
    });

    const closed = calls.filter((c) => c.resultPct != null);
    const wins = closed.filter((c) => c.resultPct!.gt(0)).length;
    const avg = closed.length
      ? closed.reduce((s, c) => s.plus(c.resultPct!), new P.Decimal(0)).div(closed.length)
      : new P.Decimal(0);

    return {
      totalCalls: calls.length,
      closedCalls: closed.length,
      winRate: closed.length ? Number(((wins / closed.length) * 100).toFixed(1)) : 0,
      avgResultPct: avg.toFixed(2),
      bestMultiple: calls.reduce(
        (max, c) => (c.peakMultiple && c.peakMultiple.gt(max) ? c.peakMultiple : max),
        new P.Decimal(0),
      ).toFixed(2),
    };
  });
};
