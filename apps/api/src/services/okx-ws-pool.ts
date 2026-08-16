/**
 * Пул соединений и приём живых событий.
 *
 * Три обязанности, которые нельзя разделить, потому что они завязаны
 * на одно состояние: сколько соединений держать, что считать живым
 * источником и когда включать запасной опрос.
 *
 * Ключевая мысль про запасной опрос: он должен включаться не по факту
 * ошибки, а по факту молчания. Сокет умеет быть открытым и мёртвым
 * одновременно — обрыва не было, ошибок нет, данных тоже. Если ждать
 * ошибку, опрос не включится никогда, и лента просто остановится
 * без единого признака поломки.
 *
 * Про дедупликацию. Сокет и опрос работают по одному и тому же
 * потоку сделок, и в момент переключения они неизбежно пересекаются.
 * Общий ключ события делает это пересечение безвредным: повторное
 * событие не создаёт вторую запись и не трогает позиции второй раз.
 */

import { Prisma as P } from '@prisma/client';
import {
  planConnections,
  MAX_ADDRESSES_PER_CONNECTION,
  type LiveTradeEvent,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { OkxWalletWebSocketClient, type SocketFactory } from './okx-ws-client.js';
import { isOkxWalletConfigured, fetchTrades } from './okx-wallets.js';

export type SourceMode = 'websocket' | 'rest-fallback' | 'disabled';
export type SourceStatus = 'healthy' | 'degraded' | 'error';

export interface ActivityStatus {
  mode: SourceMode;
  status: SourceStatus;
  connections: { total: number; connected: number; reconnecting: number };
  trackedWallets: number;
  lastMessageAt: string | null;
  lastPersistedAt: string | null;
  reconnects: number;
  rejectedEvents: number;
  duplicateEvents: number;
  fallbackActive: boolean;
  lastErrorCode: string | null;
}

/**
 * Приём и хранение живых событий.
 *
 * Запись идемпотентна по ключу события: первичный ключ таблицы —
 * он сам. Повторная вставка не проходит, и это не ошибка, а норма
 * при переключении между источниками.
 */
export class ActivityIngestor {
  private clients: OkxWalletWebSocketClient[] = [];
  private addresses: string[] = [];

  private pollTimer: NodeJS.Timeout | null = null;
  private fallbackActive = false;

  private lastMessageAt: number | null = null;
  private lastPersistedAt: number | null = null;
  private rejected = 0;
  private duplicates = 0;
  private lastErrorCode: string | null = null;

  private stopped = false;

  constructor(private readonly factory?: SocketFactory) {}

  // ──────────────────────────── Жизненный цикл ──────────────────────────────

  async start(): Promise<void> {
    this.stopped = false;

    if (!isOkxWalletConfigured()) {
      logger.info('лента активности: OKX не настроен');
      return;
    }

    await this.refreshAddresses();

    if (env.OKX_WS_ENABLED) {
      this.rebuildPool();
    } else {
      // Сокет выключен настройкой — опрос становится основным,
      // а не запасным, и это законное состояние.
      this.startPolling('websocket_disabled');
    }

    // Проверка живости отдельным таймером: он же решает, включать
    // ли опрос. Проверять это внутри клиента нельзя — клиент знает
    // только про своё соединение, а решение принимается по всем.
    setInterval(() => this.checkHealth(), 15_000).unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.clients) c.stop();
    this.clients = [];
    this.stopPolling();
  }

  // ─────────────────────────────── Соединения ───────────────────────────────

  /**
   * Список отслеживаемых адресов.
   *
   * Берётся из базы: кандидаты поиска плюс всё, за чем следит
   * пользователь. Ограничение сверху не по красоте, а по стоимости:
   * каждые двести адресов — это ещё одно соединение.
   */
  private async refreshAddresses(): Promise<void> {
    const wallets = await prisma.traderWallet
      .findMany({
        where: { label: { not: 'none' } },
        orderBy: { lastActiveAt: 'desc' },
        take: MAX_ADDRESSES_PER_CONNECTION * 5,
        select: { address: true },
      })
      .catch(() => []);

    this.addresses = wallets.map((w) => w.address);
  }

  /**
   * Пересборка пула.
   *
   * Раскладка устойчивая: один и тот же набор адресов всегда даёт
   * одно распределение. Поэтому добавление адреса чаще всего меняет
   * лишь одно соединение, а остальные продолжают работать.
   */
  private rebuildPool(): void {
    const plans = planConnections(this.addresses);

    // Первое соединение дополнительно слушает общий канал платформы:
    // он не привязан к адресам и нужен ровно один раз.
    for (let i = 0; i < Math.max(plans.length, 1); i++) {
      const plan = plans[i];
      const existing = this.clients[i];

      if (existing) {
        existing.setAddresses(plan?.addresses ?? []);
        continue;
      }

      const client = new OkxWalletWebSocketClient({
        id: `okx-ws-${i}`,
        addresses: plan?.addresses ?? [],
        platformFeed: i === 0,
        factory: this.factory,
        onEvent: (e) => void this.ingest(e),
        onRejected: (reason) => {
          this.rejected++;
          this.lastErrorCode = reason;
        },
      });

      this.clients.push(client);
      client.start();
    }

    // Лишние соединения останавливаются: адресов стало меньше.
    while (this.clients.length > Math.max(plans.length, 1)) {
      this.clients.pop()?.stop();
    }
  }

  // ────────────────────────────── Приём события ─────────────────────────────

  /**
   * Сохранение события.
   *
   * Возвращает признак новизны: позиции обновляются только после
   * успешной первой вставки. Повторное событие доходит сюда штатно
   * при переключении источников, и молча ничего не делает.
   */
  async ingest(e: LiveTradeEvent): Promise<'created' | 'duplicate' | 'failed'> {
    this.lastMessageAt = Date.now();

    try {
      await prisma.walletActivity.create({
        data: {
          id: e.id,
          chain: e.chain as never,
          walletAddress: e.wallet,
          tokenAddress: e.tokenAddress,
          tokenSymbol: e.tokenSymbol,
          side: e.side,
          quoteSymbol: e.quoteSymbol,
          quoteAmount: e.quoteAmount != null ? new P.Decimal(e.quoteAmount) : null,
          priceUsd: e.priceUsd != null ? new P.Decimal(e.priceUsd) : null,
          marketCapUsd: e.marketCapUsd != null ? new P.Decimal(e.marketCapUsd) : null,
          realizedPnlUsd: e.realizedPnlUsd != null ? new P.Decimal(e.realizedPnlUsd) : null,
          txHash: e.txHash,
          trackerType: e.trackerType,
          source: e.source,
          parsingConfidence: new P.Decimal(e.parsingConfidence),
          tradedAt: new Date(e.tradedAt),
        },
      });

      this.lastPersistedAt = Date.now();

      // Событие сохранено — кошелёк помечается на пересчёт.
      // Сам пересчёт идёт отдельно и не задерживает ленту:
      // точных количеств в событии нет, их даёт история DEX.
      const { markDirty } = await import('../workers/wallet-ledger-sync.js');
      await markDirty(e.chain, e.wallet);
      // Обновление позиций делает отдельный проход по неучтённым
      // записям: держать его здесь значило бы связать приём события
      // со скоростью расчёта.
      return 'created';
    } catch (err: any) {
      // Нарушение уникальности — не ошибка, а ожидаемый исход
      // при пересечении источников.
      if (err?.code === 'P2002') {
        this.duplicates++;
        return 'duplicate';
      }

      logger.warn({ err: err?.message }, 'лента активности: запись не удалась');
      return 'failed';
    }
  }

  // ──────────────────────── Живость и запасной опрос ────────────────────────

  private checkHealth(): void {
    if (this.stopped || !env.OKX_WS_ENABLED) return;

    const healthy = this.clients.some((c) => c.isHealthy());

    if (!healthy && !this.fallbackActive) {
      this.startPolling('websocket_unhealthy');
      return;
    }

    if (healthy && this.fallbackActive) {
      // Опрос выключается не сразу: одно удачное сообщение ещё
      // не означает, что соединение устоялось. Ждём, пока источник
      // продержится, иначе будем включать и выключать опрос
      // при каждом моргании.
      const stableFor =
        this.lastMessageAt != null ? Date.now() - this.lastMessageAt : Infinity;

      if (stableFor < env.OKX_WS_STALE_AFTER_MS / 2) {
        this.stopPolling();
      }
    }
  }

  private startPolling(reason: string): void {
    if (this.pollTimer) return;

    this.fallbackActive = true;
    logger.info({ reason }, 'лента активности: включён запасной опрос');

    const tick = async () => {
      const events = await fetchTrades({ trackerType: 1 }).catch(() => []);
      for (const t of events) {
        // Ключ события общий с сокетом, поэтому пересечение
        // источников безвредно.
        await this.ingest({
          id: [t.chain, t.txHash, t.wallet, t.tokenAddress, t.side].join('|'),
          chain: t.chain as ChainKey,
          wallet: t.wallet,
          tokenAddress: t.tokenAddress,
          tokenSymbol: t.tokenSymbol,
          side: t.side,
          quoteSymbol: t.quoteSymbol,
          quoteAmount: t.quoteAmount,
          priceUsd: t.priceUsd,
          marketCapUsd: t.marketCapUsd,
          realizedPnlUsd: t.realizedPnlUsd,
          tradedAt: t.tradedAt,
          txHash: t.txHash,
          trackerType: null,
          source: 'okx_rest',
          receivedAt: Date.now(),
          parsingConfidence: 1,
        });
      }
    };

    void tick();
    this.pollTimer = setInterval(
      () => void tick(),
      env.OKX_ACTIVITY_REST_FALLBACK_INTERVAL_MS,
    );
    this.pollTimer.unref?.();
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;

    if (this.fallbackActive) {
      logger.info('лента активности: сокет восстановлен, опрос остановлен');
    }
    this.fallbackActive = false;
  }

  // ─────────────────────────────── Состояние ────────────────────────────────

  status(): ActivityStatus {
    const stats = this.clients.map((c) => c.stats());
    const connected = stats.filter((s) => s.state === 'connected').length;
    const reconnecting = stats.filter((s) => s.state === 'reconnecting').length;

    const mode: SourceMode = !env.OKX_WS_ENABLED
      ? 'disabled'
      : this.fallbackActive
        ? 'rest-fallback'
        : 'websocket';

    const status: SourceStatus =
      connected > 0 && !this.fallbackActive
        ? 'healthy'
        : this.fallbackActive
          ? 'degraded'
          : 'error';

    return {
      mode,
      status,
      connections: { total: stats.length, connected, reconnecting },
      trackedWallets: this.addresses.length,
      lastMessageAt: this.lastMessageAt ? new Date(this.lastMessageAt).toISOString() : null,
      lastPersistedAt: this.lastPersistedAt
        ? new Date(this.lastPersistedAt).toISOString()
        : null,
      reconnects: stats.reduce((s, c) => s + c.reconnects, 0),
      rejectedEvents: this.rejected,
      duplicateEvents: this.duplicates,
      fallbackActive: this.fallbackActive,
      // Только код, без объекта ошибки провайдера: в нём бывают
      // заголовки запроса.
      lastErrorCode: this.lastErrorCode,
    };
  }
}

/** Один приёмник на процесс. */
let instance: ActivityIngestor | null = null;

export function getIngestor(): ActivityIngestor {
  instance ??= new ActivityIngestor();
  return instance;
}

export function startActivityIngest(): void {
  void getIngestor().start();
}

export function stopActivityIngest(): void {
  instance?.stop();
}
