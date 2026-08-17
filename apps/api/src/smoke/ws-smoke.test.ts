/**
 * Проверка самой проверки живого канала.
 *
 * Отсутствие сети — не основание не писать smoke, и тем более
 * не основание не проверять его. Транспорт подделывается целиком,
 * поэтому здесь воспроизводимы все исходы, включая те, которые
 * вживую встречаются раз в год: отказ входа, зависание на подписке,
 * обрыв посреди наблюдения.
 *
 * Отдельно проверяется вывод: ключ, секрет, парольная фраза, подпись
 * и полный адрес не должны появляться ни в одной строке. Вывод smoke
 * попадает в журнал сборки, а журнал сборки читают многие.
 */

import { describe, it, expect } from 'vitest';
import { runWsSmoke } from './ws-smoke.js';
import { SMOKE_EXIT } from './exit-codes.js';
import { PLATFORM_CHANNEL, ADDRESS_CHANNEL, type SocketLike } from '../services/okx-ws-client.js';

const WALLET = '0x1111111111111111111111111111111111111111';

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
          return { raw: s };
        }
      })
      .filter(Boolean);
  }
}

/**
 * Управляемое время.
 *
 * Проверка ждёт через переданный `wait`, поэтому тест решает,
 * сколько прошло и что за это время случилось в сокете. Без этого
 * пришлось бы ждать по-настоящему, и набор тестов занимал бы минуты.
 */
function harness(script: (socket: FakeSocket, tick: number) => void) {
  const sockets: FakeSocket[] = [];
  let clock = 0;
  let tick = 0;

  return {
    sockets,
    factory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
      tick++;
      const current = sockets[sockets.length - 1];
      if (current) script(current, tick);
    },
  };
}

const loginOk = { event: 'login', code: '0' };
const subAck = (channel: string) => ({ event: 'subscribe', arg: { channel }, connId: 'a4d3ae55' });

/**
 * Обычный сценарий: сокет открылся, вход принят, подписки подтверждены.
 *
 * Подтверждения приходят по одному и в том порядке, в каком клиент
 * отправляет команды: сначала общий канал, затем адреса. Подтвердить
 * команду, которая ещё не отправлена, нельзя — настоящий провайдер
 * тоже так не умеет, и тест, делающий это, проверял бы не то.
 */
function happyScript(s: FakeSocket, tick: number) {
  if (tick === 1) s.open();
  if (tick === 2) s.deliver(loginOk);
  if (tick === 3) s.deliver(subAck(PLATFORM_CHANNEL));
  if (tick === 4) s.deliver(subAck(ADDRESS_CHANNEL));
}

function base(h: ReturnType<typeof harness>, over: Record<string, unknown> = {}) {
  return {
    configured: true,
    wallet: WALLET,
    observeMs: 1_000,
    connectTimeoutMs: 5_000,
    factory: h.factory,
    now: h.now,
    wait: h.wait,
    ...over,
  } as never;
}

// ─────────────────────────────── Настройка ──────────────────────────────────

describe('настройка', () => {
  it('без ключей выходит с кодом настройки и в сеть не идёт', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h, { configured: false }));

    expect(r.code).toBe(SMOKE_EXIT.config);
    // Ни одного сокета: проверять связь без ключей бессмысленно.
    expect(h.sockets).toHaveLength(0);
  });

  it('без адреса кошелька выходит с кодом настройки', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h, { wallet: '' }));

    expect(r.code).toBe(SMOKE_EXIT.config);
    expect(h.sockets).toHaveLength(0);
  });

  it('нулевое окно наблюдения — ошибка настройки, а не мгновенный успех', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h, { observeMs: 0 }));

    expect(r.code).toBe(SMOKE_EXIT.config);
  });
});

// ──────────────────────────────── Вход ──────────────────────────────────────

describe('вход', () => {
  it('успешный вход и подтверждённая подписка дают успех', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.subscriptionConfirmed).toBe(true);
  });

  it('отклонённый вход даёт код авторизации, а не сети', async () => {
    // Разница существенная: неверный ключ не чинится ожиданием.
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '60009' });
    });

    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.auth);
    expect(r.subscriptionConfirmed).toBe(false);
  });

  it('ошибка сокета даёт код сети и постоянную формулировку', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.onerror?.();
    });

    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.network);
    expect(r.lines).toContain('Live verification not performed: OKX_NETWORK_UNAVAILABLE.');
  });

  it('сокет, который не открывается, даёт код сети', async () => {
    const h = harness(() => {
      // Ничего не происходит: провайдер недоступен.
    });

    const r = await runWsSmoke(base(h, { connectTimeoutMs: 500 }));

    expect(r.code).toBe(SMOKE_EXIT.network);
  });
});

// ────────────────────────────── Подписка ────────────────────────────────────

describe('подписка', () => {
  it('подтверждение по каналу без адреса принимается', async () => {
    // Настоящий OKX не перечисляет адреса в ответе. Ожидание
    // адреса держало бы соединение вечно неготовым при работающих
    // на деле подписках.
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver(loginOk);
      if (tick === 3) s.deliver({ event: 'subscribe', arg: { channel: PLATFORM_CHANNEL } });
      if (tick === 4) s.deliver({ event: 'subscribe', arg: { channel: ADDRESS_CHANNEL } });
    });

    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.ok);
  });

  it('вход принят, а подписка не подтверждена — расхождение контракта', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver(loginOk);
      // Подтверждения нет никогда.
    });

    const r = await runWsSmoke(base(h, { connectTimeoutMs: 800 }));

    expect(r.code).toBe(SMOKE_EXIT.contract);
    expect(r.subscriptionConfirmed).toBe(false);
  });

  it('адреса уходят одной командой списком', async () => {
    const h = harness(happyScript);
    await runWsSmoke(base(h));

    const commands = h.sockets[0]!.messages().filter(
      (m) => m.op === 'subscribe' && m.args?.[0]?.channel === ADDRESS_CHANNEL,
    );

    expect(commands).toHaveLength(1);
    expect(commands[0].args).toHaveLength(1);
  });

  it('подписка на общий канал отправляется', async () => {
    const h = harness(happyScript);
    await runWsSmoke(base(h));

    const platform = h.sockets[0]!.messages().filter(
      (m) => m.args?.[0]?.channel === PLATFORM_CHANNEL,
    );

    expect(platform).toHaveLength(1);
  });
});

// ─────────────────────────── Окно наблюдения ────────────────────────────────

describe('окно наблюдения', () => {
  it('отсутствие событий — успех с точной формулировкой', async () => {
    // На спокойном рынке отслеживаемый кошелёк может не сделать
    // ни одной сделки за минуту. Объявлять это отказом — значит
    // приучать не смотреть на результат.
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.eventsObserved).toBe(0);
    expect(r.lines).toContain(
      'Subscription verified; no market event received during observation window.',
    );
  });

  it('пришедшее событие считается и меняет вывод', async () => {
    const h = harness((s, tick) => {
      happyScript(s, tick);
      if (tick === 5) {
        s.deliver({
          arg: { channel: ADDRESS_CHANNEL },
          data: [
            {
              chainIndex: '501',
              walletAddress: WALLET,
              tokenContractAddress: 'So11111111111111111111111111111111111111112',
              tokenSymbol: 'WSOL',
              tradeType: '1',
              tokenPrice: '150.5',
              quoteTokenAmount: '10',
              quoteTokenSymbol: 'SOL',
              tradeTime: '1750000000000',
              txHash: 'sig',
            },
          ],
        });
      }
    });

    const r = await runWsSmoke(base(h, { observeMs: 2_000 }));

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.eventsObserved).toBeGreaterThan(0);
    expect(r.lines.some((l) => l.startsWith('Получено событий'))).toBe(true);
  });

  it('pong поддерживает живость соединения', async () => {
    // На живость завязан весь смысл окна наблюдения: тишина
    // дольше порога означает мёртвое соединение, а не тихий рынок.
    const h = harness((s, tick) => {
      happyScript(s, tick);
      if (tick >= 4) s.deliver('pong');
    });

    const r = await runWsSmoke(base(h, { observeMs: 2_000 }));

    expect(r.code).toBe(SMOKE_EXIT.ok);
  });

  it('обрыв во время наблюдения даёт код сети', async () => {
    const h = harness((s, tick) => {
      happyScript(s, tick);
      if (tick === 5) s.drop();
    });

    const r = await runWsSmoke(base(h, { observeMs: 3_000 }));

    expect(r.code).toBe(SMOKE_EXIT.network);
    // Подписка была подтверждена — это отдельный факт, и он
    // не отменяется последующим обрывом.
    expect(r.subscriptionConfirmed).toBe(true);
  });
});

// ────────────────────────── Очистка и вывод ─────────────────────────────────

describe('очистка ресурсов', () => {
  it('сокет закрывается при успехе', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h));

    expect(r.cleanedUp).toBe(true);
    expect(h.sockets[0]!.closed).toBe(true);
  });

  it('сокет закрывается и при отказе входа', async () => {
    // Незакрытый сокет держит таймер переподключения, и процесс
    // после проверки не завершается вовсе.
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '60009' });
    });

    const r = await runWsSmoke(base(h));

    expect(r.code).toBe(SMOKE_EXIT.auth);
    expect(h.sockets.every((s) => s.closed)).toBe(true);
  });
});

describe('вывод не содержит секретов', () => {
  it('ни ключа, ни подписи, ни полного адреса', async () => {
    const h = harness(happyScript);
    const r = await runWsSmoke(base(h));

    const text = r.lines.join('\n');

    expect(text).not.toContain(WALLET);
    expect(text).not.toMatch(/apiKey|passphrase|sign|secret/i);
    // Адрес показан сокращённо — этого достаточно, чтобы понять,
    // что проверялся тот самый кошелёк.
    expect(text).toContain('0x11…1111');
  });

  it('код отказа печатается, а тело сообщения провайдера — нет', async () => {
    const h = harness((s, tick) => {
      if (tick === 1) s.open();
      if (tick === 2) s.deliver({ event: 'login', code: '60009', msg: 'Invalid OK-ACCESS-KEY abc' });
    });

    const r = await runWsSmoke(base(h));
    const text = r.lines.join('\n');

    expect(text).toContain('auth_rejected');
    expect(text).not.toContain('OK-ACCESS-KEY');
    expect(text).not.toContain('abc');
  });
});
