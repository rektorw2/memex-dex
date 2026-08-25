import { describe, it, expect } from 'vitest';
import { parseHistoryPage, foldFillsIntoTrades, type CanonicalTrade } from './okx-dex-history.js';

/**
 * Живой дефект `s8Ws…pump`, воспроизведённый на настоящем разборе.
 *
 * На странице кошелька одна покупка повторялась много раз
 * с одинаковым временем и близкими суммами; часть повторов имела
 * результат 4175×, часть не имела. Оттуда же брались Smart Score
 * 100/100 при двух настоящих сделках и средний максимум 4130×.
 *
 * Здесь проверяется не пересказ правила, а `parseHistoryPage` —
 * та функция, которая и создавала лишние записи.
 */

const CHAIN = 'SOLANA' as const;
const WALLET = 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f';
const TOKEN = 's8WsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';

/** Точное время транзакции: провайдер даёт его всем переводам одно. */
const AT = 1_756_000_000_000;

const row = (over: Record<string, unknown> = {}) => ({
  type: '1',
  chainIndex: '501',
  tokenContractAddress: TOKEN,
  tokenSymbol: 'PUMP',
  amount: '1000000',
  valueUsd: '12.5',
  price: '0.0000125',
  marketCap: '41000',
  pnlUsd: null,
  time: String(AT),
  ...over,
});

const page = (rows: Record<string, unknown>[]) =>
  parseHistoryPage({ transactionList: rows, cursor: null }, { chain: CHAIN, wallet: WALLET });

describe('живой случай: три перевода одной покупки', () => {
  /** Ровно то, что показывала страница: одно время, разные суммы. */
  const FILLS = [
    row({ amount: '1000000', valueUsd: '12.5' }),
    row({ amount: '2500000', valueUsd: '31.25' }),
    row({ amount: '500000', valueUsd: '6.25' }),
  ];

  it('страница отдаёт одну экономическую сделку, а не три', () => {
    expect(page(FILLS).trades).toHaveLength(1);
  });

  it('суммы сложены целиком', () => {
    const [t] = page(FILLS).trades;

    expect(t!.amount).toBe('4000000');
    expect(t!.valueUsd).toBe('50');
  });

  it('видно, что сделка собрана из трёх переводов', () => {
    // Число переводов не прячется: это честный ответ на вопрос
    // «почему сумма больше, чем в любой отдельной строке».
    expect(page(FILLS).trades[0]!.fillCount).toBe(3);
  });

  it('время первого и последнего перевода сохранено', () => {
    const [t] = page(FILLS).trades;

    expect(t!.firstFillAt).toBe(AT);
    expect(t!.lastFillAt).toBe(AT);
  });

  it('группа не помечена неоднозначной: сложилась чисто', () => {
    expect(page(FILLS).trades[0]!.ambiguous).toBe(false);
  });

  it('источник записан явно', () => {
    expect(page(FILLS).trades[0]!.source).toBe('okx_dex_history');
  });
});

describe('повторный импорт ничего не добавляет', () => {
  it('другое округление даёт тот же ключ', () => {
    /*
     * Прежний ключ содержал суммы, поэтому изменение округления
     * на стороне провайдера создавало новую строку, а дедупликация
     * по ключу честно не срабатывала.
     */
    const first = page([row()]).trades[0]!;
    const second = page([row({ valueUsd: '12.500000', price: '0.00001250' })]).trades[0]!;

    expect(second.key).toBe(first.key);
  });

  it('повторная страница не увеличивает число сделок', () => {
    const rows = [row({ amount: '1000000' }), row({ amount: '2500000' })];
    const reimported = [
      row({ amount: '1000000.0', valueUsd: '12.5000' }),
      row({ amount: '2500000.0', valueUsd: '31.2500' }),
    ];

    const folded = foldFillsIntoTrades([
      ...page(rows).trades,
      ...page(reimported).trades,
    ] as CanonicalTrade[]);

    expect(folded).toHaveLength(1);
  });
});

describe('что склеивать нельзя', () => {
  it('две транзакции рядом по времени остаются раздельными', () => {
    // Миллисекунда разницы — разные транзакции.
    const trades = page([row(), row({ time: String(AT + 1) })]).trades;

    expect(trades).toHaveLength(2);
  });

  it('разные токены не объединяются', () => {
    const trades = page([
      row(),
      row({ tokenContractAddress: 'OtherTokenAddress11111111111111111111111111' }),
    ]).trades;

    expect(trades).toHaveLength(2);
  });

  it('покупка и продажа не объединяются', () => {
    // Своп — это одновременно продажа одного и покупка другого.
    const trades = page([row(), row({ type: '2' })]).trades;

    expect(trades).toHaveLength(2);
    expect(new Set(trades.map((t) => t.side))).toEqual(new Set(['BUY', 'SELL']));
  });

  it('переводы в расчёт не идут вовсе', () => {
    // Приход переводом — не покупка: цены входа у него не было.
    const result = page([row({ type: '3' }), row({ type: '4' })]);

    expect(result.trades).toHaveLength(0);
    expect(result.skipped.transfer).toBe(2);
  });
});

describe('порядок и устойчивость', () => {
  it('обратный порядок страниц даёт тот же результат', () => {
    const rows = [
      row({ amount: '1000000', valueUsd: '12.5' }),
      row({ amount: '2500000', valueUsd: '31.25' }),
    ];

    const forward = page(rows).trades[0]!;
    const backward = page([...rows].reverse()).trades[0]!;

    expect(backward.key).toBe(forward.key);
    expect(backward.amount).toBe(forward.amount);
    expect(backward.valueUsd).toBe(forward.valueUsd);
  });

  it('одиночная сделка проходит без изменений', () => {
    const [t] = page([row()]).trades;

    expect(t!.amount).toBe('1000000');
    expect(t!.fillCount).toBe(1);
  });

  it('пустая страница остаётся пустой', () => {
    expect(page([]).trades).toEqual([]);
  });
});

describe('статистика больше не раздувается', () => {
  it('пять переводов двух транзакций дают две сделки', () => {
    /*
     * Тот самый счёт с живой страницы: «две завершённые сделки
     * из пяти». Пять строк провайдера — это два экономических
     * события, и считать их пятью значило бы получить и лишние
     * `wins2x`, и завышенный средний максимум.
     */
    const trades = page([
      row({ amount: '1000000' }),
      row({ amount: '2500000' }),
      row({ amount: '500000' }),
      row({ type: '2', time: String(AT + 60_000), amount: '4000000', valueUsd: '210' }),
      row({ type: '2', time: String(AT + 60_000), amount: '1000000', valueUsd: '52.5' }),
    ]).trades;

    expect(trades).toHaveLength(2);
    expect(trades.filter((t) => t.side === 'BUY')).toHaveLength(1);
    expect(trades.filter((t) => t.side === 'SELL')).toHaveLength(1);
  });

  it('объём продажи складывается целиком', () => {
    const trades = page([
      row({ type: '2', amount: '4000000', valueUsd: '210' }),
      row({ type: '2', amount: '1000000', valueUsd: '52.5' }),
    ]).trades;

    expect(trades[0]!.amount).toBe('5000000');
    expect(trades[0]!.valueUsd).toBe('262.5');
  });
});
