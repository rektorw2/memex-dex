import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  summarizeWalletSignal,
  MIN_TRADES_FOR_SCORE,
  SCORE_VERSION,
  WALLET_PNL_VERSION,
  assertSummaryInvariants,
  needsRecomputeSummary,
  wilsonLowerBound,
  type ChainKey,
  type WalletPerformanceSummary,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { walletActivityForToken } from '../workers/wallet-tracker.js';
import {
  serializeWalletPnl,
  walletPnlForWallets,
  walletPnlKey,
} from '../services/wallet-pnl.js';

/**
 * В WalletActivity хранится количество quote-токена, а не готовая
 * долларовая сумма. Поэтому USD-фильтр можно применять только к
 * долларовым котировкам. Сравнить 2.5 SOL с $1 000 было бы ошибкой
 * единиц измерения, а не приблизительным фильтром.
 */
const USD_QUOTE_SYMBOLS = [
  'USD',
  'USDC',
  'USDT',
  'DAI',
  'BUSD',
  'FDUSD',
  'TUSD',
  'USDE',
  'PYUSD',
  'USDS',
] as const;

/**
 * Разметка кошельков: смарт-мани, киты, ранние входы.
 *
 * Всё, что здесь отдаётся, посчитано по нашим же наблюдениям и снабжено
 * размером выборки. Число без выборки в этой области бесполезно: «доля
 * попаданий 100%» на трёх сделках и на трёхстах — совершенно разные
 * утверждения, а выглядят одинаково.
 */
/*
 * Смарт-кошельки — платный раздел.
 *
 * Проверка стоит на каждом читающем маршруте, а не на префиксе:
 * префиксная защита отваливается ровно тогда, когда кто-то добавляет
 * маршрут чуть в стороне, и отваливается молча.
 */
export const walletIntelRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Живая лента сделок отслеживаемых кошельков.
   *
   * Заменяет заглушку на вкладке «Активность». Данные настоящие,
   * из ленты отслеживания OKX; выдуманных строк здесь нет и быть
   * не может — на этой странице человек принимает решения деньгами.
   *
   * Состояние без ключей обрабатывается отдельно и честно: пустая
   * лента и ненастроенный провайдер выглядят одинаково, а означают
   * разное, и различать их обязан сервер, а не догадка интерфейса.
   */
  /** Состояние поиска кошельков. Замерший поиск и спокойный рынок
      выглядят одинаково — пустым списком, и различить их должен сервер. */
  app.get('/wallets/discovery-status', { preHandler: [app.requireAdmin] }, async () => {
    const { discoveryStatus } = await import('../workers/wallet-discovery.js');
    return discoveryStatus();
  });

  /**
   * Состояние источника живых событий.
   *
   * Нужно, чтобы отличить три вещи, которые снаружи выглядят
   * одинаково: спокойный рынок, оборванный сокет и невыставленные
   * ключи. Наружу идёт только код ошибки — объект ошибки провайдера
   * содержит заголовки запроса.
   */
  app.get('/wallets/activity/status', async () => {
    const { getIngestor } = await import('../services/okx-ws-pool.js');
    const { ledgerStatus } = await import('../workers/wallet-ledger-sync.js');

    const source = getIngestor().status();
    const ledger = await ledgerStatus();

    // Отставшая схема важнее состояния сокета: пока база не готова,
    // события некуда складывать, и «здоровый источник» ввёл бы
    // в заблуждение. Отсутствие ключей при этом не превращается
    // в пятисотку — это описанное состояние, а не сбой.
    const status = ledger.status === 'schema_outdated' ? 'schema_outdated' : source.status;

    return { ...source, status, ledger };
  });

  /**
   * Готовность схемы базы.
   *
   * Отдельный маршрут, потому что отвечает на другой вопрос: не «что
   * с лентой», а «совпадает ли база с выкаченным кодом». Наружу идут
   * только имена недостающих объектов — ни SQL, ни строки подключения.
   */
  app.get('/wallets/schema-status', async () => {
    const { checkSchema } = await import('../lib/schema-guard.js');
    const r = await checkSchema();

    return {
      status: r.status,
      checkedAt: r.checkedAt,
      missingObjects: r.missingObjects,
      requiredAction:
        r.status === 'outdated' ? 'DATABASE_SCHEMA_UPDATE_REQUIRED' : null,
      errorCode: r.errorCode ?? null,
    };
  });

  app.get('/wallets/activity', async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'SMART_WALLETS_ACCESS', reply)) return reply;

    const q = z
      .object({
        chain: z.enum(['SOLANA', 'BNB', 'BASE', 'ETHEREUM']).optional(),
        /** all | buy | sell */
        side: z.enum(['all', 'buy', 'sell']).default('all'),
        minVolumeUsd: z.coerce.number().nonnegative().optional(),
        minLiquidityUsd: z.coerce.number().nonnegative().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);

    const { isOkxWalletConfigured } = await import('../services/okx-wallets.js');

    const providerConfigured = isOkxWalletConfigured();

    /*
     * Лента уже поступает через WebSocket и REST-страховку и хранится
     * в WalletActivity. Повторно ходить в OKX при каждом открытии
     * страницы означало платить за одни и те же данные и получать
     * другой набор между двумя соседними запросами.
     */
    const candidates = await prisma.walletActivity.findMany({
      where: {
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(q.side === 'all' ? {} : { side: q.side.toUpperCase() }),
        ...(q.minVolumeUsd != null
          ? {
              quoteSymbol: { in: [...USD_QUOTE_SYMBOLS] },
              quoteAmount: { gte: q.minVolumeUsd },
            }
          : {}),
      },
      orderBy: { tradedAt: 'desc' },
      // Для фильтра ликвидности берём запас, но всё равно одной
      // выборкой. Внешних запросов здесь нет.
      take: q.minLiquidityUsd != null ? Math.min(q.limit * 5, 500) : q.limit,
      select: {
        id: true,
        chain: true,
        walletAddress: true,
        tokenAddress: true,
        tokenSymbol: true,
        side: true,
        quoteSymbol: true,
        quoteAmount: true,
        priceUsd: true,
        marketCapUsd: true,
        txHash: true,
        trackerType: true,
        source: true,
        tradedAt: true,
        receivedAt: true,
        localRealizedPnlUsd: true,
        localPnlState: true,
        pnlVersion: true,
        pnlComputedAt: true,
      },
    });

    /*
     * Токены добираются одним запросом для всей страницы. Это даёт
     * переход в наш терминал, live-рост от цены сделки и ликвидность,
     * не превращая пятьдесят строк в пятьдесят запросов.
     */
    const tokens = candidates.length > 0
      ? await prisma.token.findMany({
        where: {
          OR: candidates.map((event) => ({
            chain: event.chain,
            address: event.tokenAddress,
          })),
        },
        select: {
          id: true,
          chain: true,
          address: true,
          symbol: true,
          liquidityUsd: true,
          priceUsd: true,
          priceUpdatedAt: true,
        },
      })
      : [];

    const tokenByKey = new Map(tokens.map((token) => [walletPnlKey(token.chain, token.address), token]));

    const selected = candidates
      .filter((event) => {
        if (q.minLiquidityUsd == null) return true;
        const token = tokenByKey.get(walletPnlKey(event.chain, event.tokenAddress));
        const liquidity = token?.liquidityUsd == null ? null : Number(token.liquidityUsd);
        return liquidity != null && liquidity >= q.minLiquidityUsd;
      })
      .slice(0, q.limit);

    const pnlByWallet = await walletPnlForWallets(
      selected.map((event) => ({
        chain: event.chain as ChainKey,
        address: event.walletAddress,
      })),
    );

    const page = selected.map((event) => {
        const state = event.pnlVersion === WALLET_PNL_VERSION
          ? event.localPnlState
          : null;
        const token = tokenByKey.get(walletPnlKey(event.chain, event.tokenAddress));
        const currentPrice = token?.priceUsd == null ? null : Number(token.priceUsd);
        const entryPrice = event.priceUsd == null ? null : Number(event.priceUsd);
        const growthPercent =
          currentPrice != null && currentPrice > 0 && entryPrice != null && entryPrice > 0
            ? (currentPrice / entryPrice - 1) * 100
            : null;
        const holderPnl = pnlByWallet.get(walletPnlKey(event.chain, event.walletAddress));

        return {
          dedupeKey: event.id,
          chain: event.chain,
          wallet: event.walletAddress,
          tokenAddress: event.tokenAddress,
          tokenId: token?.id ?? null,
          tokenSymbol: event.tokenSymbol ?? token?.symbol ?? null,
          currentPriceUsd: currentPrice,
          currentPriceAt: token?.priceUpdatedAt?.toISOString() ?? null,
          growthPercent,
          side: event.side,
          quoteSymbol: event.quoteSymbol,
          quoteAmount: event.quoteAmount == null ? null : Number(event.quoteAmount),
          priceUsd: event.priceUsd == null ? null : Number(event.priceUsd),
          marketCapUsd: event.marketCapUsd == null ? null : Number(event.marketCapUsd),
          // Только наше число. realizedPnlUsd провайдера в select
          // намеренно отсутствует и наружу попасть не может.
          realizedPnlUsd:
            state === 'available' && event.localRealizedPnlUsd != null
              ? Number(event.localRealizedPnlUsd)
              : null,
          pnlState: state ?? (event.side === 'BUY' ? 'open_position' : 'pending'),
          pnlSource: state != null ? 'local' : null,
          pnlComputedAt: event.pnlComputedAt?.toISOString() ?? null,
          tradedAt: event.tradedAt.getTime(),
          receivedAt: event.receivedAt.getTime(),
          txHash: event.txHash,
          trackerType: event.trackerType,
          source: event.source,
          holderPnl: holderPnl ? serializeWalletPnl(holderPnl) : null,
        };
      });

    return {
      // Сохранённая лента остаётся полезной при кратком сбое ключа.
      // `configured=false` только когда нет ни источника, ни данных.
      configured: providerConfigured || page.length > 0,
      providerConfigured,
      source: 'Memex ledger · OKX Onchain OS',
      fetchedAt: new Date().toISOString(),
      events: page,
      note: providerConfigured ? undefined : 'OKX provider is not configured; cached events only',
    };
  });

  /**
   * Рейтинг кошельков.
   *
   * По умолчанию — только те, у кого оценка вообще выставлена. Кошельки
   * без оценки не «плохие», у них просто мало истории; смешивать их
   * с оценёнными в одном списке значит вводить в заблуждение.
   */
  app.get('/wallets/top', async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'SMART_WALLETS_ACCESS', reply)) return reply;

    const q = z
      .object({
        chain: z.string().optional(),
        label: z.enum(['smart', 'whale', 'early', 'any']).default('smart'),
        limit: z.coerce.number().max(100).default(50),
      })
      .parse(req.query);

    const wallets = await prisma.traderWallet.findMany({
      where: {
        ...(q.chain ? { chain: q.chain as never } : {}),
        ...(q.label === 'any' ? {} : { label: q.label }),
        ...(q.label === 'smart' ? { score: { not: null } } : {}),
      },
      orderBy: [{ score: { sort: 'desc', nulls: 'last' } }, { volumeUsd: 'desc' }],
      take: q.limit,
    });

    const total = await prisma.traderWallet.count();
    const scored = await prisma.traderWallet.count({ where: { score: { not: null } } });

    /*
     * Сколько строк ещё не пересчитано новыми правилами.
     *
     * Отдаётся наружу намеренно. Пока боевой пересчёт не прошёл,
     * список выглядит опустевшим — оценок нет, — и без этого числа
     * причина неотличима от «смарт-кошельков не нашлось».
     */
    const awaitingRecompute = await prisma.traderWallet.count({
      where: { OR: [{ scoreVersion: null }, { scoreVersion: { lt: SCORE_VERSION } }] },
    });

    return {
      // Состояние набора данных отдаётся всегда: пустой список из-за
      // молодой базы и пустой из-за отсутствия смарт-денег — разные вещи,
      // и интерфейс должен уметь их различить.
      coverage: {
        walletsKnown: total,
        walletsScored: scored,
        walletsAwaitingRecompute: awaitingRecompute,
        minTradesForScore: MIN_TRADES_FOR_SCORE,
      },
      wallets: await (async () => {
        const pnlByWallet = await walletPnlForWallets(
          wallets.map((wallet) => ({
            chain: wallet.chain as ChainKey,
            address: wallet.address,
          })),
        );

        return wallets.map((wallet) => {
          const pnl = pnlByWallet.get(walletPnlKey(wallet.chain, wallet.address));
          return { ...serializeWallet(wallet), pnl: pnl ? serializeWalletPnl(pnl) : null };
        });
      })(),
    };
  });

  /** Карточка кошелька с его сделками. */
  app.get('/wallets/:chain/:address', async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'SMART_WALLETS_ACCESS', reply)) return reply;

    const p = z
      .object({ chain: z.string(), address: z.string() })
      .parse(req.params);

    const wallet = await prisma.traderWallet.findUnique({
      where: { chain_address: { chain: p.chain as never, address: p.address } },
      include: {
        trades: {
          orderBy: { tradedAt: 'desc' },
          take: 100,
        },
      },
    });

    if (!wallet) return reply.code(404).send({ error: 'Кошелёк не найден' });

    const pnlByWallet = await walletPnlForWallets([
      { chain: wallet.chain as ChainKey, address: wallet.address },
    ]);
    const pnl = pnlByWallet.get(walletPnlKey(wallet.chain, wallet.address));

    const tradeTokens = wallet.trades.length === 0
      ? []
      : await prisma.token.findMany({
          where: {
            OR: wallet.trades.map((trade) => ({
              chain: trade.chain,
              address: trade.tokenAddress,
            })),
          },
          select: {
            id: true,
            chain: true,
            address: true,
            symbol: true,
            priceUsd: true,
            priceUpdatedAt: true,
          },
        });
    const tradeTokenByKey = new Map(
      tradeTokens.map((token) => [walletPnlKey(token.chain, token.address), token]),
    );

    return {
      wallet: serializeWallet(wallet),
      pnl: pnl ? serializeWalletPnl(pnl) : null,
      trades: wallet.trades.map((t) => {
        const token = tradeTokenByKey.get(walletPnlKey(t.chain, t.tokenAddress));
        const currentPrice = token?.priceUsd == null ? null : Number(token.priceUsd);
        const entryPrice = t.priceUsd == null ? null : Number(t.priceUsd);

        return {
          id: t.id,
          chain: t.chain,
          tokenAddress: t.tokenAddress,
          tokenId: token?.id ?? null,
          tokenSymbol: token?.symbol ?? null,
          side: t.side,
          amountUsd: t.amountUsd.toString(),
          mcapAtTradeUsd: t.mcapAtTradeUsd?.toString() ?? null,
          poolAgeHours: t.poolAgeHours ? Number(t.poolAgeHours) : null,
          outcomeMultiple: t.outcomeMultiple ? Number(t.outcomeMultiple) : null,
          currentPriceUsd: currentPrice,
          currentPriceAt: token?.priceUpdatedAt?.toISOString() ?? null,
          growthPercent:
            currentPrice != null && currentPrice > 0 && entryPrice != null && entryPrice > 0
              ? (currentPrice / entryPrice - 1) * 100
              : null,
          tradedAt: t.tradedAt,
        };
      }),
    };
  });

  /**
   * Сигнал по токену: кто из размеченных кошельков в нём.
   *
   * Отдельный эндпоинт, а не поле в карточке токена: запрос тяжелее
   * остальных данных страницы, и грузить его нужно после основного
   * содержимого, а не задерживать им всю страницу.
   */
  app.get('/wallets/signal/:chain/:address', async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'SMART_WALLETS_ACCESS', reply)) return reply;

    const p = z.object({ chain: z.string(), address: z.string() }).parse(req.params);
    const q = z.object({ hours: z.coerce.number().max(168).default(48) }).parse(req.query);

    const trades = await walletActivityForToken(p.chain as never, p.address, q.hours);
    const now = Date.now();

    const activity = trades.map((t) => ({
      label: t.wallet.label as 'smart' | 'whale' | 'early' | 'none',
      score: t.wallet.score,
      amountUsd: Number(t.amountUsd),
      hoursAgo: (now - t.tradedAt.getTime()) / 3_600_000,
    }));

    const signal = summarizeWalletSignal(activity);

    // Наверх выносим только размеченные кошельки: список из сотни
    // неизвестных адресов не несёт информации, но создаёт видимость.
    const notable = trades
      .filter((t) => t.wallet.label !== 'none')
      .slice(0, 20)
      .map((t) => ({
        address: t.wallet.address,
        knownAs: t.wallet.knownAs,
        label: t.wallet.label,
        score: t.wallet.score,
        wins2x: t.wallet.wins2x,
        tokensBought: t.wallet.tokensBought,
        avgPeakMultiple: t.wallet.avgPeakMultiple ? Number(t.wallet.avgPeakMultiple) : null,
        amountUsd: t.amountUsd.toString(),
        side: t.side,
        tradedAt: t.tradedAt,
      }));

    return {
      signal,
      // Сколько сделок вообще попало в наблюдение — знаменатель, без
      // которого «3 смарт-кошелька» невозможно интерпретировать.
      observedTrades: trades.length,
      windowHours: q.hours,
      notable,
    };
  });

  /** Немедленный проход сбора и пересчёта — для админа. */
  app.post('/wallets/scan', { preHandler: [app.requireAdmin] }, async () => {
    const { collectTrades, settleOutcomes, rescoreWallets } = await import(
      '../workers/wallet-tracker.js'
    );
    const collected = await collectTrades();
    const settled = await settleOutcomes();
    const rescored = await rescoreWallets();
    return { ...collected, settled, rescored };
  });
};

export function serializeWallet(w: {
  id: string; chain: string; address: string; knownAs: string | null;
  tokensBought: number; wins2x: number; wins5x: number; rugs: number;
  volumeUsd: { toString(): string }; avgPeakMultiple: { toString(): string } | null;
  medianEntryHours: { toString(): string } | null; score: number | null;
  label: string; firstSeenAt: Date; lastActiveAt: Date;
  scorableOutcomes: number | null; pendingOutcomes: number | null;
  ambiguousOutcomes: number | null; scoreVersion: number | null;
  scoreComputedAt: Date | null; scoreConfidence: string | null;
  scoreCoverage: string | null; scoreReason: string | null;
}) {
  /*
   * Сводка собирается здесь целиком и уезжает одним куском.
   *
   * Прежде тут было три разных знаменателя сразу:
   *
   *     settled    = wins2x + rugs     — считался и не использовался
   *     hitRate    = wins2x / tokensBought
   *     sampleSize = tokensBought
   *
   * `wins2x` приходил из расчёта по отдельным покупкам, а
   * `tokensBought` — по уникальным токенам. Десять покупок одного
   * токена давали до десяти побед при одном купленном, то есть долю
   * попаданий больше единицы. Именно это и показывалось на экране
   * как «данные противоречивы».
   *
   * Теперь знаменатель едет вместе с долей, и делить одно поле
   * на другое ни маршруту, ни интерфейсу больше не нужно.
   */
  const summary = storedWalletSummary(w);

  return {
    id: w.id,
    chain: w.chain,
    address: w.address,
    knownAs: w.knownAs,
    label: w.label,

    /** Единственный источник чисел о результативности. */
    summary,

    /*
     * Прежние поля оставлены на время перехода интерфейса.
     * Все они берутся из той же сводки — второго расчёта нет.
     */
    score: summary.score,
    tokensBought: summary.observedTokens,
    wins2x: summary.wins2x,
    wins5x: summary.wins5x,
    rugs: summary.rugs,
    volumeUsd: w.volumeUsd.toString(),
    avgPeakMultiple: summary.avgPeakMultiple,
    medianEntryHours: summary.medianEntryHours,
    hitRate: summary.hitRate,
    sampleSize: summary.scorableOutcomes,

    firstSeenAt: w.firstSeenAt,
    lastActiveAt: w.lastActiveAt,
  };
}

/**
 * Сводка из сохранённых полей кошелька.
 *
 * ─── Что здесь было сломано ─────────────────────────────────────────
 *
 * Знаменатель доли попаданий не хранился, и чтение восстанавливало
 * его так:
 *
 *     scorableOutcomes = max(wins2x, rugs)
 *
 * Это теряет данные. Исход между 0.2x и 2x оцениваемый, но ни победа,
 * ни rug — в `max` он не попадает. Десять оценённых токенов, из них
 * одна победа, один rug и восемь обычных, давали знаменатель 1
 * и долю попаданий 100% вместо 10%. То есть выражение, написанное
 * ради защиты от завышенной доли, само её и завышало — до предела.
 *
 * Восстановить знаменатель из победителей нельзя ни этим выражением,
 * ни `wins2x + rugs`, ни любым другим: победы являются подмножеством
 * оцениваемых исходов, а подмножество не определяет множество. Его
 * можно только хранить, что и делает миграция контракта сводки.
 *
 * Заодно исчезли ещё три подстановки, каждая из которых была
 * утверждением, а не измерением: `computedAt: Date.now()` называл
 * временем расчёта момент открытия страницы; `scoreVersion:
 * SCORE_VERSION` объявлял нынешними правилами любую строку, включая
 * непересчитанную; `ambiguousOutcomes: 0` заявлял об отсутствии
 * недостоверных исходов, ничего о них не зная.
 *
 * ─── Что делает эта функция теперь ──────────────────────────────────
 *
 * Читает сохранённое. Единственное вычисление — доля попаданий,
 * и она выводится из двух сохранённых чисел однозначно. Хранить её
 * третьей копией значило бы завести третий знаменатель, с которого
 * всё и началось.
 */
function storedWalletSummary(w: {
  tokensBought: number;
  wins2x: number;
  wins5x: number;
  rugs: number;
  score: number | null;
  volumeUsd: { toString(): string };
  avgPeakMultiple: { toString(): string } | null;
  medianEntryHours: { toString(): string } | null;
  scorableOutcomes: number | null;
  pendingOutcomes: number | null;
  ambiguousOutcomes: number | null;
  scoreVersion: number | null;
  scoreComputedAt: Date | null;
  scoreConfidence: string | null;
  scoreCoverage: string | null;
  scoreReason: string | null;
}): WalletPerformanceSummary {
  /*
   * Строка от прежних правил.
   *
   * Признак — пустая подпись расчёта. Её нельзя подделать чтением:
   * заполнить её может только пересчёт. Пока она пуста, сохранённые
   * числа посчитаны другим способом, и подгонять их к нынешнему
   * контракту — значит выдавать старую ошибку за исправленный
   * результат.
   */
  if (w.scoreVersion == null || w.scorableOutcomes == null || w.scoreComputedAt == null) {
    return needsRecomputeSummary({
      scoreVersion: w.scoreVersion,
      computedAt: w.scoreComputedAt?.getTime() ?? null,
    });
  }

  /*
   * Строка, посчитанная более ранней версией правил.
   *
   * Тоже ожидает пересчёта: её числа получены способом, который
   * мы уже признали неверным, и то, что они лежат в базе, ничего
   * об их правильности не говорит.
   */
  if (w.scoreVersion < SCORE_VERSION) {
    return needsRecomputeSummary({
      scoreVersion: w.scoreVersion,
      computedAt: w.scoreComputedAt.getTime(),
    });
  }

  const scorableOutcomes = w.scorableOutcomes;

  const summary: WalletPerformanceSummary = {
    observedTokens: w.tokensBought,
    scorableOutcomes,
    // Ноль здесь — сохранённый ноль, а не подставленный.
    pendingOutcomes: w.pendingOutcomes ?? 0,
    ambiguousOutcomes: w.ambiguousOutcomes ?? 0,

    wins2x: w.wins2x,
    wins5x: w.wins5x,
    rugs: w.rugs,

    // Единственное вычисление, и оно однозначно: победы и знаменатель
    // приходят из одного пересчёта и не могут разойтись.
    hitRate: scorableOutcomes > 0 ? w.wins2x / scorableOutcomes : null,
    hitRateLower: scorableOutcomes > 0 ? wilsonLowerBound(w.wins2x, scorableOutcomes) : null,

    avgPeakMultiple: w.avgPeakMultiple ? Number(w.avgPeakMultiple) : null,
    medianEntryHours: w.medianEntryHours ? Number(w.medianEntryHours) : null,
    buyVolumeUsd: Number(w.volumeUsd.toString()),

    score: w.score,
    confidence: (w.scoreConfidence as WalletPerformanceSummary['confidence']) ?? 'none',
    coverage: (w.scoreCoverage as WalletPerformanceSummary['coverage']) ?? 'complete',
    reason: w.scoreReason,

    computedAt: w.scoreComputedAt.getTime(),
    scoreVersion: w.scoreVersion,
  };

  /*
   * Последняя проверка перед выдачей наружу.
   *
   * Пересчёт уже проверяет инварианты перед записью, но между записью
   * и чтением лежит база, а в базу можно попасть и мимо пересчёта —
   * скриптом, ручным `UPDATE`, недоехавшей миграцией. Невозможные
   * числа на экране выглядят обычными: доля попаданий в 400%
   * читается как «очень хороший кошелёк», а не как «расчёт сломан».
   *
   * Поэтому противоречивая строка теряет не только оценку, но и
   * право показывать свои числа: она уходит как ожидающая пересчёта.
   */
  if (assertSummaryInvariants(summary).length > 0) {
    return needsRecomputeSummary({
      scoreVersion: w.scoreVersion,
      computedAt: w.scoreComputedAt.getTime(),
    });
  }

  return summary;
}
