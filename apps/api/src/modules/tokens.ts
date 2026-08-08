import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  app.get('/tokens', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        search: z.string().optional(),
        limit: z.coerce.number().max(100).default(50),
      })
      .parse(req.query);

    return prisma.token.findMany({
      where: {
        isVerified: true,
        ...(q.chain ? { chain: q.chain as never } : {}),
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
      orderBy: { volume24hUsd: 'desc' },
      take: q.limit,
    });
  });

  app.get('/tokens/:id/candles', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const q = z
      .object({ interval: z.string().default('5m'), limit: z.coerce.number().max(1000).default(300) })
      .parse(req.query);

    const candles = await prisma.candle.findMany({
      where: { tokenId: id, interval: q.interval },
      orderBy: { openTime: 'desc' },
      take: q.limit,
    });

    return candles.reverse().map((c) => ({
      time: Math.floor(c.openTime.getTime() / 1000),
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      volume: Number(c.volumeUsd),
    }));
  });
};
