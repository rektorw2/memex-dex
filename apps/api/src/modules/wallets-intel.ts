import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { summarizeWalletSignal, MIN_TRADES_FOR_SCORE } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { walletActivityForToken } from '../workers/wallet-tracker.js';

/**
 * Разметка кошельков: смарт-мани, киты, ранние входы.
 *
 * Всё, что здесь отдаётся, посчитано по нашим же наблюдениям и снабжено
 * размером выборки. Число без выборки в этой области бесполезно: «доля
 * попаданий 100%» на трёх сделках и на трёхстах — совершенно разные
 * утверждения, а выглядят одинаково.
 */
export const walletIntelRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Рейтинг кошельков.
   *
   * По умолчанию — только те, у кого оценка вообще выставлена. Кошельки
   * без оценки не «плохие», у них просто мало истории; смешивать их
   * с оценёнными в одном списке значит вводить в заблуждение.
   */
  app.get('/wallets/top', async (req) => {
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

    return {
      // Состояние набора данных отдаётся всегда: пустой список из-за
      // молодой базы и пустой из-за отсутствия смарт-денег — разные вещи,
      // и интерфейс должен уметь их различить.
      coverage: {
        walletsKnown: total,
        walletsScored: scored,
        minTradesForScore: MIN_TRADES_FOR_SCORE,
      },
      wallets: wallets.map(serializeWallet),
    };
  });

  /** Карточка кошелька с его сделками. */
  app.get('/wallets/:chain/:address', async (req, reply) => {
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

    return {
      wallet: serializeWallet(wallet),
      trades: wallet.trades.map((t) => ({
        id: t.id,
        chain: t.chain,
        tokenAddress: t.tokenAddress,
        side: t.side,
        amountUsd: t.amountUsd.toString(),
        mcapAtTradeUsd: t.mcapAtTradeUsd?.toString() ?? null,
        poolAgeHours: t.poolAgeHours ? Number(t.poolAgeHours) : null,
        outcomeMultiple: t.outcomeMultiple ? Number(t.outcomeMultiple) : null,
        tradedAt: t.tradedAt,
      })),
    };
  });

  /**
   * Сигнал по токену: кто из размеченных кошельков в нём.
   *
   * Отдельный эндпоинт, а не поле в карточке токена: запрос тяжелее
   * остальных данных страницы, и грузить его нужно после основного
   * содержимого, а не задерживать им всю страницу.
   */
  app.get('/wallets/signal/:chain/:address', async (req) => {
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

function serializeWallet(w: {
  id: string; chain: string; address: string; knownAs: string | null;
  tokensBought: number; wins2x: number; wins5x: number; rugs: number;
  volumeUsd: { toString(): string }; avgPeakMultiple: { toString(): string } | null;
  medianEntryHours: { toString(): string } | null; score: number | null;
  label: string; firstSeenAt: Date; lastActiveAt: Date;
}) {
  const settled = w.wins2x + w.rugs;
  return {
    id: w.id,
    chain: w.chain,
    address: w.address,
    knownAs: w.knownAs,
    label: w.label,
    score: w.score,
    tokensBought: w.tokensBought,
    wins2x: w.wins2x,
    wins5x: w.wins5x,
    rugs: w.rugs,
    volumeUsd: w.volumeUsd.toString(),
    avgPeakMultiple: w.avgPeakMultiple ? Number(w.avgPeakMultiple) : null,
    medianEntryHours: w.medianEntryHours ? Number(w.medianEntryHours) : null,
    // Доля попаданий отдаётся вместе с числом сделок и никогда отдельно.
    hitRate: w.tokensBought > 0 ? w.wins2x / w.tokensBought : null,
    sampleSize: w.tokensBought,
    firstSeenAt: w.firstSeenAt,
    lastActiveAt: w.lastActiveAt,
  };
}
