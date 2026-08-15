import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fetchPoolForToken, isMarketDataSupported } from '../services/market-data.js';

/**
 * Отслеживание судьбы найденных токенов.
 *
 * Это главное, что отличает радар от простого списка новинок. Найти новый
 * пул умеет любой скрипт; ценность появляется, когда видно, что с этими
 * находками стало дальше — и в плюс, и в минус.
 *
 * Ключевое решение: показываем и пиковую кратность, и текущую.
 * Витрина, где висит только «111x», вводит в заблуждение — к моменту
 * просмотра токен может стоить вдвое дешевле точки входа. Пик отвечает
 * на вопрос «был ли шанс», текущее значение — «что осталось сейчас».
 */

const TICK_MS = 60_000;
/** Сколько находок обновляем за один проход: лимит поставщика 25 запросов в минуту. */
const BATCH = 12;
/** Через сколько дней наблюдение прекращается. */
const TRACK_DAYS = 30;
/** Максимум точек в мини-графике. */
const MAX_POINTS = 48;

let running = false;

interface PricePoint {
  t: number;
  p: number | null;
  m: number | null;
}

export async function trackBatch(): Promise<number> {
  const cutoff = new Date(Date.now() - TRACK_DAYS * 864e5);

  // Сначала те, кого дольше всех не проверяли: так обновление
  // распределяется равномерно и свежие находки не голодают.
  const events = await prisma.radarEvent.findMany({
    where: {
      isTracking: true,
      firstSeenAt: { gte: cutoff },
    },
    orderBy: [{ lastCheckedAt: { sort: 'asc', nulls: 'first' } }],
    take: BATCH,
  });

  if (events.length === 0) {
    // Прекращаем наблюдение за теми, кто вышел за горизонт.
    await prisma.radarEvent.updateMany({
      where: { isTracking: true, firstSeenAt: { lt: cutoff } },
      data: { isTracking: false },
    });
    return 0;
  }

  let updated = 0;

  for (const e of events) {
    if (!isMarketDataSupported(e.chain)) {
      await prisma.radarEvent.update({
        where: { id: e.id },
        data: { isTracking: false, lastCheckedAt: new Date() },
      });
      continue;
    }

    const pool = await fetchPoolForToken(e.chain, e.address);

    if (!pool) {
      // Пул исчез из выдачи — обычно это значит, что ликвидность вынули.
      // Запись сохраняем: обнулившийся токен в истории радара честнее,
      // чем его молчаливое исчезновение.
      await prisma.radarEvent.update({
        where: { id: e.id },
        data: { lastCheckedAt: new Date(), isTracking: false },
      });
      continue;
    }

    const baseMcap = e.mcapAtSignalUsd ?? e.fdvUsd;
    const currentMcap = pool.fdvUsd != null ? new P.Decimal(pool.fdvUsd) : null;

    // Кратность считаем по капитализации, а не по цене: у мем-коинов
    // бывают ребейзы и доп. эмиссия, при которых цена и капитализация
    // расходятся, и цена перестаёт отражать результат вложения.
    let currentMultiple: P.Decimal | null = null;
    if (baseMcap && baseMcap.gt(0) && currentMcap) {
      currentMultiple = currentMcap.div(baseMcap);
    }

    const prevPeakMcap = e.peakMcapUsd;
    const isNewPeak = currentMcap != null && (!prevPeakMcap || currentMcap.gt(prevPeakMcap));

    const peakMcap = isNewPeak ? currentMcap : prevPeakMcap;
    const peakMultiple =
      baseMcap && baseMcap.gt(0) && peakMcap ? peakMcap.div(baseMcap) : e.peakMultiple;

    // Точки графика: добавляем новую, старые вытесняем.
    const points: PricePoint[] = Array.isArray(e.pricePoints)
      ? (e.pricePoints as unknown as PricePoint[])
      : [];
    points.push({
      t: Date.now(),
      p: pool.priceUsd,
      m: pool.fdvUsd,
    });
    const trimmed = points.slice(-MAX_POINTS);

    await prisma.radarEvent.update({
      where: { id: e.id },
      data: {
        currentPriceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : null,
        currentMcapUsd: currentMcap,
        liquidityUsd: pool.liquidityUsd != null ? new P.Decimal(pool.liquidityUsd) : e.liquidityUsd,
        volume24hUsd: pool.volume24hUsd != null ? new P.Decimal(pool.volume24hUsd) : e.volume24hUsd,
        peakMcapUsd: peakMcap,
        currentMultiple,
        peakMultiple,
        ...(isNewPeak ? { peakAt: new Date() } : {}),
        pricePoints: trimmed as unknown as P.InputJsonValue,
        lastCheckedAt: new Date(),
      },
    });

    updated++;
  }

  return updated;
}

export function startRadarTracker() {
  if (running) return;
  running = true;

  const loop = async () => {
    while (running) {
      await trackBatch().catch((e) =>
        logger.error({ err: e?.message }, 'сбой отслеживания находок радара'),
      );
      await new Promise((r) => setTimeout(r, TICK_MS));
    }
  };
  void loop();
  logger.info('трекер результатов радара запущен');
}

export function stopRadarTracker() {
  running = false;
}

/**
 * Сводка по качеству радара.
 *
 * Показывается открыто, включая долю провалов. Радар, который отчитывается
 * только победами, бесполезен как инструмент принятия решений: без знания
 * доли неудач кратность отдельной находки ничего не значит.
 */
export async function radarPerformance() {
  const since = new Date(Date.now() - 7 * 864e5);

  const events = await prisma.radarEvent.findMany({
    where: { firstSeenAt: { gte: since }, peakMultiple: { not: null } },
    select: { peakMultiple: true, currentMultiple: true },
  });

  if (events.length === 0) {
    return { total: 0, hitRate2x: 0, hitRate5x: 0, rugRate: 0, medianPeak: 0 };
  }

  const peaks = events.map((e) => Number(e.peakMultiple ?? 0)).sort((a, b) => a - b);
  const current = events.map((e) => Number(e.currentMultiple ?? 0));

  const count = (arr: number[], pred: (v: number) => boolean) => arr.filter(pred).length;
  const pct = (n: number) => Math.round((n / events.length) * 1000) / 10;

  return {
    total: events.length,
    /** Доля находок, удвоившихся хотя бы на пике. */
    hitRate2x: pct(count(peaks, (v) => v >= 2)),
    hitRate5x: pct(count(peaks, (v) => v >= 5)),
    /** Доля потерявших более 80% капитализации — практически всегда rug. */
    rugRate: pct(count(current, (v) => v > 0 && v < 0.2)),
    medianPeak: peaks[Math.floor(peaks.length / 2)] ?? 0,
  };
}
