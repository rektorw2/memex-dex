import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { assessToken, SAFE_LEVELS, TRADEABLE_LEVELS, looksLikeAddress } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { SUPPORTED_INTERVALS } from '../services/market-data.js';
import { serializeResearch } from '../services/research.js';
import { RULES_VERSION } from '../workers/scam-checker.js';
import { MARKET_DATA_SOURCE } from '../services/okx-market.js';

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
    const body = z
      .object({
        limit: z.number().int().min(1).max(60).default(30),
        /**
         * Сколько секунд отвести проходу.
         *
         * Ограничение по времени, а не только по количеству, появилось
         * потому что проверка одного токена стоит семи обращений
         * к внешним источникам. Шестьдесят токенов — это минуты,
         * и вызов из консоли всё это время выглядит как зависший.
         *
         * Тридцать секунд сверху: дольше держать соединение открытым
         * бессмысленно, обратный прокси всё равно его оборвёт, и это
         * будет выглядеть как ошибка сервера вместо честного
         * «успели столько».
         */
        budgetSeconds: z.number().int().min(5).max(30).default(20),
      })
      .parse(req.body ?? {});

    const { checkBatch } = await import('../workers/scam-checker.js');
    const result = await checkBatch(body.limit, { budgetMs: body.budgetSeconds * 1000 });

    return {
      ...result,
      note: result.timedOut
        ? `Проход остановлен по времени: разобрано ${result.checked}, ` +
          `осталось ${result.remaining} из выборки. Повторите вызов — ` +
          'очередь продолжится с того же места.'
        : result.checked === 0
          ? 'Проверять нечего: все токены разобраны по действующим правилам.'
          : `Разобрано ${result.checked} токенов. Повторите, если check-status ` +
            'показывает непроверенные.',
    };
  });

  app.get('/tokens/check-status', async () => {
    const base = { isQuote: false, isHidden: false } as const;

    const [total, ok, warn, blocked, unchecked, stale] = await Promise.all([
      prisma.token.count({ where: base }),
      // «Прошли проверку» — это verified и low, а не всё, что не заблокировано.
      prisma.token.count({ where: { ...base, riskLevel: { in: [...SAFE_LEVELS] } } }),
      prisma.token.count({ where: { ...base, riskLevel: { in: ['medium', 'high'] } } }),
      prisma.token.count({ where: { ...base, riskLevel: 'blocked' } }),
      prisma.token.count({
        where: { ...base, OR: [{ riskLevel: null }, { riskLevel: 'pending' }] },
      }),
      // Проверенные по устаревшим правилам. Их вердикт формально есть,
      // но верить ему нельзя — считаем отдельно, иначе «проверено 148
      // из 152» выглядит как готовность, которой нет.
      prisma.token.count({ where: { ...base, scamRulesVersion: { lt: RULES_VERSION } } }),
    ]);

    return { total, ok, warn, blocked, unchecked, stale };
  });

  /**
   * Что именно режет выдачу.
   *
   * Появилось после случая, когда версия правил 5 заблокировала 137
   * токенов из 173, и понять причину можно было только перебором
   * гипотез. Счётчик по кодам отвечает на этот вопрос сразу: видно,
   * какое правило сработало сколько раз, и правило, сработавшее
   * на трёх четвертях витрины, почти наверняка описывает норму
   * рынка, а не нарушение.
   */
  app.get('/tokens/risk-breakdown', async (req) => {
    const q = z
      .object({ level: z.enum(['blocked', 'high', 'medium', 'all']).default('blocked') })
      .parse(req.query ?? {});

    const rows = await prisma.token.findMany({
      where: {
        isQuote: false,
        isHidden: false,
        ...(q.level === 'all' ? {} : { riskLevel: q.level }),
      },
      select: { riskCodes: true },
    });

    const counts = new Map<string, number>();
    for (const r of rows) {
      for (const code of r.riskCodes ?? []) {
        counts.set(code, (counts.get(code) ?? 0) + 1);
      }
    }

    return {
      level: q.level,
      tokens: rows.length,
      codes: [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([code, count]) => ({
          code,
          count,
          // Доля от выборки: код, встречающийся почти у всех,
          // описывает рынок, а не отдельный токен.
          share: rows.length > 0 ? Math.round((count / rows.length) * 100) : 0,
        })),
    };
  });

  /**
   * Продвигаемые токены DexScreener, пропущенные через нашу проверку.
   *
   * Список у DexScreener рекламный: «boosted» означает «за размещение
   * заплатили», а не «стоит внимания». Брать его как готовую витрину
   * нельзя — это ровно то, от чего мы месяц чистили терминал.
   *
   * Поэтому здесь он источник кандидатов. Каждый адрес сверяется
   * с нашей базой:
   *
   *   знаем и проверили  — отдаём со своим уровнем риска;
   *   знаем, не проверили — отдаём как непроверенный, честно;
   *   не знаем вовсе      — заводим в базу и ставим в очередь.
   *
   * Последнее важно: без этого вкладка при первом открытии была бы
   * почти пустой, и человек решил бы, что она сломана, хотя на самом
   * деле проверка просто ещё не дошла.
   */
  app.get('/tokens/dexscreener', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        /** Скрывать не прошедшие проверку. По умолчанию да. */
        safeOnly: z.coerce.boolean().default(true),
        limit: z.coerce.number().max(60).default(40),
      })
      .parse(req.query);

    const { fetchBoostedTokens } = await import('../services/dexscreener.js');
    const boosted = await fetchBoostedTokens();

    const filtered = q.chain ? boosted.filter((b) => b.chain === q.chain) : boosted;
    if (filtered.length === 0) {
      return { tokens: [], source: 'DexScreener', unchecked: 0, total: 0 };
    }

    // Сопоставление по паре сеть-адрес, а не по тикеру: тикер
    // не уникален, и совпадение по нему свело бы подделку
    // с настоящим токеном в одну запись.
    const known = await prisma.token.findMany({
      where: {
        OR: filtered.map((b) => ({
          chain: b.chain as never,
          address: { equals: b.address, mode: 'insensitive' as const },
        })),
      },
    });

    const byKey = new Map(known.map((t) => [`${t.chain}:${t.address.toLowerCase()}`, t]));

    // Незнакомые заводим в базу — очередь проверки подхватит их сама.
    // Уровень риска им не выставляется: непроверенное непроверено.
    const missing = filtered.filter((b) => !byKey.has(`${b.chain}:${b.address.toLowerCase()}`));

    if (missing.length > 0) {
      await prisma.token
        .createMany({
          data: missing.slice(0, 20).map((b) => ({
            chain: b.chain as never,
            address: b.address,
            symbol: '???',
            name: b.description?.slice(0, 60) ?? 'Неизвестный токен',
            decimals: b.chain === 'SOLANA' ? 9 : 18,
            logoUrl: b.iconUrl,
            source: 'dexscreener',
            // Скрыт из общей витрины до проверки: попасть туда
            // он должен на общих основаниях, а не потому, что
            // за него заплатили.
            isHidden: true,
          })),
          skipDuplicates: true,
        })
        .catch(() => undefined);
    }

    const rows = filtered
      .map((b) => {
        const t = byKey.get(`${b.chain}:${b.address.toLowerCase()}`);
        if (!t) {
          return {
            id: null,
            chain: b.chain,
            address: b.address,
            symbol: '???',
            name: b.description ?? null,
            logoUrl: b.iconUrl,
            riskLevel: null,
            riskCodes: [] as string[],
            riskScore: null,
            priceUsd: null,
            liquidityUsd: null,
            volume24hUsd: null,
            priceChange24h: null,
            boostAmount: b.boostAmount,
            isNew: true,
          };
        }

        return {
          id: t.id,
          chain: t.chain,
          address: t.address,
          symbol: t.symbol,
          name: t.name,
          logoUrl: t.logoUrl,
          riskLevel: t.riskLevel,
          riskCodes: t.riskCodes ?? [],
          riskScore: t.riskScore,
          priceUsd: t.priceUsd?.toString() ?? null,
          liquidityUsd: t.liquidityUsd?.toString() ?? null,
          volume24hUsd: t.volume24hUsd?.toString() ?? null,
          priceChange24h: t.priceChange24h?.toString() ?? null,
          boostAmount: b.boostAmount,
          isNew: false,
        };
      })
      // Заблокированные не показываем никогда: за них заплатили,
      // но продать их всё равно нельзя.
      .filter((r) => r.riskLevel !== 'blocked')
      .filter((r) => (q.safeOnly ? SAFE_LEVELS.includes(r.riskLevel as never) : true));

    return {
      source: 'DexScreener',
      // Честное число: сколько в исходном списке и сколько дошло.
      total: filtered.length,
      unchecked: filtered.length - known.filter((t) => t.riskLevel != null).length,
      tokens: rows.slice(0, q.limit),
    };
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

    /**
     * Поиск по точному адресу — особый случай.
     *
     * Человек, вставивший адрес контракта, знает, что ищет, и скрывать
     * от него результат неправильно: он всё равно найдёт токен в другом
     * месте, только уже без наших предупреждений. Поэтому по точному
     * адресу показываем всё, включая заблокированное, — но вместе
     * с уровнем риска и причинами, которые интерфейс обязан показать
     * красным.
     *
     * Это не дыра в фильтрации. Разница между «попался в списке»
     * и «нашёл по адресу, который сам ввёл» существенна: в первом
     * случае мы предлагаем, во втором отвечаем на вопрос.
     */
    const byExactAddress = q.search != null && looksLikeAddress(q.search);

    const tokens = await prisma.token.findMany({
      where: byExactAddress
        ? {
            // Регистронезависимо: EVM-адреса хранятся в нижнем регистре,
            // а вставляют их обычно в контрольной форме с заглавными.
            // Требовать точного совпадения строк значило бы не находить
            // токен по его же собственному адресу.
            address: { equals: q.search!.trim(), mode: 'insensitive' },
            ...(q.chain ? { chain: q.chain as never } : {}),
          }
        : {
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
              riskLevel: { in: [...SAFE_LEVELS] },
            }
          : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),

        // Заблокированные скрыты всегда, кроме явного запроса.
        ...(q.includeBlocked ? {} : { riskLevel: { not: 'blocked' } }),
        // Строгий режим: только подтверждённые и низкий риск.
        // Непроверенные сюда не попадают принципиально — незавершённая
        // проверка это отсутствие сведений, а не сведения об отсутствии
        // проблем.
        ...(q.safeOnly ? { riskLevel: { in: [...SAFE_LEVELS] } } : {}),
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
    const listed = { isHidden: false, riskLevel: { in: [...SAFE_LEVELS] } };

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
      // Источник подписывается на стороне сервера, а не зашивается
      // в интерфейс: если завтра основной поставщик сменится, подпись
      // должна смениться вместе с ним, а не остаться прежней.
      dataSource: MARKET_DATA_SOURCE,
      updatedAt: new Date().toISOString(),
      intervals: SUPPORTED_INTERVALS,
    };
  });
};
