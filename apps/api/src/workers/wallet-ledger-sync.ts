/**
 * Перенос сделок кошелька в позиции.
 *
 * Отдельный воркер, а не часть приёма событий, по двум причинам.
 *
 * Первая — скорость. Событие из сокета должно оказаться в ленте
 * за секунды; запрос истории DEX занимает сотни миллисекунд и может
 * потребовать нескольких страниц. Связать их значило бы задержать
 * ленту ради расчёта, который никто в этот момент не смотрит.
 *
 * Вторая и главная — точность. Лента отслеживания не сообщает,
 * сколько токена куплено: там есть цена и количество котировочного
 * токена, но не количество приобретённого. Вычислять его делением
 * нельзя — это разные валюты, и подстановка испортила бы среднюю
 * себестоимость, а за ней размер позиции, зафиксированный результат
 * и оценку. Точные числа даёт только история DEX, и берутся они
 * оттуда.
 *
 * Пересчёт детерминированный: позиция не изменяется приращением,
 * а собирается заново из всех известных сделок. События приходят
 * повторно, не по порядку, после переподключения и задним числом
 * из дозагрузки — приращение при любом из этих случаев дало бы
 * неверный остаток, и заметить это было бы нечем.
 */

import { Prisma as P } from '@prisma/client';
import {
  parseHistoryPage,
  sortForLedger,
  dedupeCanonical,
  buildPositions,
  summarizePnl,
  normalizeAddress,
  OKX_CHAIN_INDEX,
  type CanonicalTrade,
  type ChainKey,
  type EconomicTrade,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { okxCall, isOkxWalletConfigured, OkxProviderError } from '../services/okx-client.js';
import { unwrapOkx } from '@memex/core';

const HISTORY_PATH = '/api/v6/dex/market/portfolio/dex-history';
const TICK_MS = 5_000;
const PAGE_LIMIT = 100;
/** Больше тысячи записей провайдер всё равно не отдаёт. */
const MAX_PAGES = 10;

let timer: NodeJS.Timeout | null = null;
let running = false;

// ──────────────────────────── Очередь ───────────────────────────────────────

/**
 * Пометить кошелёк как требующий пересчёта.
 *
 * Объединение здесь и есть весь смысл очереди: десять событий одного
 * кошелька за двадцать секунд дают один запрос к истории, а не десять.
 * Срок сдвигается вперёд при каждом новом событии — пересчитываем
 * после того, как поток утих, а не посреди него.
 */
export async function markDirty(chain: string, wallet: string): Promise<void> {
  if (!env.WALLET_LEDGER_SYNC_ENABLED) return;

  const address = normalizeAddress(chain as ChainKey, wallet);
  const id = `${chain}:${address}`;
  const dueAt = new Date(Date.now() + env.WALLET_LEDGER_SYNC_DEBOUNCE_MS);

  await prisma.walletSyncQueue
    .upsert({
      where: { id },
      create: { id, chain: chain as never, walletAddress: address, dueAt },
      update: { dueAt },
    })
    .catch((e: any) => logger.debug({ err: e?.message }, 'очередь пересчёта: не поставлено'));
}

// ──────────────────────── Загрузка истории ──────────────────────────────────

/**
 * История сделок кошелька за период.
 *
 * Границы обязательны, поэтому считаются здесь. Перекрытие нужно
 * потому, что история обновляется позже сокета: запрос строго
 * от последней известной сделки пропустил бы всё, что провайдер
 * ещё не успел показать.
 */
export async function fetchHistory(
  chain: ChainKey,
  wallet: string,
  opts: { since?: number } = {},
): Promise<CanonicalTrade[]> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex || !isOkxWalletConfigured()) return [];

  const end = Date.now();
  const begin =
    opts.since != null
      ? Math.max(0, opts.since - env.WALLET_LEDGER_OVERLAP_MS)
      : end - env.WALLET_LEDGER_BACKFILL_DAYS * 864e5;

  const all: CanonicalTrade[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      chainIndex,
      walletAddress: wallet,
      begin: String(begin),
      end: String(end),
      limit: String(PAGE_LIMIT),
    });
    if (cursor) params.set('cursor', cursor);

    let raw: unknown;
    try {
      raw = await okxCall(`${HISTORY_PATH}?${params.toString()}`, { label: 'dex-history' });
    } catch (e) {
      if (e instanceof OkxProviderError && !e.retryable) throw e;
      // Временный отказ — прекращаем добор страниц, но отдаём то,
      // что уже собрали: неполная история лучше пустой.
      break;
    }

    const data = unwrapOkx<unknown>(raw, HISTORY_PATH);
    const parsed = parseHistoryPage(data, { chain, wallet });

    all.push(...parsed.trades);

    if (!parsed.cursor || parsed.trades.length === 0) break;
    cursor = parsed.cursor;
  }

  return dedupeCanonical(all);
}

// ──────────────────────── Пересчёт позиций ──────────────────────────────────

export interface SyncResult {
  wallet: string;
  chain: string;
  trades: number;
  closedPositions: number;
  applied: number;
  deferred: number;
}

/**
 * Пересчёт одного кошелька.
 *
 * Позиции собираются заново из всех известных канонических сделок,
 * а не изменяются приращением. Один и тот же набор сделок обязан
 * давать один результат независимо от того, в каком порядке они
 * пришли — иначе средняя себестоимость зависела бы от очерёдности
 * страниц истории.
 */
export async function syncWallet(chain: ChainKey, wallet: string): Promise<SyncResult | null> {
  const address = normalizeAddress(chain, wallet);

  // Дозагружаем от последней известной сделки с перекрытием.
  const last = await prisma.walletEconomicTrade.findFirst({
    where: { chain: chain as never, walletAddress: address },
    orderBy: { tradedAt: 'desc' },
    select: { tradedAt: true },
  });

  const fresh = await fetchHistory(chain, address, {
    since: last?.tradedAt.getTime(),
  });

  // Канонические сделки записываются идемпотентно: ключ собран
  // из содержания сделки, поэтому повторная строка истории
  // не создаёт второй записи.
  for (const t of fresh) {
    await prisma.walletEconomicTrade
      .upsert({
        where: { key: t.key },
        create: {
          key: t.key,
          chain: t.chain as never,
          walletAddress: t.wallet,
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          side: t.side,
          amount: new P.Decimal(t.amount),
          valueUsd: new P.Decimal(t.valueUsd),
          price: new P.Decimal(t.price),
          marketCapUsd: t.marketCapUsd ? new P.Decimal(t.marketCapUsd) : null,
          providerPnlUsd: t.providerPnlUsd ? new P.Decimal(t.providerPnlUsd) : null,
          tradedAt: new Date(t.tradedAt),
        },
        update: {},
      })
      .catch(() => undefined);
  }

  // Пересчёт идёт по всем сделкам кошелька, а не по свежим:
  // поздняя историческая покупка меняет среднюю себестоимость
  // всех последующих продаж.
  const rows = await prisma.walletEconomicTrade.findMany({
    where: { chain: chain as never, walletAddress: address },
    orderBy: [{ tradedAt: 'asc' }, { key: 'asc' }],
  });

  const canonical: CanonicalTrade[] = rows.map((r: (typeof rows)[number]) => ({
    key: r.key,
    chain: r.chain as ChainKey,
    wallet: r.walletAddress,
    tokenAddress: r.tokenAddress,
    tokenSymbol: r.tokenSymbol,
    side: r.side as 'BUY' | 'SELL',
    amount: r.amount.toString(),
    valueUsd: r.valueUsd.toString(),
    price: r.price.toString(),
    marketCapUsd: r.marketCapUsd?.toString() ?? null,
    providerPnlUsd: r.providerPnlUsd?.toString() ?? null,
    tradedAt: r.tradedAt.getTime(),
  }));

  const ordered = sortForLedger(canonical);

  // Существующее ядро принимает экономические сделки — переводим
  // канонические в его формат, не меняя самого ядра.
  const economic: EconomicTrade[] = ordered.map((t) => ({
    chain: t.chain,
    wallet: t.wallet,
    tokenAddress: t.tokenAddress,
    side: t.side,
    tokenAmount: Number(t.amount),
    amountUsd: Number(t.valueUsd),
    priceUsd: Number(t.price),
    timestamp: t.tradedAt,
    txHash: t.key,
    legs: 1,
    parsingConfidence: 1,
    source: 'okx_dex_history',
  }));

  const positions = buildPositions(economic);
  const pnl = summarizePnl(positions);

  // Отметка о переносе ставится только теперь: до этого момента
  // точного количества не существовало, и «учтено» было бы неправдой.
  const applied = await markApplied(chain, address, ordered);

  return {
    wallet: address,
    chain,
    trades: ordered.length,
    closedPositions: pnl.closedCount,
    applied,
    deferred: 0,
  };
}

/**
 * Сопоставление событий ленты с каноническими сделками.
 *
 * Совпадение ищется по кошельку, токену, направлению и времени
 * с допуском: у ленты и истории отметки времени расходятся на
 * секунды, потому что одна берёт момент попадания в блок, другая —
 * момент подтверждения.
 *
 * Несопоставленное событие остаётся несопоставленным. Придумывать
 * ему сделку нельзя: оценка кошелька не должна зависеть от того,
 * что мы что-то предположили.
 */
const MATCH_WINDOW_MS = 120_000;

async function markApplied(
  chain: ChainKey,
  wallet: string,
  trades: CanonicalTrade[],
): Promise<number> {
  if (trades.length === 0) return 0;

  const pending = await prisma.walletActivity.findMany({
    where: {
      chain: chain as never,
      walletAddress: wallet,
      appliedToLedger: false,
    },
    take: 500,
  });

  let applied = 0;

  for (const a of pending) {
    const at = a.tradedAt.getTime();

    const match = trades.find(
      (t) =>
        t.tokenAddress === a.tokenAddress &&
        t.side === a.side &&
        Math.abs(t.tradedAt - at) <= MATCH_WINDOW_MS,
    );

    if (!match) {
      // История обновляется позже сокета. Это не ошибка и не повод
      // ни удалять событие из ленты, ни выдумывать ему количество —
      // просто отложенное состояние.
      await prisma.walletActivity
        .update({
          where: { id: a.id },
          data: {
            ledgerState: 'deferred',
            ledgerAttempts: { increment: 1 },
          },
        })
        .catch(() => undefined);
      continue;
    }

    await prisma.walletActivity
      .update({
        where: { id: a.id },
        data: {
          appliedToLedger: true,
          ledgerState: 'applied',
          ledgerAppliedAt: new Date(),
          ledgerErrorCode: null,
        },
      })
      .catch(() => undefined);

    applied++;
  }

  return applied;
}

// ─────────────────────────────── Планировщик ────────────────────────────────

async function tick(): Promise<void> {
  if (running || !env.WALLET_LEDGER_SYNC_ENABLED || !isOkxWalletConfigured()) return;
  running = true;

  try {
    const due = await prisma.walletSyncQueue.findMany({
      where: { dueAt: { lte: new Date() }, isRunning: false },
      orderBy: { dueAt: 'asc' },
      take: env.WALLET_LEDGER_SYNC_CONCURRENCY,
    });

    for (const item of due) {
      // Захват через флаг в базе: два экземпляра API не должны
      // пересчитывать один кошелёк одновременно — они получили бы
      // разные промежуточные состояния одной позиции.
      const claimed = await prisma.walletSyncQueue
        .updateMany({
          where: { id: item.id, isRunning: false },
          data: { isRunning: true, lastSyncAt: new Date() },
        })
        .catch(() => ({ count: 0 }));

      if (claimed.count === 0) continue;

      try {
        const r = await syncWallet(item.chain as ChainKey, item.walletAddress);

        await prisma.walletSyncQueue.update({
          where: { id: item.id },
          data: {
            isRunning: false,
            lastSuccessAt: new Date(),
            attempts: 0,
            lastErrorCode: null,
            // Следующий пересчёт — только по новому событию.
            dueAt: new Date(Date.now() + 864e5),
          },
        });

        if (r && r.trades > 0) {
          logger.debug(
            { chain: r.chain, trades: r.trades, closed: r.closedPositions },
            'позиции кошелька пересчитаны',
          );
        }
      } catch (e: any) {
        const attempts = item.attempts + 1;
        const giveUp = attempts >= env.WALLET_LEDGER_SYNC_MAX_ATTEMPTS;

        const delay = Math.min(
          env.WALLET_LEDGER_SYNC_RETRY_BASE_MS * 2 ** attempts,
          env.WALLET_LEDGER_SYNC_RETRY_MAX_MS,
        );

        await prisma.walletSyncQueue
          .update({
            where: { id: item.id },
            data: {
              isRunning: false,
              attempts,
              lastErrorCode: e?.name ?? 'unknown',
              // Исчерпав быстрые повторы, откладываем надолго:
              // задача остаётся для периодической сверки, а не
              // теряется.
              dueAt: new Date(Date.now() + (giveUp ? 3_600_000 : delay)),
            },
          })
          .catch(() => undefined);
      }
    }
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'пересчёт позиций: сбой прохода');
  } finally {
    running = false;
  }
}

export function startLedgerSync(): void {
  if (timer) return;
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  logger.info('пересчёт позиций кошельков запущен');
}

export function stopLedgerSync(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Состояние переноса для статуса источника. */
export async function ledgerStatus() {
  const [pending, deferred, failed, dirty, oldest, queue] = await Promise.all([
    prisma.walletActivity.count({ where: { ledgerState: 'pending' } }),
    prisma.walletActivity.count({ where: { ledgerState: 'deferred' } }),
    prisma.walletActivity.count({ where: { ledgerState: 'failed' } }),
    prisma.walletSyncQueue.count({ where: { dueAt: { lte: new Date() } } }),
    prisma.walletActivity.findFirst({
      where: { appliedToLedger: false },
      orderBy: { tradedAt: 'asc' },
      select: { tradedAt: true },
    }),
    prisma.walletSyncQueue.findFirst({
      orderBy: { lastSuccessAt: 'desc' },
      select: { lastSyncAt: true, lastSuccessAt: true, lastErrorCode: true },
    }),
  ]);

  const status =
    !env.WALLET_LEDGER_SYNC_ENABLED
      ? 'degraded'
      : failed > 0
        ? 'error'
        : dirty > 0
          ? 'syncing'
          : 'healthy';

  return {
    status,
    pendingActivities: pending,
    deferredActivities: deferred,
    failedActivities: failed,
    dirtyWalletChains: dirty,
    lastSyncAt: queue?.lastSyncAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: queue?.lastSuccessAt?.toISOString() ?? null,
    // Только код: объект ошибки провайдера содержит заголовки запроса.
    lastErrorCode: queue?.lastErrorCode ?? null,
    oldestPendingAt: oldest?.tradedAt.toISOString() ?? null,
  };
}
