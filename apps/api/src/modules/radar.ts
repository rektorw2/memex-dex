import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { isOkxConfigured } from '../services/okx.js';
import { isTelegramConfigured, pollTelegramUpdates } from '../services/telegram.js';
import { radarPerformance } from '../workers/radar-tracker.js';
import { downsample } from '@memex/core';
import { cached } from '../lib/cache.js';

/**
 * Порядки выдачи ленты.
 *
 * Вынесены в таблицу, а не в цепочку тернарных операторов: вариантов
 * шесть, и в выражении они перестают читаться. Каждый заканчивается
 * временем находки — при равных значениях порядок должен быть
 * определённым, иначе список прыгает между обновлениями.
 */
const RADAR_SORTS: Record<string, P.RadarEventOrderByWithRelationInput[]> = {
  recent: [{ firstSeenAt: 'desc' }],
  growth: [{ currentMultiple: 'desc' }, { firstSeenAt: 'desc' }],
  liquidity: [{ liquidityUsd: 'desc' }, { firstSeenAt: 'desc' }],
  // По риску — от безопасного к опасному: смотреть список начинают
  // с того, что можно рассматривать всерьёз.
  risk: [{ riskScore: 'asc' }, { firstSeenAt: 'desc' }],
  holders: [{ currentHolders: 'desc' }, { firstSeenAt: 'desc' }],
  wallets: [{ walletSignalScore: 'desc' }, { firstSeenAt: 'desc' }],
};

/**
 * Живая сводка для шапки радара.
 *
 * Отвечает на вопрос «что происходит прямо сейчас» до того, как человек
 * начнёт читать карточки. Считается за сутки: радар про свежее,
 * и находка трёхдневной давности к текущей картине отношения не имеет.
 */
async function radarSummary(chain?: string) {
  // Сводка живёт в кеше пятнадцать секунд.
  //
  // Пять запросов к базе на каждое обращение к ленте — это пять
  // запросов, умноженные на число открытых вкладок и делённые
  // на интервал обновления. При этом считаются суточные счётчики:
  // за пятнадцать секунд они не меняются настолько, чтобы это
  // стоило пересчёта.
  const hit = await cached(
    `radar:summary:${chain ?? 'all'}`,
    () => computeRadarSummary(chain),
    { ttlMs: 15_000, staleMs: 120_000 },
  ).catch(() => null);

  return hit?.value ?? (await computeRadarSummary(chain));
}

async function computeRadarSummary(chain?: string) {
  const since = new Date(Date.now() - 24 * 3_600_000);
  const where = {
    firstSeenAt: { gte: since },
    // Те же условия, что и у ленты: число в шапке, не совпадающее
    // со списком под ней, хуже отсутствия числа — оно выглядит
    // как факт и вводит в заблуждение.
    riskLevel: { not: 'blocked' },
    ...(chain ? { chain: chain as never } : {}),
  };

  const [total, lowRisk, highRisk, agg, latest] = await Promise.all([
    prisma.radarEvent.count({ where }),
    prisma.radarEvent.count({ where: { ...where, riskScore: { lt: 30 } } }),
    prisma.radarEvent.count({ where: { ...where, riskScore: { gte: 60 } } }),
    prisma.radarEvent.aggregate({ where, _avg: { currentMultiple: true } }),
    prisma.radarEvent.findFirst({
      where: chain ? { chain: chain as never } : {},
      orderBy: { lastCheckedAt: 'desc' },
      select: { lastCheckedAt: true },
    }),
  ]);

  const avg = agg._avg?.currentMultiple;

  return {
    found24h: total,
    lowRisk,
    highRisk,
    // Средний рост в процентах, а не кратностью: «+4%» понятнее,
    // чем «1.04×», когда речь о среднем по выборке.
    avgGrowthPct: avg != null ? (Number(avg) - 1) * 100 : null,
    lastCheckedAt: latest?.lastCheckedAt ?? null,
  };
}

export const radarRoutes: FastifyPluginAsync = async (app) => {
  /** Лента находок. Открыта всем: это витрина, а не персональные данные. */
  app.get('/radar', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        minLiquidity: z.coerce.number().optional(),
        maxRiskScore: z.coerce.number().optional(),
        maxAgeHours: z.coerce.number().optional(),
        /** Показать только находки, где есть покупки размеченных кошельков. */
        smartOnly: z.coerce.boolean().optional(),
        /** Показать скрытое. Осознанное действие, по умолчанию выключено. */
        includeBlocked: z.coerce.boolean().default(false),
        /**
         * Порядок выдачи.
         *
         * «Сначала новые» — основной: радар про свежесть. Остальные
         * нужны, когда список накопился и хронология перестаёт помогать.
         */
        sort: z
          .enum(['recent', 'growth', 'liquidity', 'risk', 'holders', 'wallets'])
          .default('recent'),
        limit: z.coerce.number().max(100).default(50),
      })
      .parse(req.query);

    const events = await prisma.radarEvent.findMany({
      where: {
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(q.minLiquidity ? { liquidityUsd: { gte: q.minLiquidity } } : {}),
        ...(q.maxRiskScore != null ? { riskScore: { lte: q.maxRiskScore } } : {}),
        ...(q.maxAgeHours != null ? { poolAgeHours: { lte: q.maxAgeHours } } : {}),
        ...(q.smartOnly ? { smartBuyers: { gt: 0 } } : {}),
        // Заблокированные находки в ленту не попадают.
        //
        // Это не то же самое, что фильтр по уровню риска: тот выбирает
        // из показываемого, а здесь речь о токенах, которые показывать
        // нельзя вовсе — покинутый пул, ловушка, подделка. Радар
        // предлагает, а не просто перечисляет, и предлагать такое
        // означает отвечать за последствия.
        ...(q.includeBlocked ? {} : { riskLevel: { not: 'blocked' } }),
      },
      orderBy: RADAR_SORTS[q.sort],
      take: q.limit,
    });

    return {
      sources: { okx: isOkxConfigured(), geckoterminal: true },
      minLiquidityUsd: env.RADAR_MIN_LIQUIDITY_USD,
      // Сводка считается по тем же условиям, что и лента: цифра
      // в шапке, не совпадающая со списком под ней, хуже отсутствия
      // цифры — она выглядит как факт и вводит в заблуждение.
      summary: await radarSummary(q.chain),
      events: events.map(serializeEvent),
    };
  });

  /**
   * Результаты находок — то, ради чего радар вообще существует.
   *
   * Сортировка по пиковой кратности по умолчанию, но текущее значение
   * отдаётся всегда: список, где висит только «111x», обманчив — к моменту
   * просмотра токен может стоить дешевле точки входа.
   */
  app.get('/radar/gems', async (req) => {
    const q = z
      .object({
        chain: z.string().optional(),
        sort: z.enum(['peak', 'current', 'recent']).default('peak'),
        minMultiple: z.coerce.number().default(1.5),
        periodDays: z.coerce.number().max(30).default(7),
        limit: z.coerce.number().max(100).default(50),
      })
      .parse(req.query);

    const since = new Date(Date.now() - q.periodDays * 864e5);

    const order =
      q.sort === 'peak'
        ? { peakMultiple: 'desc' as const }
        : q.sort === 'current'
          ? { currentMultiple: 'desc' as const }
          : { firstSeenAt: 'desc' as const };

    const events = await prisma.radarEvent.findMany({
      where: {
        firstSeenAt: { gte: since },
        peakMultiple: { gte: q.minMultiple },
        ...(q.chain ? { chain: q.chain as never } : {}),
      },
      orderBy: [order, { firstSeenAt: 'desc' }],
      take: q.limit,
    });

    return {
      performance: await radarPerformance(),
      events: events.map(serializeEvent),
    };
  });

  /** Качество работы радара за неделю, включая долю провалов. */
  app.get('/radar/performance', async () => radarPerformance());

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

  /**
   * Ручное добавление находок.
   *
   * Существует потому, что автоматический разбор чужих закрытых лент —
   * плохая идея сразу по двум причинам: он нарушает условия площадок и
   * ломается молча, без ошибки в логах. Здесь вместо этого человек
   * смотрит своими глазами и вставляет то, что счёл нужным, а дальше
   * находка идёт по обычному пути: наблюдение, разметка кошельков,
   * проверка автоправилом.
   *
   * Принимается любой текст: адрес, ссылка или целый абзац с несколькими
   * токенами. Требовать чистый адрес значит гарантированно получать
   * вставленное не туда.
   */
  app.post('/radar/watch', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z.object({ text: z.string().min(1).max(20_000) }).parse(req.body);
    const { addWatched } = await import('../workers/radar-scanner.js');
    return addWatched(body.text);
  });

  /** Немедленный запуск сканирования — для админа. */
  app.post('/radar/scan', { preHandler: [app.requireAdmin] }, async () => {
    const { scanRadar } = await import('../workers/radar-scanner.js');
    return scanRadar();
  });
};

/**
 * Единый вид события радара для интерфейса.
 *
 * Показываются обе кратности сразу. Пиковая отвечает на вопрос «был ли
 * шанс», текущая — «что осталось сейчас». По отдельности каждая вводит
 * в заблуждение.
 */
function serializeEvent(e: {
  id: string; chain: string; address: string; symbol: string; name: string;
  priceUsd: P.Decimal | null; currentPriceUsd: P.Decimal | null;
  liquidityUsd: P.Decimal | null; volume24hUsd: P.Decimal | null;
  fdvUsd: P.Decimal | null; mcapAtSignalUsd: P.Decimal | null;
  currentMcapUsd: P.Decimal | null; peakMcapUsd: P.Decimal | null;
  currentMultiple: P.Decimal | null; peakMultiple: P.Decimal | null;
  peakAt: Date | null; poolAgeHours: P.Decimal | null;
  currentHolders: number | null; holdersAtSignal: number | null;
  currentTop10Pct: P.Decimal | null;
  riskScore: number | null; riskFlags: unknown; source: string;
  riskLevel: string | null; riskCodes: string[];
  pricePoints: unknown; firstSeenAt: Date; lastCheckedAt: Date | null;
  isTracking: boolean; smartBuyers: number; smartBuyVolumeUsd: P.Decimal;
  whaleBuyers: number; walletSignalScore: number;
}, pointLimit = 20) {
  return {
    id: e.id,
    chain: e.chain,
    address: e.address,
    symbol: e.symbol,
    name: e.name,
    // Цена находки и текущая — разные величины, и склеивать их нельзя:
    // без цены на момент обнаружения кратность не с чем сверить,
    // а именно она объясняет, откуда взялся показанный рост.
    priceUsd: (e.currentPriceUsd ?? e.priceUsd)?.toString() ?? null,
    discoveryPriceUsd: e.priceUsd?.toString() ?? null,
    currentPriceUsd: e.currentPriceUsd?.toString() ?? null,
    liquidityUsd: e.liquidityUsd?.toString() ?? null,
    volume24hUsd: e.volume24hUsd?.toString() ?? null,
    mcapAtSignalUsd: e.mcapAtSignalUsd?.toString() ?? null,
    currentMcapUsd: e.currentMcapUsd?.toString() ?? null,
    peakMcapUsd: e.peakMcapUsd?.toString() ?? null,
    currentMultiple: e.currentMultiple ? Number(e.currentMultiple) : null,
    peakMultiple: e.peakMultiple ? Number(e.peakMultiple) : null,
    peakAt: e.peakAt,
    poolAgeHours: e.poolAgeHours ? Number(e.poolAgeHours) : null,
    riskScore: e.riskScore,
    riskFlags: e.riskFlags,
    // Уровень и коды из движка терминала. Пока проверка до находки
    // не дошла, оба пусты — и это честнее, чем показывать уровень,
    // посчитанный по другим правилам.
    riskLevel: e.riskLevel,
    riskCodes: e.riskCodes ?? [],
    holders: e.currentHolders,
    holdersAtSignal: e.holdersAtSignal,
    top10Pct: e.currentTop10Pct != null ? Number(e.currentTop10Pct) : null,
    source: e.source,
    // Точки прореживаются на сервере, а не в браузере.
    //
    // Сорок восемь точек на карточку при шестидесяти карточках —
    // почти три тысячи объектов в ответе, и все они разбираются
    // и держатся в памяти ради графика шириной триста пикселей,
    // где различить можно от силы двадцать. Прореживание сохраняет
    // крайние точки и экстремумы, поэтому пик на графике остаётся
    // виден и не расходится с подписью «пик 1.32×».
    points: downsample(
      Array.isArray(e.pricePoints) ? (e.pricePoints as never[]) : [],
      pointLimit,
    ),
    firstSeenAt: e.firstSeenAt,
    lastCheckedAt: e.lastCheckedAt,
    isTracking: e.isTracking,
    // Свод по кошелькам посчитан заранее воркером, здесь только читается.
    wallets: {
      smart: e.smartBuyers,
      whale: e.whaleBuyers,
      smartVolumeUsd: e.smartBuyVolumeUsd.toString(),
      strength: e.walletSignalScore,
    },
  };
}
