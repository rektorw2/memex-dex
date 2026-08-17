/**
 * Пакеты адресов на настоящем клиенте.
 *
 * Раскладку по соединениям проверяет `planConnections`, и она
 * проверена отдельно. Здесь другое: что клиент, получив раскладку,
 * действительно отправляет её одной командой со списком, а не
 * двумястами командами подряд.
 *
 * Разница не косметическая. У OKX есть предел операций на соединение,
 * и двести отдельных подписок его выбирают. Хуже того, превышение
 * не даёт ошибки: лишние адреса просто не подписываются, и снаружи
 * это выглядит как «кошелёк перестал торговать». Ошибка, которая
 * маскируется под спокойный рынок, сама себя не покажет — её нужно
 * ловить тестом.
 *
 * Числа взяты вокруг границы: 199, 200, 201, 400, 401.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { planConnections, MAX_ADDRESSES_PER_CONNECTION } from '@memex/core';
import {
  OkxWalletWebSocketClient,
  PLATFORM_CHANNEL,
  ADDRESS_CHANNEL,
  type SocketLike,
} from './okx-ws-client.js';

class FakeSocket implements SocketLike {
  sent: string[] = [];
  closed = false;

  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onclose: ((ev?: unknown) => void) | null = null;

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }
  deliver(obj: unknown) {
    this.onmessage?.({ data: typeof obj === 'string' ? obj : JSON.stringify(obj) });
  }
  drop() {
    this.onclose?.();
  }

  messages(): any[] {
    return this.sent
      .map((s) => {
        try {
          return JSON.parse(s);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  /** Команды подписки на канал адресов. */
  addressCommands(): any[] {
    return this.messages().filter(
      (m) => m.op === 'subscribe' && m.args?.[0]?.channel === ADDRESS_CHANNEL,
    );
  }

  unsubscribeCommands(): any[] {
    return this.messages().filter((m) => m.op === 'unsubscribe');
  }

  /** Все адреса, ушедшие в подписки, из всех элементов args. */
  subscribedAddresses(): string[] {
    return this.addressCommands().flatMap((m: any) =>
      m.args.map((a: any) => a.walletAddress).filter(Boolean),
    );
  }
}

let sockets: FakeSocket[] = [];
const factory = () => {
  const s = new FakeSocket();
  sockets.push(s);
  return s;
};

const loginOk = { event: 'login', code: '0' };

/** Подтверждение в реальном виде: только канал, без адреса. */
const subAck = (channel: string) => ({
  event: 'subscribe',
  arg: { channel },
  connId: 'a4d3ae55',
});

function addresses(n: number): string[] {
  // Ширина одинаковая, чтобы сортировка в раскладке была очевидной
  // и тест не зависел от того, что «W10» меньше «W9».
  return Array.from({ length: n }, (_, i) => `0xW${String(i).padStart(4, '0')}`);
}

function makeClient(over: Record<string, unknown> = {}) {
  const events: unknown[] = [];
  const base: Record<string, unknown> = {
    id: 'batch',
    addresses: [],
    platformFeed: false,
    factory,
    onEvent: (e: unknown) => events.push(e),
    random: () => 0.5,
  };
  const c = new OkxWalletWebSocketClient({ ...base, ...over } as never);
  return { c, events };
}

function bringUp(c: OkxWalletWebSocketClient, opts: { platform?: boolean; addr?: boolean } = {}) {
  c.start();
  const s = sockets[sockets.length - 1]!;
  s.open();
  s.deliver(loginOk);
  if (opts.platform) s.deliver(subAck(PLATFORM_CHANNEL));
  if (opts.addr !== false) s.deliver(subAck(ADDRESS_CHANNEL));
  return s;
}

beforeEach(() => {
  sockets = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

// ────────────────────────────── Раскладка ───────────────────────────────────

describe('раскладка по соединениям', () => {
  const cases: Array<[number, number[]]> = [
    [0, []],
    [1, [1]],
    [199, [199]],
    [200, [200]],
    [201, [200, 1]],
    [400, [200, 200]],
    [401, [200, 200, 1]],
  ];

  for (const [count, expected] of cases) {
    it(`${count} адресов → ${expected.length || 0} соединений [${expected.join(', ')}]`, () => {
      const plans = planConnections(addresses(count));
      expect(plans.map((p) => p.addresses.length)).toEqual(expected);
    });
  }

  it('каждый адрес попадает ровно в одно соединение', () => {
    // Потерянный адрес не даёт ошибки: кошелёк просто перестаёт
    // присылать сделки, и объяснить это можно чем угодно.
    for (const count of [1, 199, 200, 201, 400, 401]) {
      const source = addresses(count);
      const placed = planConnections(source).flatMap((p) => p.addresses);

      expect(placed).toHaveLength(count);
      expect(new Set(placed).size).toBe(count);
      expect([...placed].sort()).toEqual([...source].sort());
    }
  });

  it('ни одно соединение не берёт больше двухсот', () => {
    for (const count of [201, 400, 401, 1000]) {
      const plans = planConnections(addresses(count));
      for (const p of plans) {
        expect(p.addresses.length).toBeLessThanOrEqual(MAX_ADDRESSES_PER_CONNECTION);
      }
    }
  });

  it('повторный адрес не создаёт второй подписки', () => {
    const withDupes = [...addresses(200), ...addresses(5)];
    const plans = planConnections(withDupes);

    expect(plans).toHaveLength(1);
    expect(plans[0]!.addresses).toHaveLength(200);
  });
});

// ──────────────────────── Одна команда на пакет ─────────────────────────────

describe('пакет уходит одной командой', () => {
  for (const count of [1, 199, 200]) {
    it(`${count} адресов → одна команда subscribe`, () => {
      const list = addresses(count);
      const { c } = makeClient({ addresses: list });
      const s = bringUp(c);

      const commands = s.addressCommands();

      // Именно одна: число операций считается по командам,
      // а не по числу адресов в них.
      expect(commands).toHaveLength(1);
      expect(commands[0].args).toHaveLength(count);
      expect(s.subscribedAddresses().sort()).toEqual([...list].sort());

      c.stop();
    });
  }

  it('адреса уходят массивом args, а не по одному в команде', () => {
    const { c } = makeClient({ addresses: addresses(200) });
    const s = bringUp(c);

    const commands = s.addressCommands();
    expect(commands).toHaveLength(1);
    expect(Array.isArray(commands[0].args)).toBe(true);
    expect(commands[0].args.length).toBeGreaterThan(1);

    c.stop();
  });

  it('каждый элемент args содержит канал и адрес', () => {
    const { c } = makeClient({ addresses: addresses(3) });
    const s = bringUp(c);

    for (const arg of s.addressCommands()[0].args) {
      expect(arg.channel).toBe(ADDRESS_CHANNEL);
      expect(typeof arg.walletAddress).toBe('string');
    }

    c.stop();
  });

  it('сериализованная команда на 200 адресов меньше 64 КБ', () => {
    const { c } = makeClient({ addresses: addresses(200) });
    const s = bringUp(c);

    const raw = s.sent.find((m) => m.includes(ADDRESS_CHANNEL))!;
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThan(64 * 1024);

    c.stop();
  });

  it('пустой список не порождает команды подписки на адреса', () => {
    // Подписка ни на что — это операция, потраченная впустую,
    // и подтверждения на неё не придёт.
    const { c } = makeClient({ addresses: [] });
    const s = bringUp(c, { addr: false });

    expect(s.addressCommands()).toHaveLength(0);

    c.stop();
  });
});

// ────────────────────── Подтверждение по каналу ─────────────────────────────

describe('подтверждение', () => {
  it('одного подтверждения по каналу хватает на весь пакет', () => {
    // Настоящий OKX отвечает одним событием на команду и адреса
    // в ответе не перечисляет. Ожидание подтверждения на каждый
    // адрес держало бы соединение вечно неготовым.
    const { c } = makeClient({ addresses: addresses(200) });
    const s = bringUp(c);

    expect(c.getState()).toBe('connected');
    c.stop();
  });

  it('подтверждение без walletAddress принимается', () => {
    const { c } = makeClient({ addresses: addresses(50) });
    c.start();
    const s = sockets[0]!;
    s.open();
    s.deliver(loginOk);

    // Ни одного адреса в arg — ровно так и приходит.
    s.deliver({ event: 'subscribe', arg: { channel: ADDRESS_CHANNEL }, connId: 'x' });

    expect(c.getState()).toBe('connected');
    c.stop();
  });

  it('без подтверждения соединение не считается готовым', () => {
    const { c } = makeClient({ addresses: addresses(10) });
    c.start();
    sockets[0]!.open();
    sockets[0]!.deliver(loginOk);

    expect(c.getState()).toBe('subscribing');
    c.stop();
  });
});

// ─────────────────────── Общий канал только на первом ───────────────────────

describe('общий канал KOL', () => {
  it('подключается только там, где это включено', () => {
    const first = makeClient({ addresses: addresses(200), platformFeed: true });
    bringUp(first.c, { platform: true });

    const second = makeClient({ addresses: addresses(200), platformFeed: false });
    bringUp(second.c);

    const platformOf = (s: FakeSocket) =>
      s.messages().filter((m) => m.args?.[0]?.channel === PLATFORM_CHANNEL);

    expect(platformOf(sockets[0]!)).toHaveLength(1);
    expect(platformOf(sockets[1]!)).toHaveLength(0);

    first.c.stop();
    second.c.stop();
  });

  it('раскладка на 401 адрес даёт общий канал ровно один раз', () => {
    // Три соединения, каждое со своими адресами; общая лента одна.
    // Дубль означал бы, что каждое событие рынка учтено трижды.
    const plans = planConnections(addresses(401));
    const clients = plans.map((p, i) =>
      makeClient({ addresses: p.addresses, platformFeed: i === 0 }),
    );

    for (const [i, entry] of clients.entries()) {
      bringUp(entry.c, { platform: i === 0 });
    }

    const platformCommands = sockets.flatMap((s) =>
      s.messages().filter((m) => m.args?.[0]?.channel === PLATFORM_CHANNEL),
    );

    expect(sockets).toHaveLength(3);
    expect(platformCommands).toHaveLength(1);

    for (const entry of clients) entry.c.stop();
  });
});

// ──────────────────────────── Переподключение ───────────────────────────────

describe('переподключение', () => {
  it('восстанавливает тот же пакет', () => {
    const list = addresses(200);
    const { c } = makeClient({ addresses: list });

    const first = bringUp(c);
    expect(first.subscribedAddresses().sort()).toEqual([...list].sort());

    first.drop();
    // Задержка с разбросом; множитель 0.5 задан в random.
    vi.advanceTimersByTime(10_500);

    const second = sockets[sockets.length - 1]!;
    expect(second).not.toBe(first);

    second.open();
    second.deliver(loginOk);
    second.deliver(subAck(ADDRESS_CHANNEL));

    expect(second.addressCommands()).toHaveLength(1);
    expect(second.subscribedAddresses().sort()).toEqual([...list].sort());

    c.stop();
  });

  it('после обрыва подписка не задваивается', () => {
    const { c } = makeClient({ addresses: addresses(5) });
    const first = bringUp(c);

    first.drop();
    vi.advanceTimersByTime(10_500);

    const second = sockets[sockets.length - 1]!;
    second.open();
    second.deliver(loginOk);
    second.deliver(subAck(ADDRESS_CHANNEL));

    const all = second.subscribedAddresses();
    expect(new Set(all).size).toBe(all.length);

    c.stop();
  });
});

// ──────────────────── Изменение состава на лету ─────────────────────────────

describe('изменение состава', () => {
  it('201-й адрес не трогает первые двести', () => {
    // Пересоздание всех подписок при добавлении одного адреса —
    // это двести лишних операций и окно, в котором сделки теряются.
    const list = addresses(200);
    const { c } = makeClient({ addresses: list });
    const s = bringUp(c);

    const before = s.addressCommands().length;

    c.setAddresses([...list, '0xNEW']);

    const added = s.addressCommands().slice(before);
    expect(added).toHaveLength(1);
    expect(added[0].args).toHaveLength(1);
    expect(added[0].args[0].walletAddress).toBe('0xNEW');

    // Ни одной отписки: старые двести остались на месте.
    expect(s.unsubscribeCommands()).toHaveLength(0);

    c.stop();
  });

  it('удаление адреса даёт одну отписку и ни одной новой подписки', () => {
    const list = addresses(10);
    const { c } = makeClient({ addresses: list });
    const s = bringUp(c);

    const before = s.addressCommands().length;
    c.setAddresses(list.slice(0, 9));

    expect(s.addressCommands()).toHaveLength(before);

    const removed = s.unsubscribeCommands();
    expect(removed).toHaveLength(1);
    expect(removed[0].args).toHaveLength(1);
    expect(removed[0].args[0].walletAddress).toBe(list[9]);

    c.stop();
  });

  it('повторная установка того же состава не шлёт команд', () => {
    const list = addresses(50);
    const { c } = makeClient({ addresses: list });
    const s = bringUp(c);

    const before = s.sent.length;
    c.setAddresses([...list].reverse());

    // Состав тот же, порядок другой — разницы нет, команд быть
    // не должно.
    expect(s.sent).toHaveLength(before);

    c.stop();
  });

  it('удалённый адрес не возвращается после переподключения', () => {
    const list = addresses(10);
    const { c } = makeClient({ addresses: list });
    const first = bringUp(c);

    c.setAddresses(list.slice(0, 9));
    first.drop();
    vi.advanceTimersByTime(10_500);

    const second = sockets[sockets.length - 1]!;
    second.open();
    second.deliver(loginOk);
    second.deliver(subAck(ADDRESS_CHANNEL));

    expect(second.subscribedAddresses()).not.toContain(list[9]);
    expect(second.subscribedAddresses()).toHaveLength(9);

    c.stop();
  });
});
