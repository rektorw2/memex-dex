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

import {
  planConnections,
  liveEventId,
  MAX_ADDRESSES_PER_CONNECTION,
  type LiveTradeEvent,
  type ChainKey,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { OkxWalletWebSocketClient, type SocketFactory } from './okx-ws-client.js';
import { isOkxWalletConfigured, fetchTrades } from './okx-wallets.js';
import { walletLedgerRepo } from '../workers/wallet-ledger-repo.js';
import {
  okxConfigurationStatus,
  hasCredentialConflict,
  type OkxConfigurationStatus,
} from '../lib/okx-config.js';

export type SourceMode = 'websocket' | 'rest-fallback' | 'disabled';
/**
 * Состояние источника.
 *
 * `configuration_error` отделено от `error` намеренно: незаполненная
 * переменная и оборванная сеть выглядят снаружи одинаково, а чинятся
 * в разных местах. `connecting` отделено от `error` по той же причине —
 * первые секунды после запуска не поломка.
 */
export type SourceStatus =
  | 'healthy'
  | 'connecting'
  | 'degraded'
  | 'error'
  | 'configuration_error';

export interface ActivityStatus {
  mode: SourceMode;
  status: SourceStatus;
  /**
   * Дошли ли переменные до этого процесса.
   *
   * Только булевы значения — ни маскированных ключей, ни длины,
   * ни первых символов. Этого хватает, чтобы отличить «переменные
   * добавлены не в тот сервис» от «ключ неверный», а это две
   * совершенно разные починки. Снаружи же оба случая выглядят
   * одинаково: пустая лента без ошибок.
   */
  configuration: OkxConfigurationStatus;
  connections: { total: number; connected: number; reconnecting: number };
  /** Вход принят хотя бы одним соединением. */
  loginVerified: boolean;
  /** Хотя бы одно соединение получило подтверждение подписок. */
  subscriptionsVerified: boolean;
  /** Числовой код отказа от OKX, если он был. Секретом не является. */
  providerErrorCode: string | null;
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
  private addressRefreshTimer: NodeJS.Timeout | null = null;
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

    // Discovery пополняет список после старта процесса. Без повторного
    // чтения новый кандидат не подписывался до следующего деплоя.
    this.addressRefreshTimer = setInterval(() => {
      void this.refreshAddresses().then(() => {
        if (env.OKX_WS_ENABLED) this.rebuildPool();
      });
    }, 5 * 60_000);
    this.addressRefreshTimer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    for (const c of this.clients) c.stop();
    this.clients = [];
    this.stopPolling();
    if (this.addressRefreshTimer) clearInterval(this.addressRefreshTimer);
    this.addressRefreshTimer = null;
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
        where: {
          OR: [
            { label: { not: 'none' } },
            // Кандидат из лидерборда ещё не имеет нашей оценки, но
            // `knownAs` хранит проверенную категорию OKX. Именно его
            // сделки нужно слушать, чтобы оценка появилась.
            { knownAs: { not: null } },
          ],
        },
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
   * Запись и постановка в очередь пересчёта делаются одним действием.
   * Раздельно нельзя: процесс, упавший между ними, оставил бы сделку
   * навсегда неучтённой — она есть в ленте, видна человеку, но
   * в позиции не попадёт никогда и повода к этому не возникнет.
   *
   * Возвращает признак новизны: повторное событие доходит сюда штатно
   * при переключении источников и молча ничего не делает.
   */
  async ingest(e: LiveTradeEvent): Promise<'created' | 'duplicate' | 'failed'> {
    this.lastMessageAt = Date.now();

    const dueAt = new Date(Date.now() + env.WALLET_LEDGER_SYNC_DEBOUNCE_MS);

    try {
      const { created } = await walletLedgerRepo.ingestAtomically(
        {
          id: e.id,
          chain: e.chain,
          walletAddress: e.wallet,
          tokenAddress: e.tokenAddress,
          tokenSymbol: e.tokenSymbol,
          side: e.side,
          quoteSymbol: e.quoteSymbol,
          quoteAmount: e.quoteAmount,
          priceUsd: e.priceUsd,
          marketCapUsd: e.marketCapUsd,
          realizedPnlUsd: e.realizedPnlUsd,
          txHash: e.txHash,
          trackerType: e.trackerType,
          source: e.source,
          parsingConfidence: e.parsingConfidence,
          tradedAt: new Date(e.tradedAt),
        },
        dueAt,
      );

      if (!created) {
        // Повтор — не ошибка, а ожидаемый исход при пересечении
        // источников. Задача при этом всё равно ставится заново,
        // если событие ещё не перенесено в позиции.
        this.duplicates++;
        return 'duplicate';
      }

      this.lastPersistedAt = Date.now();

      // Сам пересчёт идёт отдельным воркером и не задерживает ленту:
      // точных количеств в событии нет, их даёт история DEX.
      return 'created';
    } catch (err: any) {
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
          // Тот же ключ, что строит разбор сообщения сокета.
          // Собирать его здесь по-своему значило бы получать два
          // ключа на одну сделку и записывать её дважды.
          id: liveEventId({
            chain: t.chain as ChainKey,
            wallet: t.wallet,
            tokenAddress: t.tokenAddress,
            side: t.side,
            txHash: t.txHash,
            tradedAt: t.tradedAt,
            quoteAmount: t.quoteAmount,
          }),
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

    const configuration = okxConfigurationStatus();

    const credentialsReady =
      configuration.apiKeyConfigured &&
      configuration.apiSecretConfigured &&
      configuration.passphraseConfigured;

    const mode: SourceMode = !env.OKX_WS_ENABLED
      ? 'disabled'
      : this.fallbackActive
        ? 'rest-fallback'
        : 'websocket';

    const loginVerified = stats.some((s) => s.loginVerified);
    const subscriptionsVerified = stats.some((s) => s.subscriptionsVerified);

    // Код отказа от провайдера важнее нашего кода стадии: он
    // указывает, что именно чинить.
    const providerErrorCode = stats.find((s) => s.lastProviderCode)?.lastProviderCode ?? null;

    /**
     * Порядок проверок — от причины к следствию.
     *
     * Ненастроенные ключи выглядят как оборванное соединение,
     * а отклонённый вход — как спокойный рынок. Если сообщить
     * «ошибка», не различив их, человек пойдёт чинить сеть там,
     * где не заполнена переменная.
     */
    const status: SourceStatus = !credentialsReady
      ? 'configuration_error'
      : hasCredentialConflict()
        ? 'configuration_error'
        : connected > 0 && !this.fallbackActive
          ? 'healthy'
          : this.fallbackActive
            ? 'degraded'
            : stats.some((s) => s.state === 'connecting' || s.state === 'authenticating')
              ? 'connecting'
              : 'error';

    return {
      mode,
      status,
      configuration,
      connections: { total: stats.length, connected, reconnecting },
      loginVerified,
      subscriptionsVerified,
      providerErrorCode,
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
      //
      // Своё поле заполняется лишь при отклонённом событии, поэтому
      // одного его мало: соединение может переподключаться десятками
      // раз, ни разу не отклонив событие, и наружу уходило бы «ошибок
      // нет» при неработающем сокете. Причина обрыва живёт в клиенте —
      // берём её оттуда.
      lastErrorCode:
        this.lastErrorCode ?? stats.find((s) => s.lastErrorCode)?.lastErrorCode ?? null,
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
