import { describe, it, expect } from 'vitest';
import {
  unwrapOkx,
  OkxResponseError,
  parseLeaderboardRow,
  parsePortfolioOverview,
  parseTopTrader,
  parseTradeEvent,
  dedupeTrades,
  okxMillis,
  walletKey,
  isListableWalletType,
  EXCLUDED_WALLET_TYPES,
  OKX_WALLET_TYPE,
  OKX_TIMEFRAME,
  OKX_SORT,
} from './okx-wallet-model.js';

/**
 * Образцы построены по контрактам из задания. Это тестовые данные,
 * а не подмена production: в приложение они не попадают.
 */

describe('оболочка ответа', () => {
  it('успех разворачивается', () => {
    expect(unwrapOkx({ code: '0', data: [1, 2] }, '/x')).toEqual([1, 2]);
  });

  it('пустой data — законный результат, а не ошибка', () => {
    // У кошелька может не быть сделок, у сети — лидеров за период.
    expect(unwrapOkx({ code: '0', data: [] }, '/x')).toEqual([]);
    expect(unwrapOkx({ code: '0' }, '/x')).toBeNull();
  });

  it('код, отличный от нуля, даёт структурированную ошибку', () => {
    try {
      unwrapOkx({ code: '50011', msg: 'Too Many Requests' }, '/leaderboard');
      throw new Error('должно было выбросить');
    } catch (e) {
      expect(e).toBeInstanceOf(OkxResponseError);
      expect((e as OkxResponseError).code).toBe('50011');
      expect((e as OkxResponseError).endpoint).toBe('/leaderboard');
    }
  });

  it('мусор вместо ответа не проходит молча', () => {
    expect(() => unwrapOkx('строка', '/x')).toThrow(OkxResponseError);
  });
});

describe('лидерборд', () => {
  const row = {
    walletAddress: 'EN67MuVbBhFxNcbJGarqRxDhFf5Xq82ps',
    realizedPnlUsd: '125340.55',
    realizedPnlPercent: '312.4',
    winRatePercent: '64.2',
    avgBuyValueUsd: '1250.5',
    txVolume: '980000',
    txs: '412',
    lastActiveTimestamp: '1786800000000',
    walletType: 3,
    topPnlTokenList: [
      { tokenContractAddress: 'Tok1', tokenSymbol: 'AAA', tokenPnlUsd: '90000', tokenPnlPercent: '810' },
    ],
  };

  const ctx = { chain: 'SOLANA' as const, rank: 1, sortBy: OKX_SORT.pnl, timeFrame: OKX_TIMEFRAME.d7 };

  it('поля переводятся в нашу модель', () => {
    const c = parseLeaderboardRow(row, ctx)!;
    expect(c.provider.realizedPnlUsd).toBe(125340.55);
    expect(c.provider.txs).toBe(412);
    expect(c.topTokens).toHaveLength(1);
    expect(c.sourceRank).toBe(1);
  });

  it('источник значения сохраняется', () => {
    const c = parseLeaderboardRow(row, ctx)!;
    expect(c.provenance.source).toBe('okx');
    expect(c.provenance.endpoint).toContain('leaderboard');
    expect(c.provenance.timeFrame).toBe(OKX_TIMEFRAME.d7);
    expect(c.provenance.confidence).toBe(1);
  });

  it('пустые строки становятся null, а не нулём', () => {
    // «Прибыль неизвестна» и «прибыль равна нулю» — разные утверждения.
    const c = parseLeaderboardRow({ ...row, realizedPnlUsd: '', winRatePercent: '' }, ctx)!;
    expect(c.provider.realizedPnlUsd).toBeNull();
    expect(c.provider.winRatePercent).toBeNull();
    expect(c.provenance.confidence).toBeLessThan(1);
  });

  it('запись без адреса отбрасывается', () => {
    expect(parseLeaderboardRow({ ...row, walletAddress: '' }, ctx)).toBeNull();
  });

  it('адрес Solana регистр сохраняет', () => {
    const c = parseLeaderboardRow(row, ctx)!;
    expect(c.address).toBe(row.walletAddress);
  });

  it('адрес EVM приводится к нижнему регистру', () => {
    const c = parseLeaderboardRow(
      { ...row, walletAddress: '0xAbCdEf0123456789012345678901234567890123' },
      { ...ctx, chain: 'ETHEREUM' },
    )!;
    expect(c.address).toBe('0xabcdef0123456789012345678901234567890123');
    expect(c.key).toBe('1:0xabcdef0123456789012345678901234567890123');
  });
});

describe('исключение типов кошельков', () => {
  it('разработчик, инсайдер, фишинг и связанный не попадают в рейтинг', () => {
    for (const t of EXCLUDED_WALLET_TYPES) {
      expect(isListableWalletType(t)).toBe(false);
    }
  });

  it('Smart Money и кит проходят', () => {
    expect(isListableWalletType(OKX_WALLET_TYPE.smartMoney)).toBe(true);
    expect(isListableWalletType(OKX_WALLET_TYPE.whale)).toBe(true);
  });

  it('неизвестный тип не отсекается', () => {
    expect(isListableWalletType(null)).toBe(true);
  });
});

describe('сводка портфеля', () => {
  const raw = {
    realizedPnlUsd: '55000',
    top3PnlTokenSumUsd: '48000',
    top3PnlTokenPercent: '87.2',
    winRate: '58.3',
    tokenCountByPnlPercent: {
      over500Percent: '3', zeroTo500Percent: '12',
      zeroToMinus50Percent: '8', overMinus50Percent: '5',
    },
    buyTxCount: '120', buyTxVolume: '450000',
    sellTxCount: '98', sellTxVolume: '505000',
    avgBuyValueUsd: '3750', preferredMarketCap: '3',
    topPnlTokenList: [],
  };

  it('разбор вложенных счётчиков', () => {
    const m = parsePortfolioOverview(raw, OKX_TIMEFRAME.m1)!;
    expect(m.tokensOver500Pct).toBe(3);
    expect(m.tokensOverMinus50Pct).toBe(5);
    expect(m.preferredMarketCap).toBe(3);
  });

  it('ответ массивом из одного элемента разбирается так же', () => {
    expect(parsePortfolioOverview([raw], OKX_TIMEFRAME.m1)!.realizedPnlUsd).toBe(55000);
  });

  it('период сохраняется в источнике', () => {
    expect(parsePortfolioOverview(raw, OKX_TIMEFRAME.m3)!.provenance.timeFrame)
      .toBe(OKX_TIMEFRAME.m3);
  });
});

describe('держатели токена', () => {
  it('разделяет зафиксированный и незафиксированный результат', () => {
    const p = parseTopTrader(
      {
        holderWalletAddress: 'Wal1', holdAmount: '1000', holdPercent: '2.5',
        boughtAmount: '5000', avgBuyPrice: '0.001', soldAmount: '4000',
        avgSellPrice: '0.004', totalPnlUsd: '15000',
        realizedPnlUsd: '12000', unrealizedPnlUsd: '3000',
        fundingSource: 'binance',
      },
      { chain: 'SOLANA', tokenAddress: 'Tok1', tag: 3 },
    )!;
    expect(p.realizedPnlUsd).toBe(12000);
    expect(p.unrealizedPnlUsd).toBe(3000);
    expect(p.fundingSource).toBe('binance');
  });
});

describe('лента сделок', () => {
  const trade = {
    txHash: '5xTx', walletAddress: 'Wal1', chainIndex: '501',
    tokenContractAddress: 'Tok1', tokenSymbol: 'AAA',
    quoteTokenSymbol: 'SOL', quoteTokenAmount: '2.5',
    tokenPrice: '0.00042', marketCap: '410000',
    realizedPnlUsd: '820', tradeType: 2, tradeTime: '1786800000000',
  };

  it('покупка и продажа различаются', () => {
    expect(parseTradeEvent({ ...trade, tradeType: 1 })!.side).toBe('BUY');
    expect(parseTradeEvent(trade)!.side).toBe('SELL');
  });

  it('у покупки нет зафиксированного результата', () => {
    // Ноль означал бы «продал в ноль», а продажи ещё не было.
    expect(parseTradeEvent({ ...trade, tradeType: 1 })!.realizedPnlUsd).toBeNull();
  });

  it('неизвестное направление отбрасывается, а не угадывается', () => {
    expect(parseTradeEvent({ ...trade, tradeType: 7 })).toBeNull();
  });

  it('запись без времени или хеша отбрасывается', () => {
    expect(parseTradeEvent({ ...trade, tradeTime: '' })).toBeNull();
    expect(parseTradeEvent({ ...trade, txHash: '' })).toBeNull();
  });

  it('дедупликация не даёт удвоить объём при повторном запросе', () => {
    const a = parseTradeEvent(trade)!;
    const b = parseTradeEvent(trade)!;
    expect(dedupeTrades([a, b])).toHaveLength(1);
  });

  it('покупка и продажа в одной транзакции остаются разными событиями', () => {
    const buy = parseTradeEvent({ ...trade, tradeType: 1 })!;
    const sell = parseTradeEvent(trade)!;
    expect(dedupeTrades([buy, sell])).toHaveLength(2);
  });
});

describe('время', () => {
  it('разумная отметка проходит', () => {
    expect(okxMillis('1786800000000')).toBe(1786800000000);
  });

  it('ноль и мусор не превращаются в 1970 год', () => {
    // Иначе кошелёк уезжает в конец сортировки по активности,
    // выглядя при этом законно.
    expect(okxMillis('0')).toBeNull();
    expect(okxMillis('')).toBeNull();
    expect(okxMillis('123')).toBeNull();
    expect(okxMillis('99999999999999')).toBeNull();
  });
});

describe('ключ кошелька', () => {
  it('строится из индекса сети и адреса', () => {
    expect(walletKey('SOLANA', 'AbC')).toBe('501:AbC');
    expect(walletKey('BASE', '0xAA')).toBe('8453:0xaa');
  });
});
