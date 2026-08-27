/**
 * WebSocket-клиент OKX для живой ленты кошельков.
 *
 * Главное решение этого файла — что считать готовностью источника.
 * Открытое соединение готовностью не является: сокет может быть
 * открыт, вход отклонён, подписки не подтверждены, и при этом
 * не приходить ни байта. Снаружи это неотличимо от спокойного
 * рынка, и REST-подстраховка не включится, потому что формально
 * всё «работает».
 *
 * Поэтому состояние `connected` наступает только после трёх событий
 * подряд: сокет открыт, вход подтверждён кодом ноль, подписки
 * подтверждены. Любое из них с превышением времени возвращает
 * машину в переподключение.
 *
 * Второе решение — сокет не создаётся напрямую. Фабрика внедряется,
 * и тесты подставляют управляемую подделку. Иначе проверить
 * переподключение, зависание и восстановление подписок можно было бы
 * только вживую, то есть никогда.
 */

import { createHmac } from 'node:crypto';
import {
  buildWsLoginPreHash,
  wsTimestamp,
  parseLoginReply,
  parseLiveTrade,
  parseOkxSignalMessage,
  OKX_SIGNAL_CHANNEL,
  reconnectDelay,
  LiveParseError,
  type LiveTradeEvent,
  type OkxSignal,
} from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

// ─────────────────────────── Машина состояний ───────────────────────────────

export type WsState =
  | 'disabled'
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'subscribing'
  | 'connected'
  | 'reconnecting'
  | 'rest_only'
  | 'stopping';

export type SignalTransportMode = 'WEBSOCKET' | 'REST_ONLY' | 'DISABLED';

/**
 * Минимальный интерфейс сокета.
 *
 * Ровно то, чем пользуется клиент. Подделка в тестах реализует
 * этот интерфейс целиком, и никакой части настоящего WebSocket
 * имитировать не приходится.
 */
export interface SocketLike {
  send(data: string): void;
  close(): void;
  onopen: ((ev?: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
  onclose: ((ev?: unknown) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

const defaultFactory: SocketFactory = (url) => new WebSocket(url) as unknown as SocketLike;

export interface ClientOptions {
  id: string;
  /** Адреса, за которыми следит это соединение. До двухсот. */
  addresses: string[];
  /** Подписываться ли на общий канал Smart Money и KOL. */
  platformFeed?: boolean;
  onEvent: (e: LiveTradeEvent) => void;
  /** Сети официального Signal channel. Пустой список не подписывает канал. */
  signalChains?: string[];
  onSignal?: (e: OkxSignal) => void;
  onSignalTransportChange?: (mode: SignalTransportMode, providerCode: string | null) => void;
  onRejected?: (reason: string) => void;
  factory?: SocketFactory;
  /** Подставной таймер для тестов. */
  now?: () => number;
  random?: () => number;
}

export interface ConnectionStats {
  id: string;
  state: WsState;
  addresses: number;
  lastMessageAt: number | null;
  lastLoginAt: number | null;
  consecutiveErrors: number;
  reconnects: number;
  /** Последняя ошибка без секретов. */
  lastErrorCode: string | null;
  /** Числовой код отказа от OKX. Секретом не является. */
  lastProviderCode: string | null;
  /** Вход был принят хотя бы раз. */
  loginVerified: boolean;
  /** Все подписки подтверждены провайдером. */
  subscriptionsVerified: boolean;
  channelTransportMode: SignalTransportMode;
  channelAccessDeniedCode: string | null;
}

interface PendingCommand {
  id: number;
  generation: number;
  op: 'subscribe' | 'unsubscribe';
  channel: string;
  args: unknown[];
}

export const PLATFORM_CHANNEL = 'kol_smartmoney-tracker-activity';
export const ADDRESS_CHANNEL = 'address-tracker-activity';

/**
 * Коды, при которых повторять быстро бессмысленно.
 *
 * Неверный ключ не станет верным от десятой попытки, а частые
 * повторы с неверной подписью — это способ получить блокировку.
 * Такие отказы переводят соединение в медленный режим.
 */
const AUTH_FAILURE_CODES = new Set(['60005', '60006', '60007', '60009', '60022', '60024']);

/**
 * OKX документирует 60029 как постоянный whitelist-отказ канала.
 * В production встречался также строковый `-60029`, поэтому знак не
 * участвует в классификации. Текстовая ветка оставлена как безопасный
 * эквивалент на случай смены числового кода провайдером.
 */
export function isPermanentSignalChannelDenial(code: unknown, message: unknown): boolean {
  const normalizedCode = String(code ?? '').trim().replace(/^-/, '');
  if (normalizedCode === '60029') return true;
  const normalizedMessage = String(message ?? '').toLowerCase();
  return normalizedMessage.includes('whitelist') && normalizedMessage.includes('channel');
}

export class OkxWalletWebSocketClient {
  private socket: SocketLike | null = null;
  private state: WsState = 'disconnected';

  private reconnectTimer: NodeJS.Timeout | null = null;
  private stageTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private attempt = 0;
  private reconnects = 0;
  private consecutiveErrors = 0;
  private lastMessageAt: number | null = null;
  private lastLoginAt: number | null = null;
  private lastErrorCode: string | null = null;
  /**
   * Числовой код отказа от самого OKX.
   *
   * Хранится отдельно от нашего кода стадии, потому что различает
   * то, что для нас выглядит одинаково: 60005 — неверный ключ,
   * 60007 — не сошлась подпись, 60024 — не та парольная фраза,
   * 60029 — канал требует доступа. Все четыре дают «вход отклонён»,
   * а чинятся по-разному. Сам по себе код секретом не является.
   */
  private lastProviderCode: string | null = null;
  private signalAccessDeniedCode: string | null = null;
  private stopped = false;
  private commandSeq = 0;

  /**
   * Очередь команд подписки.
   *
   * Прежняя реализация ждала подтверждения на каждый адрес отдельно
   * и сверяла его по arg.walletAddress. Это неверно: подтверждение
   * приходит одно на команду и содержит только channel. Двести
   * адресов в такой схеме давали двести неподтверждённых ожиданий,
   * срабатывал таймаут, и соединение уходило в переподключение
   * по кругу — при том что подписка на самом деле работала.
   *
   * Теперь единица ожидания — команда, а не адрес. Выполняется
   * не больше одной за раз: OKX ограничивает число операций
   * на соединение, и залп из двухсот запросов выберет лимит.
   */
  private queue: PendingCommand[] = [];
  private inFlight: PendingCommand | null = null;

  /**
   * Поколение соединения.
   *
   * Ответ, пришедший от прежнего сокета, не должен подтверждать
   * подписку нового. Без этого после обрыва запоздалое подтверждение
   * закрывало бы команду, которую никто не отправлял.
   */
  private generation = 0;

  private addresses: string[];

  private readonly factory: SocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly opts: ClientOptions) {
    this.addresses = [...opts.addresses];
    this.factory = opts.factory ?? defaultFactory;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
  }

  getState(): WsState {
    return this.state;
  }

  isHealthy(): boolean {
    if (this.state !== 'connected') return false;
    if (this.lastMessageAt == null) return true;
    return this.now() - this.lastMessageAt < env.OKX_WS_STALE_AFTER_MS;
  }

  stats(): ConnectionStats {
    return {
      id: this.opts.id,
      state: this.state,
      addresses: this.addresses.length,
      lastMessageAt: this.lastMessageAt,
      lastLoginAt: this.lastLoginAt,
      consecutiveErrors: this.consecutiveErrors,
      reconnects: this.reconnects,
      lastErrorCode: this.lastErrorCode,
      lastProviderCode: this.lastProviderCode,
      loginVerified: this.lastLoginAt != null,
      subscriptionsVerified: this.state === 'connected',
      channelTransportMode:
        (this.opts.signalChains?.length ?? 0) === 0
          ? 'DISABLED'
          : this.signalAccessDeniedCode != null
            ? 'REST_ONLY'
            : this.state === 'disabled'
              ? 'DISABLED'
              : 'WEBSOCKET',
      channelAccessDeniedCode: this.signalAccessDeniedCode,
    };
  }

  // ────────────────────────────── Жизненный цикл ────────────────────────────

  start(): void {
    if (!env.OKX_WS_ENABLED) {
      this.setState('disabled');
      this.opts.onSignalTransportChange?.('DISABLED', null);
      return;
    }
    this.stopped = false;
    this.open();
  }

  /**
   * Остановка.
   *
   * Флаг ставится до закрытия сокета: обработчик onclose иначе
   * запланировал бы переподключение уже после команды остановиться,
   * и процесс не завершился бы никогда.
   */
  stop(): void {
    this.stopped = true;
    this.setState('stopping');
    this.clearTimers();

    if (this.socket) {
      this.detach(this.socket);
      try {
        this.socket.close();
      } catch {
        // Закрытие уже закрытого сокета — не ошибка.
      }
      this.socket = null;
    }

    this.queue = [];
    this.inFlight = null;
    this.setState('disconnected');
  }

  /** Изменить список адресов без пересоздания соединения. */
  setAddresses(next: string[]): void {
    const before = new Set(this.addresses);
    this.addresses = [...next];

    if (this.state !== 'connected') {
      // Во время переподключения менять подписки нечем: новый набор
      // применится при восстановлении, потому что восстановление
      // читает актуальный список, а не снимок момента обрыва.
      return;
    }

    const added = next.filter((a) => !before.has(a));
    const removed = [...before].filter((a) => !next.includes(a));

    if (added.length > 0) {
      this.enqueue(
        'subscribe',
        ADDRESS_CHANNEL,
        added.map((walletAddress) => ({ channel: ADDRESS_CHANNEL, walletAddress })),
      );
    }
    if (removed.length > 0) {
      this.enqueue(
        'unsubscribe',
        ADDRESS_CHANNEL,
        removed.map((walletAddress) => ({ channel: ADDRESS_CHANNEL, walletAddress })),
      );
    }

    this.pump();
  }

  // ─────────────────────────────── Соединение ───────────────────────────────

  private open(): void {
    if (this.stopped) return;

    this.setState('connecting');
    // Новое поколение: ответы прежнего сокета больше ничего
    // не подтверждают.
    this.generation++;
    this.queue = [];
    this.inFlight = null;

    let socket: SocketLike;
    try {
      socket = this.factory(env.OKX_WS_URL);
    } catch (e: any) {
      this.fail('connect_failed', e?.message);
      return;
    }

    this.socket = socket;

    socket.onopen = () => this.onOpen();
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onerror = () => this.fail('socket_error');
    socket.onclose = () => this.onClose();

    this.armStage(env.OKX_WS_CONNECT_TIMEOUT_MS, 'connect_timeout');
  }

  private onOpen(): void {
    if (this.stopped) return;

    this.setState('authenticating');
    this.armStage(env.OKX_WS_LOGIN_TIMEOUT_MS, 'login_timeout');

    const ts = wsTimestamp(this.now());
    const sign = createHmac('sha256', env.OKX_API_SECRET ?? '')
      .update(buildWsLoginPreHash(ts))
      .digest('base64');

    // Ни ключ, ни подпись, ни парольная фраза в журнал не идут:
    // журналы переживают инциденты и читаются людьми без доступа
    // к учётным данным.
    this.send({
      op: 'login',
      args: [
        {
          apiKey: env.OKX_API_KEY,
          passphrase: env.OKX_PASSPHRASE,
          timestamp: ts,
          sign,
        },
      ],
    });
  }

  private onMessage(raw: unknown): void {
    this.lastMessageAt = this.now();

    const text = typeof raw === 'string' ? raw : String(raw);

    // Ответ на heartbeat приходит простой строкой, а не объектом.
    if (text === 'pong') return;

    let msg: any;
    try {
      msg = JSON.parse(text);
    } catch {
      this.opts.onRejected?.('malformed_json');
      return;
    }

    // ─── Ответ на вход ──────────────────────────────────────────
    //
    // Только пока мы его ждём. Разбор считает ответом на вход любой
    // кадр `error`, потому что при отказе авторизации OKX присылает
    // именно его — но тот же кадр приходит и при отказе в подписке,
    // спустя долгое время после успешного входа. Без проверки
    // состояния ошибка доступа к каналу выглядела бы как неверный
    // ключ, и чинить пошли бы переменные окружения вместо прав.
    const login = this.state === 'authenticating' ? parseLoginReply(msg) : null;
    if (login) {
      if (!login.ok) {
        this.lastErrorCode = login.code;
        this.lastProviderCode = login.code;
        // Отказ авторизации — отдельный случай: повторять быстро
        // бессмысленно и вредно.
        this.fail(
          AUTH_FAILURE_CODES.has(login.code) ? 'auth_rejected' : 'login_failed',
          undefined,
          AUTH_FAILURE_CODES.has(login.code),
        );
        return;
      }

      this.lastLoginAt = this.now();
      this.consecutiveErrors = 0;
      this.startSubscribing();
      return;
    }

    // ─── Подтверждение подписки ─────────────────────────────────
    if (msg?.event === 'subscribe' || msg?.event === 'unsubscribe') {
      const channel = String(msg?.arg?.channel ?? msg?.args?.[0]?.channel ?? '');
      this.confirmCommand(channel, this.generation);
      return;
    }

    // ─── Предупреждение о плановом отключении ───────────────────
    //
    // Код 64008 означает, что сервер собирается закрыть соединение
    // для обновления. Ждать разрыва незачем: переподключаемся
    // заранее и не теряем сообщения в момент обрыва.
    if (msg?.event === 'notice' && String(msg?.code) === '64008') {
      logger.info({ connection: this.opts.id }, 'OKX сокет: плановое отключение сервиса');
      this.scheduleReconnect('service_notice');
      return;
    }

    if (msg?.event === 'error') {
      this.lastErrorCode = String(msg?.code ?? 'unknown');
      this.lastProviderCode = this.lastErrorCode;
      this.opts.onRejected?.(`ws_error_${this.lastErrorCode}`);

      const failedChannel = String(
        msg?.arg?.channel ?? msg?.args?.[0]?.channel ?? this.inFlight?.channel ?? '',
      );
      if (
        failedChannel === OKX_SIGNAL_CHANNEL &&
        isPermanentSignalChannelDenial(this.lastErrorCode, msg?.msg)
      ) {
        this.denySignalChannel(this.lastErrorCode);
        return;
      }

      // Ошибка закрывает текущую команду: иначе очередь встанет
      // навсегда, ожидая подтверждения, которого не будет.
      if (this.inFlight) {
        this.inFlight = null;
        this.fail(`subscribe_error_${this.lastErrorCode}`);
      }
      return;
    }

    // ─── Живой OKX Signal ───────────────────────────────────────
    // Канал отделён от сделок кошельков: у него нет walletAddress,
    // tradeType и txHash, поэтому прогонять его через parseLiveTrade
    // означало бы отвергать каждое корректное сообщение как кривое.
    if (String(msg?.arg?.channel ?? msg?.channel ?? '') === OKX_SIGNAL_CHANNEL) {
      const signals = parseOkxSignalMessage(msg);

      if (signals.length === 0) this.opts.onRejected?.('signal_parse_failed');
      for (const signal of signals) this.opts.onSignal?.(signal);
      return;
    }

    // ─── Событие ленты ──────────────────────────────────────────
    const items = Array.isArray(msg?.data) ? msg.data : msg?.data ? [msg.data] : [];

    for (const item of items) {
      try {
        this.opts.onEvent(parseLiveTrade(item, { now: this.now() }));
      } catch (e) {
        // Одно кривое событие не должно ронять соединение: остальные
        // сделки в этом же сообщении разбираются дальше.
        this.opts.onRejected?.(e instanceof LiveParseError ? e.reason : 'parse_failed');
      }
    }
  }

  private startSubscribing(): void {
    this.setState('subscribing');
    this.armStage(env.OKX_WS_SUBSCRIBE_TIMEOUT_MS, 'subscribe_timeout');

    this.queue = [];
    this.inFlight = null;

    if (this.opts.platformFeed) {
      this.enqueue('subscribe', PLATFORM_CHANNEL, [{ channel: PLATFORM_CHANNEL }]);
    }

    // Адреса уходят одной командой, а не двумястами.
    //
    // OKX разрешает массив в args и ограничивает число операций
    // на соединение. Двести отдельных запросов выбрали бы этот
    // лимит за минуту работы.
    if (this.addresses.length > 0) {
      this.enqueue(
        'subscribe',
        ADDRESS_CHANNEL,
        this.addresses.map((walletAddress) => ({ channel: ADDRESS_CHANNEL, walletAddress })),
      );
    }

    const signalChains = [...new Set(this.opts.signalChains ?? [])].filter(Boolean);
    if (signalChains.length > 0 && this.signalAccessDeniedCode == null) {
      this.enqueue(
        'subscribe',
        OKX_SIGNAL_CHANNEL,
        signalChains.map((chainIndex) => ({
          channel: OKX_SIGNAL_CHANNEL,
          chainIndex,
        })),
      );
    }

    if (this.queue.length === 0) {
      this.becomeConnected();
      return;
    }

    this.pump();
  }

  /** Поставить команду в очередь. */
  private enqueue(op: 'subscribe' | 'unsubscribe', channel: string, args: unknown[]): void {
    this.queue.push({
      id: ++this.commandSeq,
      generation: this.generation,
      op,
      channel,
      args,
    });
  }

  /** Отправить следующую команду, если предыдущая завершилась. */
  private pump(): void {
    if (this.inFlight || this.queue.length === 0) return;

    const cmd = this.queue.shift()!;
    this.inFlight = cmd;
    this.send({ op: cmd.op, args: cmd.args });
  }

  /**
   * Подтверждение команды.
   *
   * Сверяется канал, а не адрес: адреса в ответе может не быть,
   * и требовать его значило бы никогда не дождаться подтверждения.
   * Код в ответе тоже может отсутствовать — успехом считается сам
   * факт event=subscribe с ожидаемым каналом.
   */
  private confirmCommand(channel: string, gen: number): void {
    const cmd = this.inFlight;

    // Ответ от прежнего соединения не закрывает команду нового.
    if (!cmd || cmd.generation !== gen) return;
    if (cmd.channel !== channel) return;

    this.inFlight = null;

    if (this.queue.length > 0) {
      this.pump();
      return;
    }

    if (this.state === 'subscribing') this.becomeConnected();
  }

  private becomeConnected(): void {
    this.clearStage();
    this.setState('connected');
    this.consecutiveErrors = 0;

    // Счётчик попыток сбрасывается не сразу, а после устойчивого
    // периода: соединение, которое падает через секунду после
    // подъёма, не должно каждый раз начинать задержку с нуля.
    setTimeout(() => {
      if (this.state === 'connected') this.attempt = 0;
    }, env.OKX_WS_HEALTHY_RESET_MS).unref?.();

    this.startHeartbeat();
  }

  private denySignalChannel(providerCode: string): void {
    const normalizedCode = providerCode.trim().replace(/^-/, '') || '60029';
    this.signalAccessDeniedCode = normalizedCode;
    this.lastProviderCode = normalizedCode;
    this.lastErrorCode = `signal_channel_denied_${normalizedCode}`;
    this.inFlight = null;
    this.queue = this.queue.filter((command) => command.channel !== OKX_SIGNAL_CHANNEL);
    this.opts.onSignalTransportChange?.('REST_ONLY', normalizedCode);

    logger.warn(
      { connection: this.opts.id, providerCode: normalizedCode },
      'OKX Signal WebSocket недоступен: канал требует whitelist; включён REST_ONLY',
    );

    const hasOtherSubscriptions = this.opts.platformFeed === true || this.addresses.length > 0;
    if (hasOtherSubscriptions) {
      if (this.queue.length > 0) this.pump();
      else this.becomeConnected();
      return;
    }

    this.clearStage();
    this.clearHeartbeat();
    if (this.socket) {
      this.detach(this.socket);
      try {
        this.socket.close();
      } catch {
        // Канал уже мог закрыться вместе с отказом.
      }
      this.socket = null;
    }
    this.setState('rest_only');
  }

  // ─────────────────────────────── Heartbeat ────────────────────────────────

  private startHeartbeat(): void {
    this.clearHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      // Молчание дольше порога означает зависшее соединение:
      // сокет открыт, но данных нет. Такое не закрывается само,
      // и без принудительного разрыва источник висит мёртвым.
      if (
        this.lastMessageAt != null &&
        this.now() - this.lastMessageAt > env.OKX_WS_STALE_AFTER_MS
      ) {
        this.fail('stale_connection');
        return;
      }

      this.send('ping');
    }, env.OKX_WS_HEARTBEAT_INTERVAL_MS);

    this.heartbeatTimer.unref?.();
  }

  // ──────────────────────────── Переподключение ─────────────────────────────

  private onClose(): void {
    if (this.stopped) return;
    this.scheduleReconnect('closed');
  }

  private fail(code: string, detail?: string, slow = false): void {
    this.lastErrorCode = code;
    this.consecutiveErrors++;

    logger.warn(
      // Поле `code` намеренно не используем: глобальный фильтр логов
      // скрывает его как возможный код подтверждения почты. Код состояния
      // сокета не является секретом и нужен для диагностики в Render.
      { connection: this.opts.id, errorCode: code, detail: detail?.slice(0, 120) },
      'OKX сокет: сбой',
    );

    this.scheduleReconnect(code, slow);
  }

  private scheduleReconnect(reason: string, slow = false): void {
    if (this.stopped) return;

    // Один таймер на соединение. Без этой проверки close и error,
    // пришедшие подряд, заводили бы два цикла переподключения,
    // и число сокетов удваивалось бы при каждом обрыве.
    if (this.reconnectTimer) return;

    this.clearStage();
    this.clearHeartbeat();

    if (this.socket) {
      this.detach(this.socket);
      try {
        this.socket.close();
      } catch {
        // Уже закрыт.
      }
      this.socket = null;
    }

    this.setState('reconnecting');
    this.reconnects++;

    // Отказ авторизации ждёт дольше: повторять его часто —
    // способ получить блокировку ключа.
    const attempt = slow ? Math.max(this.attempt, 5) : this.attempt;
    const delay = reconnectDelay(attempt, this.random);
    this.attempt++;

    logger.debug({ connection: this.opts.id, reason, delay }, 'OKX сокет: переподключение');

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);

    this.reconnectTimer.unref?.();
  }

  // ─────────────────────────────── Мелочи ───────────────────────────────────

  private send(payload: unknown): void {
    if (!this.socket) return;
    try {
      this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
    } catch (e: any) {
      this.fail('send_failed', e?.message);
    }
  }

  private setState(s: WsState): void {
    this.state = s;
  }

  private armStage(ms: number, code: string): void {
    this.clearStage();
    this.stageTimer = setTimeout(() => this.fail(code), ms);
    this.stageTimer.unref?.();
  }

  private clearStage(): void {
    if (this.stageTimer) clearTimeout(this.stageTimer);
    this.stageTimer = null;
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearStage();
    this.clearHeartbeat();
  }

  /** Снять обработчики, чтобы закрытый сокет не будил машину состояний. */
  private detach(s: SocketLike): void {
    s.onopen = null;
    s.onmessage = null;
    s.onerror = null;
    s.onclose = null;
  }
}
