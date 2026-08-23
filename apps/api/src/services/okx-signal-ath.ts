import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

export interface PeakCandle {
  openTime: Date;
  high: number;
}

/**
 * Продлить ATH всех сигналов токена живой котировкой.
 *
 * Один токен может появляться в Signal несколько раз. Цена относится
 * ко всем событиям, которые уже существовали в момент наблюдения, но
 * не к будущему сигналу. Условие пика стоит в самом updateMany, поэтому
 * поздний ответ другого цикла не может уменьшить уже записанный ATH.
 */
export async function recordOkxSignalLivePeak(
  tokenId: string,
  priceUsd: number,
  observedAt: Date,
): Promise<number> {
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;
  const peak = new P.Decimal(priceUsd);

  const result = await prisma.okxSignal.updateMany({
    where: {
      tokenId,
      signaledAt: { lte: observedAt },
      OR: [{ peakPriceUsd: null }, { peakPriceUsd: { lt: peak } }],
    },
    data: { peakPriceUsd: peak, peakObservedAt: observedAt },
  });

  return result.count;
}

/**
 * Восстановить пики старых сигналов из уже загруженной OHLCV-истории.
 *
 * Для каждого события своя граница времени. Свеча, открывшаяся до
 * сигнала, исключается целиком: её high мог случиться до события, и
 * присваивать такой рост сигналу было бы красивой, но ложной цифрой.
 */
export async function recordOkxSignalCandlePeaks(
  tokenId: string,
  candles: PeakCandle[],
): Promise<number> {
  const valid = candles
    .filter(
      (candle) =>
        candle.openTime instanceof Date &&
        Number.isFinite(candle.openTime.getTime()) &&
        Number.isFinite(candle.high) &&
        candle.high > 0,
    )
    .sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

  const last = valid.at(-1);
  if (!last) return 0;

  const signals = await prisma.okxSignal.findMany({
    where: { tokenId, signaledAt: { lte: last.openTime } },
    select: { id: true, signaledAt: true, peakPriceUsd: true },
  });

  const updates = signals.flatMap((signal) => {
    let peak = signal.peakPriceUsd?.toNumber() ?? 0;
    let observedAt: Date | null = null;

    for (const candle of valid) {
      if (candle.openTime < signal.signaledAt || candle.high <= peak) continue;
      peak = candle.high;
      observedAt = candle.openTime;
    }

    return observedAt
      ? [
          prisma.okxSignal.updateMany({
            where: {
              id: signal.id,
              OR: [{ peakPriceUsd: null }, { peakPriceUsd: { lt: new P.Decimal(peak) } }],
            },
            data: { peakPriceUsd: new P.Decimal(peak), peakObservedAt: observedAt },
          }),
        ]
      : [];
  });

  if (updates.length === 0) return 0;
  const results = await prisma.$transaction(updates);
  return results.reduce((sum, result) => sum + result.count, 0);
}
