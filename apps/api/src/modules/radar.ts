import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { isOkxConfigured } from '../services/okx.js';
import { isTelegramConfigured, pollTelegramUpdates } from '../services/telegram.js';

export const radarRoutes: FastifyPluginAsync = async (app) => {
  /** Лента находок. Открыта всем: это витрина, а не персональные данные. */
  app.get('/radar', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        minLiquidity: z.coerce.number().optional(),
        maxRiskScore: z.coerce.number().optional(),
        maxAgeHours: z.coerce.number().optional(),
        limit: z.coerce.number().max(100).default(50),
      })
      .parse(req.query);

    const events = await prisma.radarEvent.findMany({
      where: {
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(q.minLiquidity ? { liquidityUsd: { gte: q.minLiquidity } } : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),
        ...(q.maxAgeHours != null ? { poolAgeHours: { lte: q.maxAgeHours } } : {}),
      },
      orderBy: { firstSeenAt: 'desc' },
      take: q.limit,
    });

    return {
      sources: { okx: isOkxConfigured(), geckoterminal: true },
      minLiquidityUsd: env.RADAR_MIN_LIQUIDITY_USD,
      events: events.map((e: (typeof events)[number]) => ({
        id: e.id,
        chain: e.chain,
        address: e.address,
        symbol: e.symbol,
        name: e.name,
        priceUsd: e.priceUsd?.toString() ?? null,
        liquidityUsd: e.liquidityUsd?.toString() ?? null,
        volume24hUsd: e.volume24hUsd?.toString() ?? null,
        fdvUsd: e.fdvUsd?.toString() ?? null,
        poolAgeHours: e.poolAgeHours ? Number(e.poolAgeHours) : null,
        riskScore: e.riskScore,
        riskFlags: e.riskFlags,
        source: e.source,
        firstSeenAt: e.firstSeenAt,
      })),
    };
  });

  /** Настройки уведомлений пользователя. */
  app.get('/radar/subscription', { preHandler: [app.authenticate] }, async (req) => {
    const [subs, user] = await Promise.all([
      prisma.radarSubscription.findMany({ where: { userId: req.user.sub } }),
      prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { telegramChatId: true, telegramLinkCode: true },
      }),
    ]);

    return {
      subscriptions: subs,
      telegram: {
        enabled: isTelegramConfigured(),
        linked: Boolean(user?.telegramChatId),
        linkCode: user?.telegramLinkCode ?? null,
      },
    };
  });

  app.put('/radar/subscription', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        channel: z.enum(['IN_APP', 'TELEGRAM']),
        isActive: z.boolean().default(true),
        chains: z.array(z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE'])).default([]),
        minLiquidityUsd: z.number().nonnegative().optional(),
        minVolume24hUsd: z.number().nonnegative().optional(),
        maxRiskScore: z.number().int().min(0).max(100).optional(),
        maxPoolAgeHours: z.number().int().min(1).max(720).optional(),
        maxAlertsPerHour: z.number().int().min(1).max(100).default(20),
      })
      .parse(req.body);

    if (body.channel === 'TELEGRAM') {
      const user = await prisma.user.findUnique({
        where: { id: req.user.sub },
        select: { telegramChatId: true },
      });
      if (!user?.telegramChatId) {
        return reply.code(400).send({
          error: 'Сначала привяжите Telegram: получите код и отправьте его боту.',
        });
      }
    }

    const data = {
      isActive: body.isActive,
      chains: body.chains,
      minLiquidityUsd: body.minLiquidityUsd != null ? new P.Decimal(body.minLiquidityUsd) : null,
      minVolume24hUsd: body.minVolume24hUsd != null ? new P.Decimal(body.minVolume24hUsd) : null,
      maxRiskScore: body.maxRiskScore ?? null,
      maxPoolAgeHours: body.maxPoolAgeHours ?? null,
      maxAlertsPerHour: body.maxAlertsPerHour,
    };

    const sub = await prisma.radarSubscription.upsert({
      where: { userId_channel: { userId: req.user.sub, channel: body.channel } },
      create: { userId: req.user.sub, channel: body.channel, ...data },
      update: data,
    });

    return { subscription: sub };
  });

  /**
   * Код привязки Telegram.
   *
   * Направление выбрано «пользователь отправляет код боту», а не наоборот:
   * обратный вариант требует webhook с постоянно доступным адресом, а на
   * бесплатном хостинге со сном сервиса такой webhook теряет сообщения.
   */
  app.post('/radar/telegram/code', { preHandler: [app.authenticate] }, async (req) => {
    const code = randomBytes(4).toString('hex').toUpperCase();
    await prisma.user.update({
      where: { id: req.user.sub },
      data: { telegramLinkCode: code },
    });
    return {
      code,
      instructions: `Отправьте боту сообщение: /link ${code}`,
      enabled: isTelegramConfigured(),
    };
  });

  /**
   * Разбор входящих сообщений бота: ищем команду привязки.
   * Вызывается воркером; отдельного вебхука не требуется.
   */
  app.post('/radar/telegram/sync', { preHandler: [app.requireAdmin] }, async () => {
    if (!isTelegramConfigured()) return { linked: 0, enabled: false };

    const updates = await pollTelegramUpdates(0);
    let linked = 0;

    for (const u of updates) {
      const match = u.text.match(/^\/link\s+([A-F0-9]{8})$/i);
      if (!match) continue;

      const code = match[1]!.toUpperCase();
      const user = await prisma.user.findUnique({ where: { telegramLinkCode: code } });
      if (!user) continue;

      await prisma.user.update({
        where: { id: user.id },
        // Код одноразовый: повторное использование позволило бы
        // перепривязать чужой аккаунт, зная старый код.
        data: { telegramChatId: u.chatId, telegramLinkCode: null },
      });
      linked++;
    }

    return { linked, enabled: true, processed: updates.length };
  });

  /** Немедленный запуск сканирования — для админа. */
  app.post('/radar/scan', { preHandler: [app.requireAdmin] }, async () => {
    const { scanRadar } = await import('../workers/radar-scanner.js');
    return scanRadar();
  });
};
