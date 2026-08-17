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
 * Здесь остались только две вещи: разговор с провайдером и
 * планировщик. Сам пересчёт живёт в `wallet-ledger-core.ts`, работа
 * с базой — в `wallet-ledger-repo.ts`. Разделение не косметическое:
 * гонки, падения между шагами и перехват просроченной аренды иначе
 * непроверяемы, а именно в них и прячутся потерянные сделки.
 */

import {
  parseHistoryPage,
  dedupeCanonical,
  assessCoverage,
  normalizeAddress,
  OKX_CHAIN_INDEX,
  type CanonicalTrade,
  type ChainKey,
  type HistoryCoverage,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { okxCall, isOkxWalletConfigured, OkxProviderError } from '../services/okx-client.js';
import { unwrapOkx } from '@memex/core';
import { walletLedgerRepo, type SyncJob } from './wallet-ledger-repo.js';
import { rebuildWallet, type HistorySource, type RebuildResult } from './wallet-ledger-core.js';

const HISTORY_PATH = '/api/v6/dex/market/portfolio/dex-history';
const TICK_MS = 5_000;
const PAGE_LIMIT = 100;
/** Больше тысячи записей провайдер всё равно не отдаёт. */
const MAX_PAGES = 10;

/**
 * Срок аренды задачи.
 *
 * Заметно больше самой долгой выгрузки, но конечен: процесс, упавший
 * с захваченной задачей, обязан отпустить её сам по истечении срока,
 * иначе кошелёк перестанет пересчитываться навсегда и молча.
 */
const LEASE_MS = 120_000;

/** Имя владельца аренды. По нему в базе видно, кто держит задачу. */
const OWNER = `${process.pid}@${process.env.RENDER_INSTANCE_ID ?? 'local'}`;

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
 *
 * Каждый вызов поднимает поколение задачи. По нему воркер, вернувшийся
 * из долгой выгрузки, поймёт, что за время его работы появилась новая
 * работа, и не снимет задачу как выполненную.
 */
export async function markDirty(chain: string, wallet: string): Promise<void> {
  if (!env.WALLET_LEDGER_SYNC_ENABLED) return;

  const address = normalizeAddress(chain as ChainKey, wallet);
  const dueAt = new Date(Date.now() + env.WALLET_LEDGER_SYNC_DEBOUNCE_MS);

  await walletLedgerRepo
    .markDirty(chain, address, dueAt)
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
 *
 * Вместе со сделками возвращается оценка полноты. Без неё нельзя
 * отличить «у кошелька всего двадцать сделок» от «мы увидели только
 * последние двадцать», а разница решающая: во втором случае самые
 * ранние покупки остались за окном, и продажи по ним выглядят чистой
 * прибылью.
 */
export async function fetchHistory(
  chain: ChainKey,
  wallet: string,
  opts: { since?: number | null } = {},
): Promise<{ trades: CanonicalTrade[]; coverage: HistoryCoverage }> {
  const chainIndex = OKX_CHAIN_INDEX[chain];

  if (!chainIndex || !isOkxWalletConfigured()) {
    return {
      trades: [],
      coverage: assessCoverage({
        trades: [],
        pagesFetched: 0,
        cursorExhausted: false,
        pageLimitReached: false,
        failed: true,
      }),
    };
  }

  const end = Date.now();
  const begin =
    opts.since != null
      ? Math.max(0, opts.since - env.WALLET_LEDGER_OVERLAP_MS)
      : end - env.WALLET_LEDGER_BACKFILL_DAYS * 864e5;

  const all: CanonicalTrade[] = [];
  const seenCursors = new Set<string>();

  let cursor: string | null = null;
  let pages = 0;
  let cursorExhausted = false;
  let cursorRepeated = false;
  let failed = false;

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
      // Обрыв на первой странице — это неудача целиком: отдавать
      // пустую историю как полную нельзя, по ней позиции обнулятся.
      failed = true;
      if (e instanceof OkxProviderError && !e.retryable) throw e;
      break;
    }

    pages++;

    const data = unwrapOkx<unknown>(raw, HISTORY_PATH);
    const parsed = parseHistoryPage(data, { chain, wallet });

    all.push(...parsed.trades);

    if (!parsed.cursor || parsed.trades.length === 0) {
      // Курсор кончился — история дочитана до конца окна.
      cursorExhausted = true;
      break;
    }

    // Повтор курсора означает, что провайдер зациклился. Продолжать
    // значило бы бесконечно перекладывать одну и ту же страницу
    // и считать её выгрузку полной.
    if (seenCursors.has(parsed.cursor)) {
      cursorRepeated = true;
      break;
    }

    seenCursors.add(parsed.cursor);
    cursor = parsed.cursor;
  }

  const trades = dedupeCanonical(all);

  return {
    trades,
    coverage: assessCoverage({
      trades,
      pagesFetched: pages,
      cursorExhausted,
      pageLimitReached: pages >= MAX_PAGES && !cursorExhausted,
      cursorRepeated,
      failed,
      requestedBegin: begin,
    }),
  };
}

/** Провайдер истории для чистой части пересчёта. */
const historySource: HistorySource = {
  fetch: (chain, wallet, opts) => fetchHistory(chain, wallet, { since: opts.since }),
};

// ──────────────────────── Пересчёт позиций ──────────────────────────────────

export type SyncResult = RebuildResult;

/**
 * Пересчёт одного кошелька.
 *
 * Обёртка над чистой частью: нормализует адрес и подставляет базу
 * с провайдером. Вся логика — в `rebuildWallet`, потому что проверять
 * надо именно её.
 */
export async function syncWallet(chain: ChainKey, wallet: string): Promise<SyncResult> {
  return rebuildWallet(chain, normalizeAddress(chain, wallet), {
    repo: walletLedgerRepo,
    history: historySource,
  });
}

// ─────────────────────────────── Планировщик ────────────────────────────────

/**
 * Один проход.
 *
 * Задачи забираются по одной условным обновлением, а не выборкой
 * с последующим обновлением: два экземпляра API увидели бы одну
 * строку и оба сочли бы, что захватили её, а затем записали бы
 * разные промежуточные состояния одной позиции.
 */
async function tick(): Promise<void> {
  if (running || !env.WALLET_LEDGER_SYNC_ENABLED || !isOkxWalletConfigured()) return;
  running = true;

  try {
    for (let i = 0; i < env.WALLET_LEDGER_SYNC_CONCURRENCY; i++) {
      const job = await walletLedgerRepo.claimNext(new Date(), LEASE_MS, OWNER);
      if (!job) break;

      await runJob(job);
    }
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'пересчёт позиций: сбой прохода');
  } finally {
    running = false;
  }
}

async function runJob(job: SyncJob): Promise<void> {
  // Аренда продлевается по ходу выгрузки: у кошелька с длинной
  // историей десять страниц занимают больше срока аренды, и без
  // продления задачу перехватил бы соседний процесс прямо во время
  // работы.
  const heartbeat = setInterval(() => {
    void walletLedgerRepo
      .extendLease(job, new Date(Date.now() + LEASE_MS))
      .catch(() => undefined);
  }, Math.floor(LEASE_MS / 3));
  heartbeat.unref?.();

  try {
    const r = await syncWallet(job.chain as ChainKey, job.walletAddress);
    const outcome = await walletLedgerRepo.finish(job, { ok: true });

    if (r.totalTrades > 0) {
      logger.debug(
        {
          chain: r.chain,
          trades: r.totalTrades,
          closed: r.scorableClosed,
          coverage: r.coveragePercent,
          history: r.historyStatus,
          outcome,
        },
        'позиции кошелька пересчитаны',
      );
    }
  } catch (e: any) {
    const attempts = job.attempts + 1;
    const giveUp = attempts >= env.WALLET_LEDGER_SYNC_MAX_ATTEMPTS;

    const delay = Math.min(
      env.WALLET_LEDGER_SYNC_RETRY_BASE_MS * 2 ** attempts,
      env.WALLET_LEDGER_SYNC_RETRY_MAX_MS,
    );

    await walletLedgerRepo
      .finish(job, {
        ok: false,
        // Только код: объект ошибки провайдера содержит заголовки
        // запроса, а в них — подпись и ключ.
        errorCode: e?.code ?? e?.name ?? 'unknown',
        // Исчерпав быстрые повторы, откладываем надолго: задача
        // остаётся для периодической сверки, а не теряется.
        retryAt: new Date(Date.now() + (giveUp ? 3_600_000 : delay)),
      })
      .catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
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

/**
 * Состояние переноса для статуса источника.
 *
 * Нужно, чтобы отличить спокойный рынок от замершего воркера: снаружи
 * они выглядят одинаково — лента не пополняется, — а означают разное.
 */
export async function ledgerStatus() {
  const now = new Date();

  const [pending, deferred, failed, queued, leased, stale, oldest, last] = await Promise.all([
    prisma.walletActivity.count({ where: { ledgerState: 'pending' } }),
    prisma.walletActivity.count({ where: { ledgerState: 'deferred' } }),
    prisma.walletActivity.count({ where: { ledgerState: 'failed' } }),
    prisma.walletSyncQueue.count({
      where: {
        dueAt: { lte: now },
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
    }),
    prisma.walletSyncQueue.count({ where: { lockedUntil: { gte: now } } }),
    // Аренда истекла, а задача не завершена: процесс упал посреди
    // работы. Задача не потеряна — её перехватят, — но знать об этом
    // нужно, потому что частые перехваты означают падения.
    prisma.walletSyncQueue.count({
      where: { lockedBy: { not: null }, lockedUntil: { lt: now } },
    }),
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

  const status = !env.WALLET_LEDGER_SYNC_ENABLED
    ? 'degraded'
    : failed > 0
      ? 'error'
      : queued > 0 || leased > 0
        ? 'syncing'
        : 'healthy';

  return {
    status,
    pendingActivities: pending,
    deferredActivities: deferred,
    failedActivities: failed,
    queuedJobs: queued,
    runningJobs: leased,
    staleLeases: stale,
    lastSyncAt: last?.lastSyncAt?.toISOString() ?? null,
    lastSuccessfulSyncAt: last?.lastSuccessAt?.toISOString() ?? null,
    // Только код: объект ошибки провайдера содержит заголовки запроса.
    lastErrorCode: last?.lastErrorCode ?? null,
    oldestPendingAt: oldest?.tradedAt.toISOString() ?? null,
  };
}
