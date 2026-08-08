import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getAdapter } from '../chains/index.js';
import { logger } from '../lib/logger.js';

/**
 * Обновление цен и риск-метрик.
 * Цены — часто (они нужны воркеру лимиток), метрики ликвидности — реже.
 */

const PRICE_INTERVAL_MS = 10_000;
let running = false;

export async function updatePrices() {
  const tokens = await prisma.token.findMany({
    where: { isVerified: true },
    select: { id: true, chain: true, address: true, symbol: true, priceUsd: true },
    take: 500,
  });

  // Группируем по сети, чтобы не долбить один RPC последовательно.
  const byChain = new Map<string, typeof tokens>();
  for (const t of tokens) {
    const arr = byChain.get(t.chain) ?? [];
    arr.push(t);
    byChain.set(t.chain, arr);
  }

  for (const [chain, list] of byChain) {
    const adapter = getAdapter(chain as never);
    // Ограничиваем параллелизм: публичные RPC отдают 429 уже на 20 rps.
    const CONCURRENCY = 5;
    for (let i = 0; i < list.length; i += CONCURRENCY) {
      const batch = list.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (t) => {
          try {
            const price = await adapter.getPriceUsd(t.address);
            if (price == null || price <= 0) return;

            await prisma.token.update({
              where: { id: t.id },
              data: { priceUsd: new P.Decimal(price), metricsUpdated: new Date() },
            });

            // Обновляем пик по активным коллам — для честной статистики автора.
            await prisma.call.updateMany({
              where: {
                tokenId: t.id,
                status: 'PUBLISHED',
                OR: [{ peakPriceUsd: null }, { peakPriceUsd: { lt: new P.Decimal(price) } }],
              },
              data: { peakPriceUsd: new P.Decimal(price) },
            });
          } catch (e: any) {
            logger.debug({ err: e?.message, symbol: t.symbol }, 'не удалось обновить цену');
          }
        }),
      );
    }
  }
}

export function startPriceUpdater() {
  if (running) return;
  running = true;
  const loop = async () => {
    while (running) {
      await updatePrices().catch((e) => logger.error({ err: e?.message }, 'сбой обновления цен'));
      await new Promise((r) => setTimeout(r, PRICE_INTERVAL_MS));
    }
  };
  void loop();
  logger.info('воркер цен запущен');
}

export function stopPriceUpdater() {
  running = false;
}
