import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { SUPPORTED_INTERVALS } from '../services/market-data.js';
import { serializeResearch } from '../services/research.js';

const SORTS = {
  volume: { volume24hUsd: 'desc' },
  liquidity: { liquidityUsd: 'desc' },
  gainers: { priceChange24h: 'desc' },
  losers: { priceChange24h: 'asc' },
  new: { createdAt: 'desc' },
} as const;

export const tokenRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Состояние проверки витрины.
   *
   * Нужно интерфейсу, чтобы пустой или короткий список читался верно:
   * «ничего не найдено» и «проверено ещё не всё» — разные сообщения,
   * и второе не должно выглядеть как первое.
   */
  /**
   * Немедленная перепроверка витрины.
   *
   * Нужна после изменения правил: обычная очередь разбирает по восемь
   * токенов раз в сорок пять секунд, и дожидаться её на полутора сотнях
   * токенов — это двадцать минут, в течение которых в списке висят
   * подделки.
   */
  app.post('/admin/tokens/recheck', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z.object({ limit: z.number().int().min(1).max(60).default(30) })
      .parse(req.body ?? {});

    const { checkBatch } = await import('../workers/scam-checker.js');
    const result = await checkBatch(body.limit);

    return {
      ...result,
      note:
        'Проверено за один проход. Повторите, если осталось непроверенное — ' +
        'за раз разбирается ограниченное число токенов из-за лимитов источников.',
    };
  });

  app.get('/tokens/check-status', async () => {
    const base = { isQuote: false, isHidden: false } as const;

    const [total, ok, warn, blocked, unchecked, stale] = await Promise.all([
      prisma.token.count({ where: base }),
      // «Прошли проверку» — это verified и low, а не всё, что не заблокировано.
      prisma.token.count({ where: { ...base, riskLevel: { in: ['verified', 'low'] } } }),
      prisma.token.count({ where: { ...base, riskLevel: { in: ['medium', 'high'] } } }),
      prisma.token.count({ where: { ...base, riskLevel: 'blocked' } }),
      prisma.token.count({
        where: { ...base, OR: [{ riskLevel: null }, { riskLevel: 'pending' }] },
      }),
      // Проверенные по устаревшим правилам. Их вердикт формально есть,
      // но верить ему нельзя — считаем отдельно, иначе «проверено 148
      // из 152» выглядит как готовность, которой нет.
      prisma.token.count({ where: { ...base, scamRulesVersion: { lt: 4 } } }),
    ]);

    return { total, ok, warn, blocked, unchecked, stale };
  });

  app.get('/tokens', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        search: z.string().optional(),
        sort: z.enum(['volume', 'liquidity', 'gainers', 'losers', 'new']).default('volume'),
        verifiedOnly: z.coerce.boolean().default(false),
        minLiquidity: z.coerce.number().optional(),
        maxRiskScore: z.coerce.number().optional(),
        /**
         * Показать заблокированные. По умолчанию выключено: токен,
         * который нельзя продать, не должен попадаться в списке
         * случайно — его показ должен быть осознанным действием.
         */
        includeBlocked: z.coerce.boolean().default(false),
        /** Только проверенные и чистые. */
        safeOnly: z.coerce.boolean().default(false),
        limit: z.coerce.number().max(200).default(60),
      })
      .parse(req.query);

    /**
     * Сортировка по изменению цены требует более строгой отсечки, чем
     * остальные. В пуле на 20 тысяч долларов одна сделка на тысячу двигает
     * цену на порядки, и «растущие» без фильтра — это список мёртвых
     * токенов с ростом на 120000%, а не рынок. Порог поднимаем на порядок
     * относительно базового и требуем реальный дневной объём.
     */
    const isChangeSort = q.sort === 'gainers' || q.sort === 'losers';
    const liquidityFloor = q.minLiquidity ?? (isChangeSort ? 100_000 : undefined);

    const tokens = await prisma.token.findMany({
      where: {
        isHidden: false,
        ...(q.verifiedOnly ? { isVerified: true } : {}),
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(liquidityFloor ? { liquidityUsd: { gte: liquidityFloor } } : {}),
        ...(isChangeSort
          ? {
              volume24hUsd: { gte: 50_000 },
              priceChange24h: { not: null },
              // По списку растущих принимают самые импульсивные решения,
              // поэтому непроверенным токенам здесь не место. Показывать
              // «+543%» рядом с вопросительным знаком значит предлагать
              // сделку, о предмете которой мы сами ничего не знаем.
              riskLevel: { in: ['verified', 'low'] },
            }
          : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),

        // Заблокированные скрыты всегда, кроме явного запроса.
        ...(q.includeBlocked ? {} : { riskLevel: { not: 'blocked' } }),
        // Строгий режим: только подтверждённые и низкий риск.
        // Непроверенные сюда не попадают принципиально — незавершённая
        // проверка это отсутствие сведений, а не сведения об отсутствии
        // проблем.
        ...(q.safeOnly ? { riskLevel: { in: ['verified', 'low'] } } : {}),
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

      // Вердикт отдаётся всегда, включая null: интерфейс должен уметь
      // отличить «проверен и чист» от «ещё не проверялся».
      riskLevel: t.riskLevel,
      riskCodes: t.riskCodes,
      isRegistered: t.isRegistered,
      scamVerdict: t.scamVerdict,
      scamReasons: t.scamReasons,
      scamCheckedAt: t.scamCheckedAt,
      buys24h: t.buys24h,
      sells24h: t.sells24h,
      socials: t.socials,
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

  /**
   * Полная карточка токена: метрики, разбор рисков, связанные коллы
   * и статистика сделок на платформе.
   *
   * Собрано в один запрос намеренно: страница токена — то место, где
   * пользователь решает, входить ли. Четыре последовательных запроса
   * означали бы, что часть блоков дорисовывается уже после того, как
   * он нажал «Купить».
   */
  app.get('/tokens/:id/overview', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const token = await prisma.token.findUnique({ where: { id }, include: { research: true } });
    if (!token || token.isHidden) return reply.code(404).send({ error: 'Токен не найден' });

    const ageHours = token.createdAt
      ? (Date.now() - token.createdAt.getTime()) / 3_600_000
      : null;

    const risk = assessToken({
      liquidityUsd: token.liquidityUsd?.toString() ?? null,
      volume24hUsd: token.volume24hUsd?.toString() ?? null,
      holders: token.holders,
      topHolderPct: token.topHolderPct?.toString() ?? null,
      lpBurnedPct: token.lpBurnedPct?.toString() ?? null,
      isHoneypot: token.isHoneypot,
      ageHours,
    });

    const [calls, tradeAgg, recentTrades, holdersCount] = await Promise.all([
      prisma.call.findMany({
        where: { tokenId: id, status: { not: 'DRAFT' } },
        orderBy: { publishedAt: 'desc' },
        take: 5,
        select: {
          id: true, title: true, thesis: true, risk: true, status: true,
          entryPriceUsd: true, targets: true, stopLossUsd: true,
          resultPct: true, peakMultiple: true, publishedAt: true,
        },
      }),
      prisma.trade.aggregate({
        where: { status: 'CONFIRMED', OR: [
          { order: { tokenOutId: id, side: 'BUY' } },
          { order: { tokenInId: id, side: 'SELL' } },
        ] },
        _count: true,
        _sum: { valueUsd: true },
      }),
      prisma.trade.findMany({
        where: { status: 'CONFIRMED', OR: [
          { order: { tokenOutId: id, side: 'BUY' } },
          { order: { tokenInId: id, side: 'SELL' } },
        ] },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: {
          id: true, createdAt: true, valueUsd: true, priceUsd: true,
          order: { select: { side: true, source: true } },
        },
      }),
      // Сколько пользователей платформы держат этот токен — сигнал
      // популярности внутри сервиса, а не в сети целиком.
      prisma.position.count({ where: { tokenId: id, quantity: { gt: 0 } } }),
    ]);

    return {
      token: {
        id: token.id,
        chain: token.chain,
        address: token.address,
        symbol: token.symbol,
        name: token.name,
        decimals: token.decimals,
        logoUrl: token.logoUrl,
        isVerified: token.isVerified,
        isQuote: token.isQuote,
        source: token.source,
        poolAddress: token.poolAddress,
        hasChart: token.poolAddress != null,
        priceUsd: token.priceUsd?.toString() ?? null,
        priceChange24h: token.priceChange24h?.toString() ?? null,
        liquidityUsd: token.liquidityUsd?.toString() ?? null,
        volume24hUsd: token.volume24hUsd?.toString() ?? null,
        fdvUsd: token.fdvUsd?.toString() ?? null,
        holders: token.holders,
        lpBurnedPct: token.lpBurnedPct?.toString() ?? null,
        topHolderPct: token.topHolderPct?.toString() ?? null,
        isHoneypot: token.isHoneypot,
        listedAt: token.createdAt,
        metricsUpdated: token.metricsUpdated,
      },
      risk,
      research: token.research ? serializeResearch(token.research) : null,
      calls: calls.map((c) => ({
        ...c,
        entryPriceUsd: c.entryPriceUsd.toString(),
        stopLossUsd: c.stopLossUsd?.toString() ?? null,
        resultPct: c.resultPct?.toString() ?? null,
        peakMultiple: c.peakMultiple?.toString() ?? null,
      })),
      platformStats: {
        trades: tradeAgg._count,
        volumeUsd: tradeAgg._sum?.valueUsd?.toString() ?? '0',
        holders: holdersCount,
      },
      recentTrades: recentTrades.map((t) => ({
        id: t.id,
        date: t.createdAt,
        side: t.order.side,
        source: t.order.source,
        valueUsd: t.valueUsd.toString(),
        priceUsd: t.priceUsd.toString(),
      })),
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
    // Сводка считается по тем же токенам, что попадают в список:
    // объём и ликвидность, включающие заблокированные, описывают
    // не тот рынок, который человек видит на экране.
    const listed = { isHidden: false, riskLevel: { in: ['verified', 'low'] } } as const;

    const [total, passed, byChain, agg] = await Promise.all([
      prisma.token.count({ where: { isHidden: false } }),
      prisma.token.count({ where: listed }),
      prisma.token.groupBy({ by: ['chain'], where: listed, _count: true }),
      prisma.token.aggregate({
        where: listed,
        _sum: { volume24hUsd: true, liquidityUsd: true },
      }),
    ]);

    return {
      tokens: total,
      passedCheck: passed,
      byChain: Object.fromEntries(byChain.map((c) => [c.chain, c._count])),
      volume24hUsd: agg._sum?.volume24hUsd?.toString() ?? '0',
      liquidityUsd: agg._sum?.liquidityUsd?.toString() ?? '0',
      intervals: SUPPORTED_INTERVALS,
    };
  });
};
