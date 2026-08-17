/**
 * Проверка самой проверки контракта истории.
 *
 * Транспорт подделан целиком, поэтому здесь воспроизводимо всё,
 * ради чего smoke и существует: чужая форма ответа, зацикленный
 * курсор, кривое число, обрыв на второй странице.
 *
 * Отдельно и явно проверяется, что проверка ничего не пишет.
 * Smoke, пишущий в боевую базу, — это самый незаметный способ
 * испортить учёт, потому что запускают его именно тогда, когда
 * что-то уже не так.
 */

import { describe, it, expect, vi } from 'vitest';
import { runLedgerSmoke, type HistoryFetcher } from './ledger-smoke.js';
import { SMOKE_EXIT } from './exit-codes.js';

const WALLET = 'HN7cABqLq46Es1jh92dQQpjPnKUiRVMPzZ6PjMuU5FYr';
const TOKEN = 'So11111111111111111111111111111111111111112';

function row(over: Record<string, unknown> = {}) {
  return {
    type: '1',
    tokenContractAddress: TOKEN,
    tokenSymbol: 'WSOL',
    amount: '10',
    valueUsd: '1500',
    price: '150',
    time: '1750000000000',
    ...over,
  };
}

function page(rows: unknown[], cursor: string | null = null) {
  return { transactionList: rows, cursor };
}

function opts(fetch: HistoryFetcher, over: Record<string, unknown> = {}) {
  return {
    configured: true,
    wallet: WALLET,
    chain: 'SOLANA' as const,
    chainIndex: '501',
    begin: 1_749_000_000_000,
    end: 1_751_000_000_000,
    fetch,
    ...over,
  } as never;
}

/** Часы, чтобы длительность в выводе была предсказуемой. */
const fixedNow = () => 1_000;

// ─────────────────────────────── Настройка ──────────────────────────────────

describe('настройка', () => {
  it('без ключей не делает ни одного запроса', async () => {
    const fetch = vi.fn();
    const r = await runLedgerSmoke(opts(fetch as never, { configured: false }));

    expect(r.code).toBe(SMOKE_EXIT.config);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('перевёрнутый интервал — ошибка настройки, а не пустая история', async () => {
    // Пустой ответ на перевёрнутый интервал легко принять
    // за «кошелёк не торговал», и это худший из исходов.
    const fetch = vi.fn();
    const r = await runLedgerSmoke(
      opts(fetch as never, { begin: 1_751_000_000_000, end: 1_749_000_000_000 }),
    );

    expect(r.code).toBe(SMOKE_EXIT.config);
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ──────────────────────────── Разбор ответа ─────────────────────────────────

describe('разбор', () => {
  it('одна запись проходит проверку', async () => {
    const r = await runLedgerSmoke(opts(async () => page([row()]), { now: fixedNow }));

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.records).toBe(1);
    expect(r.pages).toBe(1);
  });

  it('пустая история — успех, но с оговоркой', async () => {
    // Ответ пришёл, значит связь и подпись работают. Но разбор полей
    // на нём не проверен, и объявлять ledger проверенным нельзя.
    const r = await runLedgerSmoke(opts(async () => page([]), { now: fixedNow }));

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.records).toBe(0);
    expect(r.lines).toContain(
      'DEX History contract verified; no trades found for the selected interval.',
    );
    expect(r.lines.some((l) => l.includes('не проверен'))).toBe(true);
  });

  it('чужая форма ответа даёт код контракта', async () => {
    const r = await runLedgerSmoke(opts(async () => 'совсем не то', { now: fixedNow }));

    expect(r.code).toBe(SMOKE_EXIT.contract);
  });

  it('переводы не попадают в расчёт', async () => {
    // Приход переводом — не покупка. Считать его покупкой значит
    // приписать кошельку цену входа, которой не было.
    const r = await runLedgerSmoke(
      opts(async () => page([row(), row({ type: '3' }), row({ type: '4' })]), { now: fixedNow }),
    );

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.records).toBe(1);
    expect(r.lines.some((l) => l.includes('transfer'))).toBe(true);
  });

  it('нечисловое количество — расхождение контракта', async () => {
    // Разбор не проверяет формат чисел: он хранит их строками
    // и отдаёт дальше как есть. Ловит такое именно эта проверка,
    // и в этом её смысл — иначе «много» дошло бы до расчёта
    // позиции и превратилось бы там в NaN.
    const r = await runLedgerSmoke(
      opts(async () => page([row({ amount: 'много' })]), { now: fixedNow }),
    );

    expect(r.code).toBe(SMOKE_EXIT.contract);
    expect(r.lines.some((l) => l.includes('непригодными числами'))).toBe(true);
  });

  it('нулевое количество — расхождение контракта', async () => {
    // Сделка на ноль токенов не бывает. Если она пришла, значит
    // мы читаем не то поле.
    const r = await runLedgerSmoke(opts(async () => page([row({ amount: '0' })]), { now: fixedNow }));

    expect(r.code).toBe(SMOKE_EXIT.contract);
  });

  it('время в будущем эпохи не принимается за миллисекунды', async () => {
    const r = await runLedgerSmoke(opts(async () => page([row({ time: '0' })]), { now: fixedNow }));

    // Разбор отбрасывает запись без пригодного времени.
    expect(r.records).toBe(0);
  });
});

// ──────────────────────────── Постраничность ────────────────────────────────

describe('постраничность', () => {
  it('несколько страниц собираются в один набор', async () => {
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          if (call === 1) return page([row({ time: '1750000000000' })], 'c1');
          if (call === 2) return page([row({ time: '1750000001000' })], 'c2');
          return page([]);
        },
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.records).toBe(2);
    expect(r.pages).toBe(3);
  });

  it('повтор курсора останавливает обход', async () => {
    // Без этой остановки обход крутился бы до предела страниц,
    // складывая одну и ту же страницу и считая выгрузку полной.
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          return page([row({ time: String(1_750_000_000_000 + call) })], 'одинаковый');
        },
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.pages).toBe(2);
    expect(r.coverage).toBe('truncated');
  });

  it('упор в предел страниц даёт вердикт обрезанной истории', async () => {
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          return page([row({ time: String(1_750_000_000_000 + call) })], `c${call}`);
        },
        { now: fixedNow, maxPages: 3 },
      ),
    );

    expect(r.pages).toBe(3);
    expect(r.coverage).toBe('truncated');
    expect(r.lines.some((l) => l.includes('потолок') || l.includes('предел'))).toBe(true);
  });

  it('повторная сделка на второй странице не удваивает набор', async () => {
    // Одна и та же сделка, пришедшая дважды, обязана остаться одной:
    // иначе объём позиции удвоится.
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          if (call === 1) return page([row()], 'c1');
          if (call === 2) return page([row()], 'c2');
          return page([]);
        },
        { now: fixedNow },
      ),
    );

    expect(r.records).toBe(1);
    expect(r.lines.some((l) => l.startsWith('Повторов отброшено'))).toBe(true);
  });

  it('разное написание одного числа не создаёт вторую сделку', async () => {
    // «10» и «10.000» — одно значение. Без приведения к общему виду
    // ключи разошлись бы и одна сделка стала бы двумя.
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          if (call === 1) return page([row({ amount: '10' })], 'c1');
          if (call === 2) return page([row({ amount: '10.000' })], 'c2');
          return page([]);
        },
        { now: fixedNow },
      ),
    );

    expect(r.records).toBe(1);
  });
});

// ──────────────────────────────── Отказы ────────────────────────────────────

describe('отказы', () => {
  it('обрыв сети даёт код сети и постоянную формулировку', async () => {
    const r = await runLedgerSmoke(
      opts(
        async () => {
          throw Object.assign(new Error('нет связи'), { code: 'ECONNREFUSED' });
        },
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.network);
    expect(r.lines).toContain('Live verification not performed: OKX_NETWORK_UNAVAILABLE.');
  });

  it('истечение времени отличается от обрыва', async () => {
    const r = await runLedgerSmoke(
      opts(
        async () => {
          throw Object.assign(new Error('долго'), { code: 'ETIMEDOUT' });
        },
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.timeout);
  });

  it('обрыв на второй странице не выдаёт частичный набор за полный', async () => {
    let call = 0;
    const r = await runLedgerSmoke(
      opts(
        async () => {
          call++;
          if (call === 1) return page([row()], 'c1');
          throw Object.assign(new Error('обрыв'), { code: 'ECONNRESET' });
        },
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.network);
  });

  it('в выводе нет ни payload провайдера, ни полного адреса', async () => {
    const r = await runLedgerSmoke(
      opts(
        async () => {
          throw Object.assign(new Error('OK-ACCESS-SIGN=abcdef секрет'), { code: 'ECONNREFUSED' });
        },
        { now: fixedNow },
      ),
    );

    const text = r.lines.join('\n');

    expect(text).not.toContain(WALLET);
    expect(text).not.toContain('OK-ACCESS-SIGN');
    expect(text).not.toContain('abcdef');
    expect(text).toContain('ECONNREFUSED');
  });
});

// ─────────────────── Осиротевшие продажи и полнота ──────────────────────────

describe('вердикт полноты', () => {
  it('продажа без покупки помечается и не идёт в оценку', async () => {
    // Себестоимость такой продажи неизвестна, и посчитать её
    // прибылью целиком значит наградить кошелёк за потерю истории.
    const r = await runLedgerSmoke(
      opts(
        async () =>
          page([
            row({ type: '2', amount: '10', time: '1750000000000' }),
            row({ type: '1', amount: '3', time: '1750000001000' }),
          ]),
        { now: fixedNow },
      ),
    );

    expect(r.code).toBe(SMOKE_EXIT.ok);
    expect(r.lines.some((l) => l.includes('продажей без известной покупки'))).toBe(true);
    expect(r.lines.some((l) => l.startsWith('Годных для оценки токенов: 0'))).toBe(true);
  });

  it('покупка и продажа в пределах купленного считаются полными', async () => {
    const r = await runLedgerSmoke(
      opts(
        async () =>
          page([
            row({ type: '1', amount: '10', time: '1750000000000' }),
            row({ type: '2', amount: '4', time: '1750000001000' }),
          ]),
        { now: fixedNow },
      ),
    );

    expect(r.lines.some((l) => l.startsWith('Годных для оценки токенов: 1'))).toBe(true);
    expect(r.lines.some((l) => l.includes('Полнота себестоимости: 100%'))).toBe(true);
  });

  it('канонический ключ воспроизводится из тех же полей', async () => {
    const r = await runLedgerSmoke(opts(async () => page([row()]), { now: fixedNow }));

    expect(r.lines).toContain('Канонический ключ воспроизводится.');
  });
});

// ──────────────────────────── Ничего не пишет ───────────────────────────────

describe('только чтение', () => {
  it('счётчик записей всегда ноль', async () => {
    const r = await runLedgerSmoke(opts(async () => page([row()]), { now: fixedNow }));
    expect(r.writes).toBe(0);
  });

  it('модуль проверки не импортирует ни Prisma, ни репозиторий', async () => {
    // Проверка на уровне исходника: обещание «ничего не пишем»
    // должно быть невыполнимым технически, а не только на словах.
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./ledger-smoke.ts', import.meta.url), 'utf8');

    expect(source).not.toMatch(/from '.*prisma/);
    expect(source).not.toMatch(/wallet-ledger-repo/);
    expect(source).not.toMatch(/\.create\(|\.upsert\(|\.update\(|\$executeRaw/);
  });
});
