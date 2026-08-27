/**
 * Живая лента OKX Signal → история сигналов и каталог токенов.
 *
 * Основной путь — официальный WebSocket. REST вызывается один раз при
 * старте для заполнения последних событий и затем только при нездоровом
 * сокете, по одной сети за проход. Это даёт минимальную задержку без
 * превращения открытой вкладки в потребителя платной квоты OKX.
 */

import { Prisma as P } from '@prisma/client';
import {
  OKX_CHAIN_INDEX,
  isLivePaperSignalOrigin,
  type ChainKey,
  type OkxSignal,
  type PaperSignalOrigin,
} from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { isOkxConfigured, fetchLatestSignals } from '../services/okx-market.js';
import { OkxWalletWebSocketClient } from '../services/okx-ws-client.js';
import { markHot } from './hot-tokens.js';
import { requestCandlesSoon } from './candle-builder.js';
import { queuePaperAgentSignal } from './paper-agent.js';

export type SignalIngestResult = 'created' | 'duplicate' | 'failed';

const CHAINS = (Object.entries(OKX_CHAIN_INDEX) as Array<[ChainKey, string | null]>)
  .filter((entry): entry is [ChainKey, string] => entry[1] != null);

const CHAIN_INDEXES = CHAINS.map(([, index]) => index);

let running = false;
let client: OkxWalletWebSocketClient | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let reconciliationCursor = 0;
let lastReconciliationAt = 0;
let lastRestSuccessAt = 0;
let lastRestErrorCode: string | null = null;
let lastSignalAt: number | null = null;
let transportMode: 'WEBSOCKET' | 'REST_ONLY' | 'DISABLED' = 'WEBSOCKET';
let permanentDenialCode: string | null = null;

const ORIGIN_PRIORITY: Record<PaperSignalOrigin, number> = {
  REST_BACKFILL: 0,
  REST_RECONCILIATION: 1,
  WEBSOCKET_LIVE: 2,
};

function sourceOf(origin: PaperSignalOrigin): string {
  return origin === 'WEBSOCKET_LIVE' ? 'okx_websocket' : 'okx_rest';
}

function paperAgentIngestCode(chain: string, origin: PaperSignalOrigin): string {
  if (chain !== 'SOLANA') return 'FILTERED_UNSUPPORTED_NETWORK';
  if (origin === 'REST_BACKFILL') return 'BACKFILL_DIAGNOSTIC_ONLY';
  return 'QUEUED_LIVE';
}

function shouldUpgradeOrigin(previous: string | null, incoming: PaperSignalOrigin): boolean {
  if (previous == null) return true;
  const previousRank = ORIGIN_PRIORITY[previous as PaperSignalOrigin];
  return previousRank == null || ORIGIN_PRIORITY[incoming] > previousRank;
}

type ExistingSignal = {
  id: string;
  tokenId: string | null;
  ingestOrigin: string | null;
  chain: string;
};

async function reconcileExistingSignal(
  existing: ExistingSignal,
  origin: PaperSignalOrigin,
): Promise<SignalIngestResult> {
  if (existing.tokenId) {
    markHot(existing.tokenId);
    // После рестарта REST-сверка встречает уже сохранённое событие. Его
    // всё равно нужно поставить на исторический backfill: иначе ATH до
    // момента нового деплоя потеряется.
    requestCandlesSoon(existing.tokenId, '5m');
  }

  const upgraded = shouldUpgradeOrigin(existing.ingestOrigin, origin);
  if (upgraded) {
    await prisma.okxSignal.update({
      where: { id: existing.id },
      data: {
        ingestOrigin: origin,
        paperAgentIngestCode: paperAgentIngestCode(existing.chain, origin),
      },
    });
  }
  if (upgraded && existing.chain === 'SOLANA' && isLivePaperSignalOrigin(origin)) {
    queuePaperAgentSignal(existing.id, true);
  }
  return 'duplicate';
}

function decimal(value: number | null): P.Decimal | null {
  return value != null && Number.isFinite(value) && value >= 0 ? new P.Decimal(value) : null;
}

export function isRestReconciliationDue(
  nowMs: number,
  previousMs: number,
  intervalMs: number,
): boolean {
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(previousMs) &&
    Number.isFinite(intervalMs) &&
    intervalMs > 0 &&
    nowMs - previousMs >= intervalMs
  );
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
  origin: PaperSignalOrigin,
): Promise<SignalIngestResult> {
  lastSignalAt = Date.now();
  try {
    const already = await prisma.okxSignal.findUnique({
      where: { providerKey: signal.providerKey },
      select: { id: true, tokenId: true, ingestOrigin: true, chain: true },
    });

    if (already) return reconcileExistingSignal(already, origin);

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

      const savedSignal = await tx.okxSignal.create({
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
          peakPriceUsd: decimal(signal.priceUsd),
          peakObservedAt: signal.priceUsd != null ? signal.signaledAt : null,
          holders: signal.holders,
          top10HolderPct: decimal(signal.top10HolderPct),
          walletTypes: signal.walletTypes,
          triggerWalletAddresses: signal.triggerWalletAddresses,
          triggerWalletCount: signal.triggerWalletCount,
          amountUsd: decimal(signal.amountUsd),
          soldRatioPct: decimal(signal.soldRatioPct),
          source: sourceOf(origin),
          ingestOrigin: origin,
          paperAgentIngestCode: paperAgentIngestCode(signal.chain, origin),
        },
        select: { id: true },
      });

      return { tokenId: token.id, signalId: savedSignal.id };
    });

    // Новая находка первой получает цену, свечи и место в очереди
    // проверки. Сам GEMS при этом уже доступен из записи выше.
    markHot(result.tokenId);
    requestCandlesSoon(result.tokenId, '5m');
    if (signal.chain === 'SOLANA' && isLivePaperSignalOrigin(origin)) {
      queuePaperAgentSignal(result.signalId);
    }
    return 'created';
  } catch (error: any) {
    // WebSocket и REST пересекаются штатно. Уникальный providerKey
    // делает повтор безвредным даже при гонке между ними.
    if (error?.code === 'P2002') {
      // В настоящей гонке WS/REST проигравшая транзакция обязана
      // перечитать победителя. Иначе REST_BACKFILL мог бы остаться
      // диагностическим навсегда, хотя live-событие уже пришло.
      const winner = await prisma.okxSignal.findUnique({
        where: { providerKey: signal.providerKey },
        select: { id: true, tokenId: true, ingestOrigin: true, chain: true },
      });
      if (winner) return reconcileExistingSignal(winner, origin);
    }

    logger.warn(
      { chain: signal.chain, address: signal.address, code: error?.code },
      'OKX Signal: событие не сохранено',
    );
    return 'failed';
  }
}

export function getOkxSignalIngestStatus() {
  const interval = env.OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS;
  return {
    running,
    transportMode,
    permanentDenialCode,
    accessMessage:
      transportMode === 'REST_ONLY'
        ? 'WebSocket недоступен: требуется whitelist OKX'
        : null,
    lastSignalAt: lastSignalAt == null ? null : new Date(lastSignalAt).toISOString(),
    lastReconciliationAt:
      lastReconciliationAt === 0 ? null : new Date(lastReconciliationAt).toISOString(),
    lastRestSuccessAt:
      lastRestSuccessAt === 0 ? null : new Date(lastRestSuccessAt).toISOString(),
    lastRestErrorCode,
    nextRestReconciliationAt:
      !running || lastReconciliationAt === 0
        ? null
        : new Date(lastReconciliationAt + interval).toISOString(),
    socket: client?.stats() ?? null,
  };
}

/** Последние сто событий каждой сети — начальное заполнение после деплоя. */
export async function syncLatestOkxSignals(
  chains: ChainKey[] = CHAINS.map(([chain]) => chain),
  origin: PaperSignalOrigin = 'REST_BACKFILL',
) {
  const lists = await Promise.all(chains.map((chain) => fetchLatestSignals(chain, 100)));
  // Старые первыми: если один токен встречается несколько раз, в Token
  // останется цена самого свежего сигнала, а не случайного Promise.
  const signals = lists.flat().sort((a, b) => a.signaledAt.getTime() - b.signaledAt.getTime());

  const stats = { fetched: signals.length, created: 0, duplicate: 0, failed: 0 };
  for (const signal of signals) {
    const result = await ingestOkxSignal(signal, origin);
    stats[result]++;
  }

  lastRestSuccessAt = Date.now();
  lastRestErrorCode = null;
  logger.info({ ...stats, origin }, 'OKX Signal: последние события синхронизированы');
  return stats;
}

async function reconciliationTick(): Promise<void> {
  if (!running) return;

  const now = Date.now();
  if (!isRestReconciliationDue(
    now,
    lastReconciliationAt,
    env.OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS,
  )) return;
  lastReconciliationAt = now;

  const [chain] = CHAINS[reconciliationCursor % CHAINS.length]!;
  reconciliationCursor++;

  try {
    const signals = await fetchLatestSignals(chain, 100);
    for (const signal of [...signals].reverse()) {
      await ingestOkxSignal(signal, 'REST_RECONCILIATION');
    }
    lastRestSuccessAt = Date.now();
    lastRestErrorCode = null;
  } catch (error: any) {
    lastRestErrorCode = String(error?.code ?? error?.name ?? 'REST_RECONCILIATION_FAILED');
    logger.warn(
      { chain, code: lastRestErrorCode },
      'OKX Signal: REST reconciliation не выполнена',
    );
  }
}

export function startOkxSignalIngest(): void {
  if (running) return;
  if (!isOkxConfigured()) {
    transportMode = 'DISABLED';
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
    onSignal: (signal) => void ingestOkxSignal(signal, 'WEBSOCKET_LIVE'),
    onSignalTransportChange: (mode, code) => {
      transportMode = mode;
      permanentDenialCode = code;
    },
    onRejected: (reason) => logger.debug({ reason }, 'OKX Signal: сообщение отклонено'),
  });

  // Сначала подписываемся, затем догружаем историю. Обратный порядок
  // оставил бы окно между REST-ответом и готовностью сокета.
  client.start();
  void syncLatestOkxSignals().catch((error) => {
    lastRestErrorCode = String(error?.code ?? error?.name ?? 'REST_BACKFILL_FAILED');
    logger.warn({ code: error?.code }, 'OKX Signal: начальная синхронизация не удалась');
  });

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
  lastRestSuccessAt = 0;
  lastRestErrorCode = null;
  lastSignalAt = null;
  transportMode = 'WEBSOCKET';
  permanentDenialCode = null;
}
