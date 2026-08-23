/**
 * Живая лента OKX Signal → история сигналов и каталог токенов.
 *
 * Основной путь — официальный WebSocket. REST вызывается один раз при
 * старте для заполнения последних событий и затем только при нездоровом
 * сокете, по одной сети за проход. Это даёт минимальную задержку без
 * превращения открытой вкладки в потребителя платной квоты OKX.
 */

import { Prisma as P } from '@prisma/client';
import { OKX_CHAIN_INDEX, type ChainKey, type OkxSignal } from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isOkxConfigured, fetchLatestSignals } from '../services/okx-market.js';
import { OkxWalletWebSocketClient } from '../services/okx-ws-client.js';
import { markHot } from './hot-tokens.js';

export type SignalSource = 'okx_websocket' | 'okx_rest';
export type SignalIngestResult = 'created' | 'duplicate' | 'failed';

const CHAINS = (Object.entries(OKX_CHAIN_INDEX) as Array<[ChainKey, string | null]>)
  .filter((entry): entry is [ChainKey, string] => entry[1] != null);

const CHAIN_INDEXES = CHAINS.map(([, index]) => index);

let running = false;
let client: OkxWalletWebSocketClient | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationCursor = 0;
let lastReconciliationAt = 0;

function decimal(value: number | null): P.Decimal | null {
  return value != null && Number.isFinite(value) && value >= 0 ? new P.Decimal(value) : null;
}

/**
 * Сохранить одно событие атомарно вместе с заведением токена.
 *
 * Новая находка создаётся скрытой для обычного «Рынка», но видна в
 * GEMS сразу: там источник списка — сама таблица сигналов. Фоновая
 * проверка может позже открыть токен для общей витрины; на скорость
 * GEMS это не влияет.
 */
export async function ingestOkxSignal(
  signal: OkxSignal,
  source: SignalSource,
): Promise<SignalIngestResult> {
  try {
    const already = await prisma.okxSignal.findUnique({
      where: { providerKey: signal.providerKey },
      select: { tokenId: true },
    });

    if (already) {
      if (already.tokenId) markHot(already.tokenId);
      return 'duplicate';
    }

    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.token.findUnique({
        where: { chain_address: { chain: signal.chain, address: signal.address } },
      });

      const signalIsFresh =
        existing?.priceUpdatedAt == null || signal.signaledAt >= existing.priceUpdatedAt;

      const token = existing
        ? await tx.token.update({
            where: { id: existing.id },
            data: {
              // Ручные правки не перетираются. Заполняем только пробелы.
              logoUrl: existing.logoUrl ?? signal.logoUrl,
              ...(existing.symbol === '???' ? { symbol: signal.symbol } : {}),
              ...(existing.name === 'Неизвестный токен' ? { name: signal.name } : {}),
              ...(signalIsFresh
                ? {
                    ...(signal.priceUsd != null ? { priceUsd: decimal(signal.priceUsd) } : {}),
                    ...(signal.marketCapUsd != null
                      ? { fdvUsd: decimal(signal.marketCapUsd) }
                      : {}),
                    ...(signal.holders != null ? { holders: signal.holders } : {}),
                    ...(signal.top10HolderPct != null
                      ? { topHolderPct: decimal(signal.top10HolderPct) }
                      : {}),
                    priceUpdatedAt: signal.signaledAt,
                    metricsUpdated: new Date(),
                  }
                : {}),
            },
          })
        : await tx.token.create({
            data: {
              chain: signal.chain,
              address: signal.address,
              symbol: signal.symbol,
              name: signal.name,
              decimals: signal.chain === 'SOLANA' ? 9 : 18,
              logoUrl: signal.logoUrl,
              source: 'okx_signal',
              isHidden: true,
              isVerified: false,
              // Это настоящее первое наблюдение провайдера, а не момент,
              // когда после рестарта успел выполниться REST-backfill.
              firstSeenAt: signal.signaledAt,
              priceUsd: decimal(signal.priceUsd),
              priceUpdatedAt: signal.signaledAt,
              fdvUsd: decimal(signal.marketCapUsd),
              holders: signal.holders,
              topHolderPct: decimal(signal.top10HolderPct),
              metricsUpdated: new Date(),
            },
          });

      await tx.okxSignal.create({
        data: {
          providerKey: signal.providerKey,
          chain: signal.chain,
          address: signal.address,
          tokenId: token.id,
          symbol: signal.symbol,
          name: signal.name,
          logoUrl: signal.logoUrl,
          signaledAt: signal.signaledAt,
          priceUsd: decimal(signal.priceUsd),
          marketCapUsd: decimal(signal.marketCapUsd),
          holders: signal.holders,
          top10HolderPct: decimal(signal.top10HolderPct),
          walletTypes: signal.walletTypes,
          triggerWalletCount: signal.triggerWalletCount,
          amountUsd: decimal(signal.amountUsd),
          soldRatioPct: decimal(signal.soldRatioPct),
          source,
        },
      });

      return token.id;
    });

    // Новая находка первой получает цену, свечи и место в очереди
    // проверки. Сам GEMS при этом уже доступен из записи выше.
    markHot(result);
    return 'created';
  } catch (error: any) {
    // WebSocket и REST пересекаются штатно. Уникальный providerKey
    // делает повтор безвредным даже при гонке между ними.
    if (error?.code === 'P2002') return 'duplicate';

    logger.warn(
      { chain: signal.chain, address: signal.address, code: error?.code },
      'OKX Signal: событие не сохранено',
    );
    return 'failed';
  }
}

/** Последние сто событий каждой сети — начальное заполнение после деплоя. */
export async function syncLatestOkxSignals(chains: ChainKey[] = CHAINS.map(([chain]) => chain)) {
  const lists = await Promise.all(chains.map((chain) => fetchLatestSignals(chain, 100)));
  // Старые первыми: если один токен встречается несколько раз, в Token
  // останется цена самого свежего сигнала, а не случайного Promise.
  const signals = lists.flat().sort((a, b) => a.signaledAt.getTime() - b.signaledAt.getTime());

  const stats = { fetched: signals.length, created: 0, duplicate: 0, failed: 0 };
  for (const signal of signals) {
    const result = await ingestOkxSignal(signal, 'okx_rest');
    stats[result]++;
  }

  logger.info(stats, 'OKX Signal: последние события синхронизированы');
  return stats;
}

async function reconciliationTick(): Promise<void> {
  if (!running) return;

  const now = Date.now();
  if (now - lastReconciliationAt < env.OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS) return;
  lastReconciliationAt = now;

  const [chain] = CHAINS[reconciliationCursor % CHAINS.length]!;
  reconciliationCursor++;

  const signals = await fetchLatestSignals(chain, 100);
  for (const signal of [...signals].reverse()) {
    await ingestOkxSignal(signal, 'okx_rest');
  }
}

export function startOkxSignalIngest(): void {
  if (running) return;
  if (!isOkxConfigured()) {
    logger.warn('OKX Signal не запущен: учётные данные OKX не настроены');
    return;
  }

  running = true;
  client = new OkxWalletWebSocketClient({
    id: 'okx-signal',
    addresses: [],
    platformFeed: false,
    signalChains: CHAIN_INDEXES,
    onEvent: () => undefined,
    onSignal: (signal) => void ingestOkxSignal(signal, 'okx_websocket'),
    onRejected: (reason) => logger.debug({ reason }, 'OKX Signal: сообщение отклонено'),
  });

  // Сначала подписываемся, затем догружаем историю. Обратный порядок
  // оставил бы окно между REST-ответом и готовностью сокета.
  client.start();
  void syncLatestOkxSignals().catch((error) =>
    logger.warn({ code: error?.code }, 'OKX Signal: начальная синхронизация не удалась'),
  );

  /*
   * Даже здоровый сокет не доказывает, что во время предыдущего
   * reconnect не было разрыва. Раз в минуту сверяем одну сеть:
   * полный круг занимает четыре минуты, providerKey убирает повторы.
   * Это достаточно редко для квоты и не оставляет тихих дыр в истории.
   */
  lastReconciliationAt = Date.now();
  reconciliationTimer = setInterval(() => void reconciliationTick(), 5_000);
  reconciliationTimer.unref?.();

  logger.info({ chains: CHAIN_INDEXES.length }, 'OKX Signal: живая лента запущена');
}

export function stopOkxSignalIngest(): void {
  running = false;
  client?.stop();
  client = null;
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
  reconciliationCursor = 0;
  lastReconciliationAt = 0;
}
