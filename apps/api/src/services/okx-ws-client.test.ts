import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OkxWalletWebSocketClient,
  PLATFORM_CHANNEL,
  ADDRESS_CHANNEL,
  type SocketLike,
} from './okx-ws-client.js';
import { OKX_SIGNAL_CHANNEL } from '@memex/core';

/**
 * Управляемая подделка сокета.
 *
 * Без неё проверить переподключение, зависание и восстановление
 * подписок можно было бы только вживую — то есть никогда.
 */
class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;

  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  send(data: string) { this.sent.push(data); }
  close() { this.closed = true; }

  /** Помощники, которыми управляет тест. */
  open() { this.onopen?.(); }
  deliver(obj: unknown) { this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) }); }
  drop() { this.onclose?.(); }

  ops(): string[] {
    return this.sent.map((s) => { try { return JSON.parse(s).op ?? s; } catch { return s; } });
  }
  /**
   * Адреса из всех команд подписки.
   *
   * Читается весь массив args, а не первый элемент: по контракту
   * OKX адреса уходят одной командой списком, и двести отдельных
   * запросов выбрали бы лимит операций на соединение.
   */
  subscribedAddresses(): string[] {
    return this.sent
      .map((s) => { try { return JSON.parse(s); } catch { return null; } })
      .filter((m) => m?.op === 'subscribe' && Array.isArray(m?.args))
      .flatMap((m) => m.args.map((a: any) => a?.walletAddress).filter(Boolean));
  }
}

let sockets: FakeSocket[] = [];
const factory = () => { const s = new FakeSocket(); sockets.push(s); return s; };

const loginOk = { event: 'login', code: '0' };
/**
 * Подтверждение подписки в том виде, в каком его шлёт OKX:
 * только канал, без адреса и без кода.
 */
const subAck = (channel: string) => ({
  event: 'subscribe', arg: { channel }, connId: 'a4d3ae55',
});

function makeClient(over: Partial<Parameters<typeof mk>[0]> = {}) { return mk(over as never); }
function mk(over: any) {
  const events: any[] = [];
  const signals: any[] = [];
  const rejected: string[] = [];
  const c = new OkxWalletWebSocketClient({
    id: 'test', addresses: [], platformFeed: true, factory,
    onEvent: (e) => events.push(e),
    onSignal: (e) => signals.push(e),
    onRejected: (r) => rejected.push(r),
    random: () => 0.5,
    ...over,
  });
  return { c, events, signals, rejected };
}

/**
 * Довести соединение до готовности.
 *
 * Сокет берётся после start(), а не до: до запуска его ещё
 * не существует — фабрика вызывается внутри клиента.
 */
function bringUp(c: OkxWalletWebSocketClient, addresses: string[] = []): FakeSocket {
  c.start();
  const s = sockets[sockets.length - 1]!;
  s.open();
  s.deliver(loginOk);
  s.deliver(subAck(PLATFORM_CHANNEL));
  if (addresses.length > 0) s.deliver(subAck(ADDRESS_CHANNEL));
  return s;
}

beforeEach(() => { sockets = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('машина состояний', () => {
  it('открытие сокета само по себе не даёт готовности', () => {
    // Сокет может быть открыт, вход отклонён, данных нет —
    // и снаружи это неотличимо от спокойного рынка.
    const { c } = makeClient();
    c.start();
    expect(c.getState()).toBe('connecting');
    sockets[0]!.open();
    expect(c.getState()).toBe('authenticating');
    expect(c.getState()).not.toBe('connected');
    c.stop();
  });

  it('вход без подтверждения подписок не даёт готовности', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    c.start();
    sockets[0]!.open();
    sockets[0]!.deliver(loginOk);
    expect(c.getState()).toBe('subscribing');
    c.stop();
  });

  it('готовность наступает после входа и всех подписок', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    bringUp(c, ['W1']);
    expect(c.getState()).toBe('connected');
    c.stop();
  });

  it('подписка отправляется только после успешного входа', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    c.start();
    sockets[0]!.open();
    expect(sockets[0]!.ops()).toEqual(['login']);
    sockets[0]!.deliver(loginOk);
    expect(sockets[0]!.ops()).toContain('subscribe');
    c.stop();
  });

  it('превышение времени входа уводит в переподключение', () => {
    const { c } = makeClient();
    c.start();
    sockets[0]!.open();
    // Ровно за порог входа, но до срабатывания задержки повтора:
    // иначе машина успеет уйти в connecting, и проверка увидит
    // не то состояние, которое проверяет.
    vi.advanceTimersByTime(10_500);
    expect(c.getState()).toBe('reconnecting');
    c.stop();
  });

  it('превышение времени подписки уводит в переподключение', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    c.start();
    sockets[0]!.open();
    sockets[0]!.deliver(loginOk);
    vi.advanceTimersByTime(15_500);
    expect(c.getState()).toBe('reconnecting');
    c.stop();
  });
});

describe('переподключение', () => {
  it('после обрыва соединение поднимается заново', () => {
    const { c } = makeClient();
    bringUp(c);
    sockets[0]!.drop();
    expect(c.getState()).toBe('reconnecting');
    vi.advanceTimersByTime(120_000);
    expect(sockets.length).toBeGreaterThan(1);
    c.stop();
  });

  it('после stop() переподключения не происходит', () => {
    const { c } = makeClient();
    bringUp(c);
    c.stop();
    const before = sockets.length;
    vi.advanceTimersByTime(300_000);
    expect(sockets.length).toBe(before);
  });

  it('close и error подряд не заводят два цикла', () => {
    // Иначе число сокетов удваивалось бы при каждом обрыве.
    const { c } = makeClient();
    bringUp(c);
    const s = sockets[0]!;
    s.onerror?.();
    s.onclose?.();
    const before = sockets.length;

    // Проверяется первый цикл: два события подряд должны дать
    // одно новое соединение, а не два. Дальше пойдут обычные
    // повторы, и считать их здесь нечего.
    vi.advanceTimersByTime(2_000);
    expect(sockets.length).toBe(before + 1);
    c.stop();
  });

  it('подписки восстанавливаются после обрыва', () => {
    const { c } = makeClient({ addresses: ['W1', 'W2'] });
    bringUp(c, ['W1', 'W2']);
    sockets[0]!.drop();
    vi.advanceTimersByTime(120_000);

    const fresh = sockets[sockets.length - 1]!;
    fresh.open();
    fresh.deliver(loginOk);
    fresh.deliver(subAck(PLATFORM_CHANNEL));
    expect(fresh.subscribedAddresses().sort()).toEqual(['W1', 'W2']);
    c.stop();
  });

  it('изменения списка во время обрыва не теряются', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    bringUp(c, ['W1']);
    sockets[0]!.drop();
    c.setAddresses(['W1', 'W2']);
    vi.advanceTimersByTime(120_000);

    const fresh = sockets[sockets.length - 1]!;
    fresh.open();
    fresh.deliver(loginOk);
    fresh.deliver(subAck(PLATFORM_CHANNEL));
    expect(fresh.subscribedAddresses().sort()).toEqual(['W1', 'W2']);
    c.stop();
  });

  it('отказ авторизации ждёт дольше обычного обрыва', () => {
    const auth = makeClient();
    auth.c.start(); sockets[0]!.open();
    sockets[0]!.deliver({ event: 'error', code: '60009', msg: 'Login failed' });

    const plain = makeClient();
    plain.c.start(); sockets[1]!.open(); sockets[1]!.deliver(loginOk);
    sockets[1]!.deliver(subAck(PLATFORM_CHANNEL));
    sockets[1]!.drop();

    // Обычный обрыв поднимается быстро, отказ ключа — нет.
    vi.advanceTimersByTime(5_000);
    const afterShort = sockets.length;
    vi.advanceTimersByTime(120_000);
    expect(sockets.length).toBeGreaterThan(afterShort);

    auth.c.stop(); plain.c.stop();
  });
});

describe('подписки на лету', () => {
  it('добавление адреса не пересоздаёт соединение', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    bringUp(c, ['W1']);
    const before = sockets.length;
    c.setAddresses(['W1', 'W2']);
    expect(sockets.length).toBe(before);
    expect(sockets[0]!.subscribedAddresses()).toContain('W2');
    c.stop();
  });

  it('удаление адреса отправляет отписку', () => {
    const { c } = makeClient({ addresses: ['W1', 'W2'] });
    bringUp(c, ['W1', 'W2']);
    c.setAddresses(['W1']);
    expect(sockets[0]!.ops()).toContain('unsubscribe');
    c.stop();
  });
});

describe('живость', () => {
  it('молчание дольше порога рвёт соединение', () => {
    // Сокет открыт, данных нет — сам такое не закрывается,
    // и без принудительного разрыва источник висит мёртвым.
    const { c } = makeClient();
    bringUp(c);
    expect(c.isHealthy()).toBe(true);
    vi.advanceTimersByTime(200_000);
    expect(c.getState()).not.toBe('connected');
    c.stop();
  });

  it('heartbeat отправляется', () => {
    const { c } = makeClient();
    bringUp(c);
    const before = sockets[0]!.sent.length;
    vi.advanceTimersByTime(25_000);
    expect(sockets[0]!.sent.length).toBeGreaterThan(before);
    c.stop();
  });

  it('ответ pong не считается событием', () => {
    const { c, rejected } = makeClient();
    bringUp(c);
    sockets[0]!.deliver('pong');
    expect(rejected).toHaveLength(0);
    c.stop();
  });
});

describe('события', () => {
  const trade = {
    txHash: '5xTx', walletAddress: 'Wal1', chainIndex: '501',
    tokenContractAddress: 'Tok1', tokenSymbol: 'AAA',
    quoteTokenSymbol: 'SOL', quoteTokenAmount: '2.5',
    tokenPrice: '0.00042', marketCap: '410000',
    tradeType: 1, tradeTime: 1786800000000,
  };

  it('разбирается и передаётся наружу', () => {
    const { c, events } = makeClient();
    bringUp(c);
    sockets[0]!.deliver({ arg: { channel: PLATFORM_CHANNEL }, data: [trade] });
    expect(events).toHaveLength(1);
    expect(events[0].side).toBe('BUY');
    c.stop();
  });

  it('запасные названия полей тоже разбираются', () => {
    const { c, events } = makeClient();
    bringUp(c);
    sockets[0]!.deliver({
      data: [{
        walletAddress: 'Wal1', baseTokenChainIndex: '501',
        baseTokenContractAddress: 'Tok1', baseTokenSymbol: 'AAA',
        tradePrice: '0.001', tradeType: 2, tradeTime: '1786800000000',
      }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].priceUsd).toBe(0.001);
    c.stop();
  });

  it('кривое событие не роняет соединение', () => {
    const { c, events, rejected } = makeClient();
    bringUp(c);
    sockets[0]!.deliver({ data: [{ walletAddress: '' }, trade] });
    // Первое отброшено, второе разобрано — соединение живо.
    expect(rejected).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(c.getState()).toBe('connected');
    c.stop();
  });

  it('битый JSON не роняет соединение', () => {
    const { c, rejected } = makeClient();
    bringUp(c);
    sockets[0]!.deliver('{не json');
    expect(rejected).toContain('malformed_json');
    expect(c.getState()).toBe('connected');
    c.stop();
  });
});

describe('OKX Signal', () => {
  it('подписывает все сети одной командой и принимает событие сразу', () => {
    const { c, signals } = makeClient({
      platformFeed: false,
      signalChains: ['501', '1', '501'],
    });

    c.start();
    const socket = sockets[0]!;
    socket.open();
    socket.deliver(loginOk);

    const subscribe = socket.sent
      .map((text) => JSON.parse(text))
      .find((message) => message.op === 'subscribe');

    expect(subscribe.args).toEqual([
      { channel: OKX_SIGNAL_CHANNEL, chainIndex: '501' },
      { channel: OKX_SIGNAL_CHANNEL, chainIndex: '1' },
    ]);

    socket.deliver(subAck(OKX_SIGNAL_CHANNEL));
    expect(c.getState()).toBe('connected');

    socket.deliver({
      arg: {
        channel: OKX_SIGNAL_CHANNEL,
        chainIndex: '501',
        timestamp: '1774364940575',
        token: {
          tokenAddress: 'FN9ZSeNDdPV6bBF9DeDYxvqYK4JvFKeF7DBrhGGXJZ3Q',
          symbol: 'GEM',
          name: 'Gem',
          marketCapUsd: '64000',
        },
        price: '0.0001',
        walletType: '1,3',
        triggerWalletCount: '4',
        amountUsd: '1200',
      },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      chain: 'SOLANA',
      symbol: 'GEM',
      walletTypes: ['smart_money', 'whale'],
    });
    c.stop();
  });
});

describe('секреты', () => {
  it('состояние не содержит ключей', () => {
    const { c } = makeClient();
    bringUp(c);
    const dump = JSON.stringify(c.stats());
    expect(dump).not.toMatch(/apiKey|passphrase|sign|secret/i);
    c.stop();
  });
});

describe('остановка', () => {
  it('таймеры не остаются', () => {
    const { c } = makeClient({ addresses: ['W1'] });
    bringUp(c, ['W1']);
    c.stop();
    expect(sockets[0]!.closed).toBe(true);
    const before = sockets.length;
    vi.advanceTimersByTime(600_000);
    expect(sockets.length).toBe(before);
  });
});
