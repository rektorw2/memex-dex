import { describe, it, expect } from 'vitest';
import {
  aggregateFills,
  countsTowardStats,
  groupHistoryFills,
  historyTradeKey,
  liveTradeKey,
  reconcileHistoryGroup,
  RECONCILE_WINDOW_MS,
  type LiveCandidate,
  type TradeFill,
} from './economic-identity.js';
import { canonicalKey } from './okx-dex-history.js';

/**
 * Живой дефект `s8Ws…pump`.
 *
 * На странице кошелька одна покупка показывалась много раз
 * с одинаковым временем и близкими суммами, часть повторов имела
 * результат 4175×, часть не имела. Отсюда же брались Smart Score
 * 100/100 при двух настоящих сделках и средний максимум 4130×.
 *
 * Причина в том, что суммы входили в идентичность сделки.
 */

const CHAIN = 'SOLANA' as const;
const WALLET = 'GXUC1AaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaB928f';
const TOKEN = 's8WsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAApump';

/** Точное время транзакции: все переводы получают его одинаковым. */
const AT = 1_756_000_000_000;

/** Три перевода одной покупки: одно время, разные суммы. */
const FILLS: TradeFill[] = [
  { amount: '1000000', valueUsd: '12.5', price: '0.0000125', tradedAt: AT },
  { amount: '2500000', valueUsd: '31.25', price: '0.0000125', tradedAt: AT },
  { amount: '500000', valueUsd: '6.25', price: '0.0000125', tradedAt: AT },
];

const withChain = (f: TradeFill, over: Partial<{ side: 'BUY' | 'SELL'; tokenAddress: string; wallet: string }> = {}) => ({
  ...f,
  chain: CHAIN,
  wallet: WALLET,
  tokenAddress: TOKEN,
  side: 'BUY' as const,
  ...over,
});

describe('прежняя канонизация и была дефектом', () => {
  it('суммы входили в ключ, поэтому переводы расходились', () => {
    /*
     * Тест на старую реализацию: он показывает, что она обязана
     * была дробить одну покупку. Пока суммы в ключе, три перевода —
     * это три «завершённые сделки».
     */
    const keys = new Set(
      FILLS.map((f) =>
        canonicalKey({
          chain: CHAIN,
          wallet: WALLET,
          tokenAddress: TOKEN,
          side: 'BUY',
          tradedAt: f.tradedAt,
          amount: f.amount,
          valueUsd: f.valueUsd,
          price: f.price,
        }),
      ),
    );

    expect(keys.size).toBe(3);
  });

  it('другое округление давало ещё один ключ', () => {
    // Повторный импорт той же сделки создавал новую строку,
    // и дедупликация по ключу честно не срабатывала.
    const a = canonicalKey({
      chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN, side: 'BUY',
      tradedAt: AT, amount: '1000000', valueUsd: '12.5', price: '0.0000125',
    });

    const b = canonicalKey({
      chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN, side: 'BUY',
      tradedAt: AT, amount: '1000000', valueUsd: '12.50001', price: '0.00001250',
    });

    expect(a).not.toBe(b);
  });
});

describe('новая идентичность истории', () => {
  it('переводы одной транзакции дают один ключ', () => {
    const keys = new Set(
      FILLS.map((f) =>
        historyTradeKey({
          chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN,
          side: 'BUY', tradedAt: f.tradedAt,
        }),
      ),
    );

    expect(keys.size).toBe(1);
  });

  it('округление сумм на ключ не влияет', () => {
    /*
     * Главное свойство. Ни `amount`, ни `valueUsd`, ни `price`
     * в ключ не входят: провайдер меняет округление, но не меняет
     * того, какой это был перевод.
     */
    const key = historyTradeKey({
      chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN,
      side: 'BUY', tradedAt: AT,
    });

    // Ни одна из сумм трёх переводов в ключе не встречается.
    for (const f of FILLS) {
      expect(key, f.amount).not.toContain(f.amount);
      expect(key, f.valueUsd).not.toContain(f.valueUsd);
      expect(key, f.price).not.toContain(f.price);
    }
  });

  it('адрес нормализуется: регистр не создаёт вторую сделку', () => {
    const lower = historyTradeKey({
      chain: 'BNB', wallet: '0xABC', tokenAddress: '0xDEF', side: 'BUY', tradedAt: AT,
    });
    const upper = historyTradeKey({
      chain: 'BNB', wallet: '0xabc', tokenAddress: '0xdef', side: 'BUY', tradedAt: AT,
    });

    expect(lower).toBe(upper);
  });
});

describe('что объединять нельзя', () => {
  const other = (over: Parameters<typeof historyTradeKey>[0]) => historyTradeKey(over);
  const base = { chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN, side: 'BUY' as const, tradedAt: AT };

  it('разное время — разные сделки', () => {
    // Две настоящие транзакции рядом по времени объединяться
    // не должны: миллисекунда разницы означает разные транзакции.
    expect(other(base)).not.toBe(other({ ...base, tradedAt: AT + 1 }));
  });

  it('разные токены — разные сделки', () => {
    expect(other(base)).not.toBe(other({ ...base, tokenAddress: 'OtherTokenAddress1111111111' }));
  });

  it('покупка и продажа — разные сделки', () => {
    expect(other(base)).not.toBe(other({ ...base, side: 'SELL' }));
  });

  it('разные кошельки — разные сделки', () => {
    expect(other(base)).not.toBe(other({ ...base, wallet: 'AnotherWallet111111111111111' }));
  });

  it('разные сети — разные сделки', () => {
    expect(other(base)).not.toBe(other({ ...base, chain: 'BASE' }));
  });
});

describe('сложение переводов', () => {
  it('количество и стоимость складываются', () => {
    const agg = aggregateFills(FILLS);

    expect(agg.amount).toBe('4000000');
    expect(agg.valueUsd).toBe('50');
    expect(agg.fillCount).toBe(3);
    expect(agg.ambiguous).toBe(false);
  });

  it('цена — средневзвешенная по объёму', () => {
    /*
     * Брать цену первого перевода значило бы приписать всей сделке
     * случайную из нескольких. Здесь все три по одной цене,
     * поэтому результат совпадает с ней.
     */
    expect(aggregateFills(FILLS).price).toBe('0.0000125');
  });

  it('разные цены дают взвешенное среднее, а не простое', () => {
    const agg = aggregateFills([
      { amount: '100', valueUsd: '100', price: '1', tradedAt: AT },
      { amount: '900', valueUsd: '1800', price: '2', tradedAt: AT },
    ]);

    // Простое среднее дало бы 1.5; взвешенное — 1900/1000.
    expect(agg.price).toBe('1.9');
  });

  it('точность не теряется на восемнадцати знаках', () => {
    // На `number` эти разряды пропали бы молча.
    const agg = aggregateFills([
      { amount: '0.000000000000000001', valueUsd: '1', price: '1', tradedAt: AT },
      { amount: '0.000000000000000002', valueUsd: '1', price: '1', tradedAt: AT },
    ]);

    expect(agg.amount).toBe('0.000000000000000003');
  });

  it('нечисловая сумма помечает группу неоднозначной', () => {
    // Не ноль: заниженный объём выглядел бы настоящим.
    const agg = aggregateFills([
      { amount: 'нет данных', valueUsd: '1', price: '1', tradedAt: AT },
    ]);

    expect(agg.ambiguous).toBe(true);
    expect(agg.ambiguityReason).toBe('UNPARSABLE_AMOUNT');
  });

  it('нулевое количество не даёт выдуманной цены', () => {
    const agg = aggregateFills([{ amount: '0', valueUsd: '5', price: '1', tradedAt: AT }]);

    expect(agg.ambiguous).toBe(true);
    expect(agg.ambiguityReason).toBe('ZERO_TOTAL_AMOUNT');
  });

  it('пустая группа неоднозначна', () => {
    expect(aggregateFills([])).toMatchObject({ ambiguous: true, ambiguityReason: 'EMPTY_GROUP' });
  });

  it('время первого и последнего перевода сохраняется', () => {
    const agg = aggregateFills([
      { amount: '1', valueUsd: '1', price: '1', tradedAt: AT + 5 },
      { amount: '1', valueUsd: '1', price: '1', tradedAt: AT },
    ]);

    expect(agg.firstFillAt).toBe(AT);
    expect(agg.lastFillAt).toBe(AT + 5);
  });

  it('PnL провайдера складывается, но остаётся диагностикой', () => {
    const agg = aggregateFills([
      { amount: '1', valueUsd: '1', price: '1', tradedAt: AT, providerPnlUsd: '2' },
      { amount: '1', valueUsd: '1', price: '1', tradedAt: AT, providerPnlUsd: '3' },
    ]);

    expect(agg.providerPnlUsd).toBe('5');
  });
});

describe('группировка истории', () => {
  it('живой случай: три перевода — одна сделка', () => {
    /*
     * Тот самый `s8Ws…pump`. Прежде это были три «завершённые
     * сделки» с раздельными результатами: часть с 4175×, часть без.
     */
    const groups = groupHistoryFills(FILLS.map((f) => withChain(f)));

    expect(groups.size).toBe(1);
    expect([...groups.values()][0]).toHaveLength(3);
  });

  it('повторный импорт с другим округлением не добавляет группу', () => {
    const reimported = FILLS.map((f) => withChain({ ...f, valueUsd: `${f.valueUsd}00001` }));
    const groups = groupHistoryFills([...FILLS.map((f) => withChain(f)), ...reimported]);

    expect(groups.size).toBe(1);
  });

  it('покупка и продажа в одной транзакции остаются раздельными', () => {
    // Своп — это одновременно продажа одного и покупка другого.
    const groups = groupHistoryFills([
      withChain(FILLS[0]!),
      withChain(FILLS[0]!, { side: 'SELL' }),
    ]);

    expect(groups.size).toBe(2);
  });

  it('порядок поступления на результат не влияет', () => {
    const forward = groupHistoryFills(FILLS.map((f) => withChain(f)));
    const reverse = groupHistoryFills([...FILLS].reverse().map((f) => withChain(f)));

    expect([...forward.keys()]).toEqual([...reverse.keys()]);
  });
});

describe('живой ключ', () => {
  it('хеш транзакции даёт сильную идентичность', () => {
    const a = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });
    const b = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });

    expect(a).toBe(b);
  });

  it('две половины свопа не схлопываются', () => {
    const buy = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });
    const sell = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'SELL', tokenAddress: TOKEN });

    expect(buy).not.toBe(sell);
  });

  it('разные токены одной транзакции различаются', () => {
    const a = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });
    const b = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: 'Other111' });

    expect(a).not.toBe(b);
  });

  it('logIndex поддержан, но не выдуман', () => {
    // Провайдер его не отдаёт; когда отдаст — ключ станет точнее,
    // и старые ключи от этого не сломаются.
    const without = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });
    const with0 = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN, logIndex: 0 });

    expect(without).not.toBe(with0);
    expect(with0.endsWith('|0')).toBe(true);
  });

  it('живой ключ никогда не совпадает с историческим', () => {
    // Источник входит в ключ: иначе одна сделка из двух источников
    // выглядела бы одной строкой с непонятным происхождением.
    const live = liveTradeKey({ chain: CHAIN, txHash: '0xabc', side: 'BUY', tokenAddress: TOKEN });
    const history = historyTradeKey({ chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN, side: 'BUY', tradedAt: AT });

    expect(live).not.toBe(history);
  });
});

describe('сверка истории с живой лентой', () => {
  const group = { chain: CHAIN, wallet: WALLET, tokenAddress: TOKEN, side: 'BUY' as const, tradedAt: AT };

  const candidate = (over: Partial<LiveCandidate> = {}): LiveCandidate => ({
    key: 'live-1',
    chain: CHAIN,
    wallet: WALLET,
    tokenAddress: TOKEN,
    side: 'BUY',
    tradedAt: AT,
    ...over,
  });

  it('единственный кандидат принимается', () => {
    expect(reconcileHistoryGroup(group, [candidate()], new Set())).toEqual({
      kind: 'matched',
      liveKey: 'live-1',
    });
  });

  it('два кандидата — неоднозначность, а не первый попавшийся', () => {
    /*
     * Прежнее сопоставление делало `trades.find(...)` и брало первое
     * совпадение. Здесь два одинаково подходящих означают, что
     * выбрать нельзя, и группа остаётся неразрешённой.
     */
    const verdict = reconcileHistoryGroup(
      group,
      [candidate(), candidate({ key: 'live-2' })],
      new Set(),
    );

    expect(verdict).toEqual({ kind: 'ambiguous', candidates: 2 });
  });

  it('занятая live-сделка кандидатом не считается', () => {
    // Одну транзакцию нельзя применить к учёту дважды.
    const verdict = reconcileHistoryGroup(group, [candidate()], new Set(['live-1']));

    expect(verdict).toEqual({ kind: 'unmatched' });
  });

  it('занятость снимает неоднозначность', () => {
    const verdict = reconcileHistoryGroup(
      group,
      [candidate(), candidate({ key: 'live-2' })],
      new Set(['live-1']),
    );

    expect(verdict).toEqual({ kind: 'matched', liveKey: 'live-2' });
  });

  it('чужой кошелёк не подходит', () => {
    // Прежнее сопоставление сверяло только токен, сторону и окно
    // ±2 минуты — то есть могло связать события разных кошельков.
    const verdict = reconcileHistoryGroup(
      group,
      [candidate({ wallet: 'SomeoneElse11111111111111' })],
      new Set(),
    );

    expect(verdict).toEqual({ kind: 'unmatched' });
  });

  it.each([
    ['другой токен', { tokenAddress: 'Other1111111111111111111' }],
    ['другая сторона', { side: 'SELL' as const }],
    ['другая сеть', { chain: 'BASE' as const }],
  ])('%s не подходит', (_name, over) => {
    expect(reconcileHistoryGroup(group, [candidate(over)], new Set())).toEqual({
      kind: 'unmatched',
    });
  });

  it('событие за пределами окна не подходит', () => {
    const verdict = reconcileHistoryGroup(
      group,
      [candidate({ tradedAt: AT + RECONCILE_WINDOW_MS + 1 })],
      new Set(),
    );

    expect(verdict).toEqual({ kind: 'unmatched' });
  });

  it('на границе окна ещё подходит', () => {
    const verdict = reconcileHistoryGroup(
      group,
      [candidate({ tradedAt: AT + RECONCILE_WINDOW_MS })],
      new Set(),
    );

    expect(verdict).toMatchObject({ kind: 'matched' });
  });
});

describe('что идёт в статистику', () => {
  it('каноническая и подтверждённая — да', () => {
    expect(countsTowardStats('canonical')).toBe(true);
    expect(countsTowardStats('confirmed')).toBe(true);
  });

  it('неоднозначная и свёрнутая — нет', () => {
    /*
     * Неоднозначная группа исключается до выяснения, а свёрнутая
     * уже учтена в канонической. Считать их значило бы вернуть
     * ровно те дубли, ради устранения которых всё это и затевалось.
     */
    expect(countsTowardStats('ambiguous')).toBe(false);
    expect(countsTowardStats('superseded')).toBe(false);
  });
});
