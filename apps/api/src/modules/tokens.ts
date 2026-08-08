import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { SUPPORTED_INTERVALS } from '../services/market-data.js';

const SORTS = {
  volume: { volume24hUsd: 'desc' },
  liquidity: { liquidityUsd: 'desc' },
  gainers: { priceChange24h: 'desc' },
  losers: { priceChange24h: 'asc' },
  new: { createdAt: 'desc' },
} as const;

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  app.get('/tokens', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        search: z.string().optional(),
        sort: z.enum(['volume', 'liquidity', 'gainers', 'losers', 'new']).default('volume'),
        verifiedOnly: z.coerce.boolean().default(false),
        minLiquidity: z.coerce.number().optional(),
        maxRiskScore: z.coerce.number().optional(),
        limit: z.coerce.number().max(200).default(60),
      })
      .parse(req.query);

    const tokens = await prisma.token.findMany({
      where: {
        isHidden: false,
        ...(q.verifiedOnly ? { isVerified: true } : {}),
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(q.minLiquidity ? { liquidityUsd: { gte: q.minLiquidity } } : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),
        ...(q.search
          ? {
              OR: [
                { symbol: { contains: q.search, mode: 'insensitive' } },
                { name: { contains: q.search, mode: 'insensitive' } },
                { address: q.search },
              ],
            }
          : {}),
      },
      // Сортировка по gainers без отсечки по ликвидности выносит наверх
      // мёртвые токены с одной сделкой и ростом на 40000% — фильтр
      // ликвидности применяется всегда, даже если клиент его не прислал.
      orderBy: [SORTS[q.sort], { volume24hUsd: 'desc' }],
      take: q.limit,
    });

    return tokens.map((t) => ({
      id: t.id,
      chain: t.chain,
      address: t.address,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      logoUrl: t.logoUrl,
      isQuote: t.isQuote,
      isVerified: t.isVerified,
      priceUsd: t.priceUsd?.toString() ?? null,
      priceChange24h: t.priceChange24h?.toString() ?? null,
      liquidityUsd: t.liquidityUsd?.toString() ?? null,
      volume24hUsd: t.volume24hUsd?.toString() ?? null,
      fdvUsd: t.fdvUsd?.toString() ?? null,
      riskScore: t.riskScore,
      hasChart: t.poolAddress != null,
      source: t.source,
    }));
  });

  app.get('/tokens/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const t = await prisma.token.findUnique({ where: { id } });
    if (!t || t.isHidden) return reply.code(404).send({ error: 'Токен не найден' });

    return {
      ...t,
      priceUsd: t.priceUsd?.toString() ?? null,
      priceChange24h: t.priceChange24h?.toString() ?? null,
      liquidityUsd: t.liquidityUsd?.toString() ?? null,
      volume24hUsd: t.volume24hUsd?.toString() ?? null,
      fdvUsd: t.fdvUsd?.toString() ?? null,
      hasChart: t.poolAddress != null,
    };
  });

  app.get('/tokens/:id/candles', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({
        interval: z.string().default('5m'),
        limit: z.coerce.number().max(1000).default(300),
      })
      .parse(req.query);

    if (!SUPPORTED_INTERVALS.includes(q.interval)) {
      return reply.code(400).send({
        error: `Неподдерживаемый интервал. Доступны: ${SUPPORTED_INTERVALS.join(', ')}`,
      });
    }

    const candles = await prisma.candle.findMany({
      where: { tokenId: id, interval: q.interval },
      orderBy: { openTime: 'desc' },
      take: q.limit,
    });

    // Формат lightweight-charts: время в секундах, значения числами.
    return candles.reverse().map((c) => ({
      time: Math.floor(c.openTime.getTime() / 1000),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volumeUsd),
    }));
  });

  /** Сводка по рынку — для шапки витрины. */
  app.get('/market/summary', async () => {
    const [total, byChain, agg] = await Promise.all([
      prisma.token.count({ where: { isHidden: false } }),
      prisma.token.groupBy({
        by: ['chain'],
        where: { isHidden: false },
        _count: true,
      }),
      prisma.token.aggregate({
        where: { isHidden: false },
        _sum: { volume24hUsd: true, liquidityUsd: true },
      }),
    ]);

    return {
      tokens: total,
      byChain: Object.fromEntries(byChain.map((c) => [c.chain, c._count])),
      volume24hUsd: agg._sum?.volume24hUsd?.toString() ?? '0',
      liquidityUsd: agg._sum?.liquidityUsd?.toString() ?? '0',
      intervals: SUPPORTED_INTERVALS,
    };
  });
};
