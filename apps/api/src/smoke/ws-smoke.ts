/**
 * Проверка живого канала OKX на настоящем клиенте.
 *
 * Здесь сознательно нет упрощённой реализации сокета. Смысл проверки
 * в том, чтобы убедиться в работоспособности того кода, который
 * работает в бою: отдельная облегчённая версия подтвердила бы
 * работоспособность самой себя и разошлась бы с боевой при первом же
 * изменении контракта.
 *
 * Что именно проверяется, по порядку: открытие сокета, вход,
 * отправка пакета адресов одной командой, подтверждение подписки
 * по каналу (без перечисления адресов — так отвечает OKX),
 * общий канал, живость соединения в окне наблюдения.
 *
 * Отсутствие событий в окне наблюдения — не отказ. На спокойном
 * рынке отслеживаемый кошелёк может не совершить ни одной сделки
 * за минуту, и объявлять это поломкой значит приучать читать вывод
 * невнимательно.
 *
 * Наружу не печатаются ключ, секрет, парольная фраза, подпись,
 * полный адрес и тело сообщения провайдера.
 */

import {
  OkxWalletWebSocketClient,
  PLATFORM_CHANNEL,
  ADDRESS_CHANNEL,
  type SocketFactory,
} from '../services/okx-ws-client.js';
import { SMOKE_EXIT, NETWORK_UNAVAILABLE, maskAddress, type SmokeExit } from './exit-codes.js';

export interface WsSmokeOptions {
  /** Настроены ли ключи. Проверяется до всякой сети. */
  configured: boolean;
  wallet: string;
  observeMs: number;
  /** Сколько ждать готовности соединения. */
  connectTimeoutMs?: number;
  factory?: SocketFactory;
  /** Часы и ожидание вынесены, чтобы проверку можно было проверить. */
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

export interface WsSmokeResult {
  code: SmokeExit;
  /** Строки вывода. Возвращаются, чтобы тест мог убедиться в отсутствии секретов. */
  lines: string[];
  eventsObserved: number;
  subscriptionConfirmed: boolean;
  /** Соединение и таймеры закрыты. Проверяется тестом явно. */
  cleanedUp: boolean;
}

const POLL_MS = 100;
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

/**
 * Коды клиента, означающие отклонённый вход.
 *
 * Отличать их от сетевых обязательно: неверный ключ не станет верным
 * от повторной попытки, и советовать «подождите» в этом случае — это
 * отправить человека чинить не то.
 */
const AUTH_CODES = new Set(['auth_rejected', 'login_failed']);

/** Коды, означающие, что до провайдера не достучались. */
const NETWORK_CODES = new Set([
  'connect_failed',
  'socket_error',
  'connect_timeout',
  'send_failed',
]);

export async function runWsSmoke(opts: WsSmokeOptions): Promise<WsSmokeResult> {
  const lines: string[] = [];
  const log = (line: string) => {
    lines.push(line);
    opts.log?.(line);
  };

  const now = opts.now ?? (() => Date.now());
  const wait = opts.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  if (!opts.configured) {
    log('OKX provider is not configured — задайте OKX_API_KEY, OKX_API_SECRET, OKX_PASSPHRASE');
    return done(SMOKE_EXIT.config, lines, 0, false, true);
  }

  if (!opts.wallet) {
    log('Не задан OKX_SMOKE_WALLET — проверять подписку не на чем');
    return done(SMOKE_EXIT.config, lines, 0, false, true);
  }

  if (!(opts.observeMs > 0)) {
    log('OKX_SMOKE_OBSERVE_MS должен быть положительным числом');
    return done(SMOKE_EXIT.config, lines, 0, false, true);
  }

  let events = 0;
  let client: OkxWalletWebSocketClient | null = null;

  try {
    client = new OkxWalletWebSocketClient({
      id: 'smoke',
      addresses: [opts.wallet],
      platformFeed: true,
      factory: opts.factory,
      now: opts.now,
      onEvent: () => {
        events++;
      },
    });

    log(`Кошелёк: ${maskAddress(opts.wallet)}`);
    log(`Каналы: ${ADDRESS_CHANNEL}, ${PLATFORM_CHANNEL}`);

    client.start();

    // ── Готовность ────────────────────────────────────────────────
    const deadline = now() + connectTimeoutMs;
    let confirmed = false;

    while (now() < deadline) {
      const stats = client.stats();

      if (stats.state === 'connected') {
        confirmed = true;
        break;
      }

      // Вход отклонён: повторять бессмысленно, и притворяться,
      // что мы ещё ждём, — тоже.
      if (stats.lastErrorCode && AUTH_CODES.has(stats.lastErrorCode)) {
        log('Вход отклонён провайдером.');
        log(`Код: ${stats.lastErrorCode}`);
        return done(SMOKE_EXIT.auth, lines, events, false, stopSafely(client));
      }

      if (stats.lastErrorCode && NETWORK_CODES.has(stats.lastErrorCode)) {
        log(NETWORK_UNAVAILABLE);
        log(`Код: ${stats.lastErrorCode}`);
        return done(SMOKE_EXIT.network, lines, events, false, stopSafely(client));
      }

      // Подписка отправлена, а в ответ пришёл отказ по каналу:
      // это расхождение контракта, а не сеть.
      if (stats.lastErrorCode?.startsWith('subscribe_error_')) {
        log('Провайдер отклонил подписку.');
        log(`Код: ${stats.lastErrorCode}`);
        return done(SMOKE_EXIT.contract, lines, events, false, stopSafely(client));
      }

      await wait(POLL_MS);
    }

    if (!confirmed) {
      const stats = client.stats();

      // Разные стадии зависания означают разные поломки: до входа —
      // сеть, после входа — контракт подтверждения.
      if (stats.state === 'connecting') {
        log(NETWORK_UNAVAILABLE);
        return done(SMOKE_EXIT.network, lines, events, false, stopSafely(client));
      }

      if (stats.state === 'subscribing') {
        log('Подписка не подтверждена: провайдер не ответил на команду subscribe.');
        return done(SMOKE_EXIT.contract, lines, events, false, stopSafely(client));
      }

      log('Соединение не вышло в рабочее состояние за отведённое время.');
      log(`Состояние: ${stats.state}`);
      return done(SMOKE_EXIT.timeout, lines, events, false, stopSafely(client));
    }

    log('Вход выполнен, подписка подтверждена по каналу.');

    // ── Окно наблюдения ───────────────────────────────────────────
    const observeUntil = now() + opts.observeMs;
    while (now() < observeUntil) {
      if (client.stats().state === 'reconnecting') {
        log('Соединение оборвалось во время наблюдения.');
        return done(SMOKE_EXIT.network, lines, events, true, stopSafely(client));
      }
      await wait(POLL_MS);
    }

    // Живость держится на ping/pong: тишина дольше порога переводит
    // соединение в переподключение, и здесь мы это заметили бы.
    const healthy = client.isHealthy();
    const stats = client.stats();

    log(`Наблюдение: ${Math.round(opts.observeMs / 1000)} с`);
    log(`Переподключений за время проверки: ${stats.reconnects}`);

    if (events === 0) {
      // Ровно та формулировка, которая не даёт принять спокойный
      // рынок за поломку.
      log('Subscription verified; no market event received during observation window.');
    } else {
      log(`Получено событий: ${events}`);
    }

    if (!healthy) {
      log('Соединение осталось открытым, но данных не поступало дольше порога живости.');
      return done(SMOKE_EXIT.timeout, lines, events, true, stopSafely(client));
    }

    return done(SMOKE_EXIT.ok, lines, events, true, stopSafely(client));
  } catch (e: any) {
    // Только код. Объект ошибки транспорта содержит заголовки
    // запроса, а в них подпись и ключ.
    log('Проверка прервалась ошибкой.');
    log(`Код: ${e?.code ?? e?.name ?? 'unknown'}`);
    return done(SMOKE_EXIT.network, lines, events, false, client ? stopSafely(client) : true);
  } finally {
    // Двойная остановка безопасна и обязательна: сокет, оставленный
    // открытым, держит соединение и таймер переподключения, а процесс
    // после этого не завершается.
    client?.stop();
  }
}

function stopSafely(client: OkxWalletWebSocketClient): boolean {
  try {
    client.stop();
    return true;
  } catch {
    return false;
  }
}

function done(
  code: SmokeExit,
  lines: string[],
  eventsObserved: number,
  subscriptionConfirmed: boolean,
  cleanedUp: boolean,
): WsSmokeResult {
  return { code, lines, eventsObserved, subscriptionConfirmed, cleanedUp };
}
