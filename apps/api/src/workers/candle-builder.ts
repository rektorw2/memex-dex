import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchOhlcv, isMarketDataSupported } from '../services/market-data.js';

/**
 * Загрузка свечей для графиков.
 *
 * Лимит поставщика — 25 запросов в минуту на все нужды сервиса, а токенов
 * в витрине могут быть сотни. Поэтому свечи обновляются не для всех сразу,
 * а по кругу: за один проход обрабатывается небольшая пачка, приоритет —
 * у токенов, которые дольше всех не обновлялись.
 *
 * Интервалы тоже разделены по частоте: пятиминутки нужны свежими для
 * торговли, дневные меняются раз в сутки и грузятся редко.
 */

const TICK_MS = 20_000;
const BATCH_SIZE = 4;

/** Как часто обновлять свечи каждого интервала. */
const INTERVAL_FRESHNESS_MS: Record<string, number> = {
  '5m': 5 * 60_000,
  '1h': 30 * 60_000,
  '1d': 6 * 60 * 60_000,
};

let running = false;
/** Позиция в круговом обходе токенов. */
let cursor = 0;

export async function syncCandlesBatch(): Promise<number> {
  const tokens = await prisma.token.findMany({
    where: { poolAddress: { not: null }, isHidden: false },
    select: { id: true, chain: true, symbol: true, poolAddress: true },
    orderBy: { volume24hUsd: 'desc' },
    take: 300,
  });

  const candidates = tokens.filter((t) => isMarketDataSupported(t.chain));
  if (candidates.length === 0) return 0;

  let processed = 0;

  for (let i = 0; i < BATCH_SIZE && i < candidates.length; i++) {
    const token = candidates[(cursor + i) % candidates.length]!;

    for (const [interval, freshness] of Object.entries(INTERVAL_FRESHNESS_MS)) {
      // Пропускаем интервалы, обновлённые недавно: лимит запросов дороже
      // лишней точности на дневном графике.
      const newest = await prisma.candle.findFirst({
        where: { tokenId: token.id, interval },
        orderBy: { openTime: 'desc' },
        select: { openTime: true },
      });

      if (newest && Date.now() - newest.openTime.getTime() < freshness) continue;

      const candles = await fetchOhlcv(token.chain, token.poolAddress!, interval, 300);
      if (candles.length === 0) continue;

      // Пишем одной транзакцией: частично записанный набор свечей
      // рисует на графике разрывы, которые выглядят как обвал цены.
      await prisma.$transaction(
        candles.map((c) =>
          prisma.candle.upsert({
            where: {
              tokenId_interval_openTime: {
                tokenId: token.id,
                interval,
                openTime: c.openTime,
              },
            },
            create: {
              tokenId: token.id,
              interval,
              openTime: c.openTime,
              open: new P.Decimal(c.open),
              high: new P.Decimal(c.high),
              low: new P.Decimal(c.low),
              close: new P.Decimal(c.close),
              volumeUsd: new P.Decimal(c.volumeUsd || 0),
            },
            // Последняя свеча ещё формируется — её нужно перезаписывать,
            // иначе график замрёт на цене начала текущего интервала.
            update: {
              open: new P.Decimal(c.open),
              high: new P.Decimal(c.high),
              low: new P.Decimal(c.low),
              close: new P.Decimal(c.close),
              volumeUsd: new P.Decimal(c.volumeUsd || 0),
            },
          }),
        ),
      );

      processed++;
      logger.debug({ symbol: token.symbol, interval, count: candles.length }, 'свечи обновлены');
    }
  }

  cursor = (cursor + BATCH_SIZE) % candidates.length;
  return processed;
}

/** Удаление устаревших свечей: без этого таблица растёт бесконечно. */
export async function pruneOldCandles(): Promise<number> {
  const cutoffs: Record<string, number> = {
    '5m': 7 * 24 * 3600_000, // неделя пятиминуток
    '1h': 90 * 24 * 3600_000, // три месяца часовых
    '1d': 3 * 365 * 24 * 3600_000, // три года дневных
  };

  let deleted = 0;
  for (const [interval, maxAgeMs] of Object.entries(cutoffs)) {
    const res = await prisma.candle.deleteMany({
      where: { interval, openTime: { lt: new Date(Date.now() - maxAgeMs) } },
    });
    deleted += res.count;
  }
  return deleted;
}

export function startCandleBuilder() {
  if (running) return;
  running = true;

  const loop = async () => {
    let ticks = 0;
    while (running) {
      await syncCandlesBatch().catch((e) =>
        logger.error({ err: e?.message }, 'сбой загрузки свечей'),
      );

      // Уборка раз в час, а не каждый проход: удаление по времени —
      // тяжёлый запрос, и гонять его каждые двадцать секунд незачем.
      if (++ticks % 180 === 0) {
        const n = await pruneOldCandles().catch(() => 0);
        if (n > 0) logger.info({ deleted: n }, 'старые свечи удалены');
      }

      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  void loop();
  logger.info('загрузчик свечей запущен');
}

export function stopCandleBuilder() {
  running = false;
}
