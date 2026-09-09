/**
 * Живая лента OKX Signal → история сигналов и каталог токенов.
 *
 * Основной путь — официальный WebSocket. REST сверяет сети по общему
 * расписанию: при здоровом WS медленно, при отказе — в пределах явно
 * выделенного бюджета. Вкладки не запускают опрос и не расходуют квоту.
 */

import { randomUUID } from 'node:crypto';
import { Prisma as P } from '@prisma/client';
import {
  OKX_CHAIN_INDEX,
  isLivePaperSignalOrigin,
  normalizeAgentNetwork,
  type ChainKey,
  type OkxSignal,
  type PaperSignalOrigin,
} from '@memex/core';
import { SignalRestSchedule, signalRestPlan, claimSharedSignalPoll, finishSharedSignalPoll } from '../services/signal-rest-schedule.js';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import {
  isOkxConfigured,
  fetchLatestSignalsOutcome,
  fetchSignalSupportedChains,
  fetchMarketSupportedChains,
  type SignalFetchOutcome,
  getOkxSignalChainIndexes,
  getOkxChainConfirmation,
  setOkxSignalChainIndexes,
  setOkxMarketChainIndexes,
} from '../services/okx-market.js';
import { isAgentNetworkReady } from '../services/agent-networks.js';
import { refreshEvmProbes } from '../services/evm-chain-probe.js';
import { OkxWalletWebSocketClient } from '../services/okx-ws-client.js';
import { markHot } from './hot-tokens.js';
import { requestCandlesSoon } from './candle-builder.js';
import { queuePaperAgentSignal, setPaperSignalSourceProbe } from './paper-agent.js';
import { type SignalSourceFacts } from '@memex/core';

export type SignalIngestResult = 'created' | 'duplicate' | 'failed';

const CHAINS = (Object.entries(OKX_CHAIN_INDEX) as Array<[ChainKey, string | null]>)
  .filter((entry): entry is [ChainKey, string] => entry[1] != null);

/**
 * Сети, по которым действительно идёт приём: пересечение наших таблиц
 * с живым списком OKX. Пока список не получен — только документированные
 * сети Signal API; Robinhood Chain добавляется лишь после подтверждения.
 */
const DOCUMENTED_SIGNAL_CHAINS: ReadonlySet<ChainKey> = new Set<ChainKey>(['ETHEREUM', 'BNB', 'SOLANA', 'BASE']);

export function activeSignalChains(): Array<[ChainKey, string]> {
  const confirmed = getOkxSignalChainIndexes();
  return CHAINS.filter(([chain, index]) => (confirmed ? confirmed.includes(index) : DOCUMENTED_SIGNAL_CHAINS.has(chain)));
}

/** Как часто перечитывать список сетей, когда он уже получен. */
const SUPPORTED_CHAINS_REFRESH_MS = 60 * 60_000;
/** Как часто пробовать, пока списка ещё нет. */
const SUPPORTED_CHAINS_RETRY_MS = 60_000;
const chainChecks = {
  signal: { attemptedAt: null as number | null, inFlight: false, failed: false },
  market: { attemptedAt: null as number | null, inFlight: false, failed: false },
};

let running = false;
let startedAt: number | null = null;
let client: OkxWalletWebSocketClient | null = null;
let reconciliationTimer: NodeJS.Timeout | null = null;
let restSchedule = new SignalRestSchedule();
let reconciling = false;
let refreshingProbes = false;
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

/**
 * Пойдёт ли сигнал агенту — и если нет, почему.
 *
 * Сеть не агента — фильтр. Сеть агента, но не готовая (OKX не
 * подтвердил сигналы по ней, нет цены, узел не настроен) — отдельный
 * код: это не «чужая сеть», а «своя, но пока без инфраструктуры», и
 * в истории они должны различаться.
 */
function paperAgentIngestCode(chain: string, origin: PaperSignalOrigin): string {
  if (normalizeAgentNetwork(chain) == null) return 'FILTERED_UNSUPPORTED_NETWORK';
  if (!isAgentNetworkReady(chain)) return 'NETWORK_NOT_READY';
  if (origin === 'REST_BACKFILL') return 'BACKFILL_DIAGNOSTIC_ONLY';
  return 'QUEUED_LIVE';
}

function goesToPaperAgent(chain: string, origin: PaperSignalOrigin): boolean {
  return isAgentNetworkReady(chain) && isLivePaperSignalOrigin(origin);
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
  if (upgraded && goesToPaperAgent(existing.chain, origin)) {
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
    if (goesToPaperAgent(signal.chain, origin)) {
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

/**
 * Факты о транспортах источника для решения «входить или ждать».
 *
 * Только факты, без вердикта: правило живёт в ядре
 * (`signalSourceVerdict`), чтобы его можно было проверить таблицей,
 * а воркер агента и интерфейс не могли разойтись в толковании.
 */
function restPlan() {
  return signalRestPlan({
    plan: env.OKX_PLAN,
    monthlyBudget: env.OKX_SIGNAL_REST_MONTHLY_BUDGET,
    requestsPerSecond: env.OKX_SIGNAL_REST_REQUESTS_PER_SECOND,
    consumers: env.OKX_SIGNAL_REST_CONSUMERS,
    legacyIntervalMs: env.OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS,
  }, activeSignalChains().length);
}
function pollInterval() {
  return client?.isHealthy() ? Math.max(env.OKX_SIGNAL_REST_FALLBACK_INTERVAL_MS, restPlan().intervalMs) : restPlan().intervalMs;
}
export function getOkxSignalSourceFacts(now = Date.now()): SignalSourceFacts {
  const stats = client?.stats() ?? null;
  return {
    configured: isOkxConfigured(),
    transportMode,
    socketHealthy: client?.isHealthy() ?? false,
    channelDeniedCode: stats?.channelAccessDeniedCode ?? permanentDenialCode,
    lastRestSuccessAtMs: lastRestSuccessAt === 0 ? null : lastRestSuccessAt,
    lastRestErrorCode,
    restIntervalMs: pollInterval(),
    startedAtMs: running ? startedAt : null,
    nowMs: now,
  };
}

export function getOkxSignalIngestStatus() {
  const interval = pollInterval();
  return {
    running,
    restDelivery: {
      ...restPlan(),
      ...(client?.isHealthy() ? {
        status: 'WS_PRIMARY',
        message: 'REST выполняет фоновую сверку. Основная доставка — WS; её подтверждают подписка и настоящее событие.',
      } : {}),
      intervalMs: interval,
      roundMs: interval * activeSignalChains().length,
      blockedUntil: restSchedule.blockedUntil > Date.now() ? new Date(restSchedule.blockedUntil).toISOString() : null,
    },
    transportMode,
    permanentDenialCode,
    accessMessage:
      transportMode === 'REST_ONLY'
        ? permanentDenialCode === '60036'
          ? 'Ключу недоступен WebSocket по Market API subscription (60036)'
          : 'WebSocket недоступен: требуется whitelist OKX'
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
        : new Date(Math.max(restSchedule.nextAt, restSchedule.blockedUntil)).toISOString(),
    socket: client?.stats() ?? null,
  };
}

/** Последние сто событий каждой сети — начальное заполнение после деплоя. */
export async function syncLatestOkxSignals(
  chains: ChainKey[] = activeSignalChains().map(([chain]) => chain),
  origin: PaperSignalOrigin = 'REST_BACKFILL',
) {
  const outcomes = await Promise.all(chains.map((chain) => fetchLatestSignalsOutcome(chain, 100)));
  // Старые первыми: если один токен встречается несколько раз, в Token
  // останется цена самого свежего сигнала, а не случайного Promise.
  const signals = outcomes
    .flatMap((outcome) => (outcome.kind === 'ok' ? outcome.signals : []))
    .sort((a, b) => a.signaledAt.getTime() - b.signaledAt.getTime());

  const stats = { fetched: signals.length, created: 0, duplicate: 0, failed: 0 };
  for (const signal of signals) {
    const result = await ingestOkxSignal(signal, origin);
    stats[result]++;
  }

  /*
   * Успех — только подтверждённый ответ хотя бы по одной сети. Отказ
   * по всем сетям записывается кодом причины и не трогает время
   * успеха: иначе отклонённый ключ выглядел бы как спокойный рынок.
   */
  const failures = outcomes.filter((outcome) => outcome.kind !== 'ok');
  if (failures.length < outcomes.length) recordRestSuccess();
  else if (failures[0]) recordRestFailure(failures[0]);
  logger.info({ ...stats, origin, failures: failures.map((f) => f.kind) }, 'OKX Signal: последние события синхронизированы');
  return stats;
}

function recordRestSuccess(now = Date.now()): void {
  lastRestSuccessAt = now;
  lastRestErrorCode = null;
}

/**
 * Отказ REST по видам. `budget` — отказ нашего учёта квоты, сеть не
 * трогали: источник не доказан мёртвым, время успеха стареет само.
 */
function recordRestFailure(outcome: Exclude<SignalFetchOutcome, { kind: 'ok' }>): void {
  lastRestErrorCode = outcome.kind === 'budget' ? 'budget' : outcome.kind === 'auth' ? 'auth' : outcome.kind === 'quota' ? 'quota' : `${outcome.kind}:${outcome.detail}`;
}

/**
 * Независимое обновление списков Signal и Market API.
 *
 * Спрашивается при старте и потом раз в час; пока ответа нет —
 * раз в минуту. Именно этот ответ, а не таблица в коде, решает,
 * подписываться ли на Robinhood Chain и считать ли её готовой.
 */
export async function refreshSignalSupportedChains(now = Date.now()): Promise<void> {
  await Promise.all((['signal', 'market'] as const).map(async (kind) => {
    const check = chainChecks[kind];
    const confirmation = getOkxChainConfirmation(kind, now);
    // A failed hourly refresh retries in one minute, even while the last
    // success is still valid. Empty successful lists are valid confirmations.
    const failed = check.failed;
    const interval = confirmation.status === 'valid' && !failed ? SUPPORTED_CHAINS_REFRESH_MS : SUPPORTED_CHAINS_RETRY_MS;
    const anchor = interval === SUPPORTED_CHAINS_REFRESH_MS ? confirmation.succeededAt : check.attemptedAt;
    if (check.inFlight || (anchor != null && now - anchor < interval)) return;
    check.inFlight = true;
    check.attemptedAt = now;
    check.failed = true;
    try {
      const rows = await (kind === 'signal' ? fetchSignalSupportedChains() : fetchMarketSupportedChains());
      if (rows == null) {
        logger.warn({ kind }, 'OKX: список поддерживаемых сетей не получен');
        return;
      }
      check.failed = false;
      const indexes = rows.map(row => row.chainIndex);
      if (kind === 'market') setOkxMarketChainIndexes(indexes);
      else {
        const before = getOkxSignalChainIndexes();
        setOkxSignalChainIndexes(indexes);
        if (JSON.stringify(before) !== JSON.stringify(indexes)) {
          client?.setSignalChains(activeSignalChains().map(([, index]) => index));
        }
      }
    } catch (error) {
      logger.warn({ kind, error }, 'OKX: проверка списка сетей не завершена');
    } finally { check.inFlight = false; }
  }));
}

async function reconciliationTick(): Promise<void> {
  if (!running || reconciling) return;
  reconciling = true;
  try {
    const now = Date.now();
    void refreshSignalSupportedChains(now).catch((error) => {
      logger.debug({ code: error?.code }, 'OKX Signal: список сетей не обновлён');
    });
    // Узлы EVM-сетей: chainId перепроверяется раз в десять минут, не на каждый снимок.
    if (!refreshingProbes) {
      refreshingProbes = true;
      void refreshEvmProbes(now).catch(() => undefined).finally(() => { refreshingProbes = false; });
    }
    const interval = pollInterval();
    const selected = restSchedule.claim(activeSignalChains(), Date.now(), interval);
    if (!selected) return;
    const owner = randomUUID();
    let shared;
    try { shared = await claimSharedSignalPoll(activeSignalChains(), interval, owner); }
    catch (error) { restSchedule.complete(Date.now(), interval, { kind: 'network' }); throw error; }
    restSchedule.blockedUntil = Math.max(restSchedule.blockedUntil, shared.blockedUntil);
    if (!shared.chain) { restSchedule.complete(Date.now(), interval); return; }
    const [chain] = shared.chain;
    lastReconciliationAt = Date.now();
    let failure: { kind: string; retryAfterMs?: number | null } | undefined;

    try {
      const outcome = await fetchLatestSignalsOutcome(chain, 100);
      if (outcome.kind !== 'ok') {
        failure = outcome;
        recordRestFailure(outcome);
        logger.warn({ chain, kind: outcome.kind, detail: outcome.detail }, 'OKX Signal: REST reconciliation отклонена провайдером');
        return;
      }
      for (const signal of [...outcome.signals].reverse()) {
        await ingestOkxSignal(signal, 'REST_RECONCILIATION');
      }
      recordRestSuccess();
    } catch (error: any) {
      failure = { kind: 'network' };
      lastRestErrorCode = `network:${String(error?.code ?? error?.name ?? 'REST_RECONCILIATION_FAILED')}`;
      logger.warn(
        { chain, code: lastRestErrorCode },
        'OKX Signal: REST reconciliation не выполнена',
      );
    } finally {
      restSchedule.complete(Date.now(), interval, failure);
      await finishSharedSignalPoll(owner, interval, restSchedule.blockedUntil);
    }
  } catch (error) {
    logger.warn({ error }, 'OKX Signal: общий допуск REST недоступен, запрос отложен');
  } finally { reconciling = false; }
}

setPaperSignalSourceProbe(() => getOkxSignalSourceFacts());

export function startOkxSignalIngest(): void {
  if (running) return;
  if (!isOkxConfigured()) {
    transportMode = 'DISABLED';
    logger.warn('OKX Signal не запущен: учётные данные OKX не настроены');
    return;
  }

  running = true;
  startedAt = Date.now();
  client = new OkxWalletWebSocketClient({
    id: 'okx-signal',
    addresses: [],
    platformFeed: false,
    signalChains: activeSignalChains().map(([, index]) => index),
    onEvent: () => undefined,
    onSignal: (signal) => void ingestOkxSignal(signal, 'WEBSOCKET_LIVE'),
    onSignalTransportChange: (mode, code) => {
      transportMode = mode;
      permanentDenialCode = code;
    },
    onRejected: (reason) => logger.debug({ reason }, 'OKX Signal: сообщение отклонено'),
  });

  // Сначала подписываемся, затем догружаем историю. Обратный порядок
  // оставил бы окно между REST-ответом и готовностью сокета. Список
  // сетей уточняется параллельно: подтверждённая сеть добавляется в
  // подписку, как только OKX её назвал.
  client.start();
  void refreshSignalSupportedChains().catch(() => undefined);
  // Startup uses the same paced path. No five-network backfill burst and no
  // historical event gains a new timestamp: the agent enforces signaledAt.
  void reconciliationTick();
  reconciliationTimer = setInterval(() => void reconciliationTick(), 250);
  reconciliationTimer.unref?.();

  logger.info({ chains: activeSignalChains().map(([chain]) => chain) }, 'OKX Signal: живая лента запущена');
}

export function stopOkxSignalIngest(): void {
  running = false;
  client?.stop();
  client = null;
  if (reconciliationTimer) clearInterval(reconciliationTimer);
  reconciliationTimer = null;
  restSchedule = new SignalRestSchedule();
  lastReconciliationAt = 0;
  lastRestSuccessAt = 0;
  lastRestErrorCode = null;
  lastSignalAt = null;
  transportMode = 'WEBSOCKET';
  permanentDenialCode = null;
  for (const check of Object.values(chainChecks)) { check.attemptedAt = null; check.failed = false; }
}
