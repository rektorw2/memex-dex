import { describe, it, expect } from 'vitest';
import {
  buildWsLoginPreHash,
  wsTimestamp,
  isWsTimestampFresh,
  parseLoginReply,
  parseLiveTrade,
  LiveParseError,
  stableHash,
  planConnections,
  diffSubscriptions,
  reconnectDelay,
  MAX_ADDRESSES_PER_CONNECTION,
  RECONNECT_MAX_MS,
  WS_LOGIN_PATH,
} from './okx-ws-model.js';

describe('подпись входа в сокет', () => {
  it('строится по постоянному пути, а не по каналу', () => {
    expect(buildWsLoginPreHash('1786800000')).toBe(`1786800000GET${WS_LOGIN_PATH}`);
  });

  it('время в секундах, а не в ISO', () => {
    // Отличие от REST, на котором чаще всего спотыкаются.
    const ts = wsTimestamp(1786800000000);
    expect(ts).toBe('1786800000');
    expect(ts).not.toContain('T');
  });

  it('свежесть отметки проверяется', () => {
    const now = 1786800000000;
    expect(isWsTimestampFresh('1786800000', now)).toBe(true);
    expect(isWsTimestampFresh('1786799980', now)).toBe(true);
    expect(isWsTimestampFresh('1786799900', now)).toBe(false);
    expect(isWsTimestampFresh('чепуха', now)).toBe(false);
  });
});

describe('ответ на вход', () => {
  it('успех только при event=login и code=0', () => {
    expect(parseLoginReply({ event: 'login', code: '0' })).toEqual({ ok: true });
  });

  it('ошибка разбирается со структурой', () => {
    const r = parseLoginReply({ event: 'error', code: '60009', msg: 'Login failed' });
    expect(r).toEqual({ ok: false, code: '60009', message: 'Login failed' });
  });

  it('login с ненулевым кодом успехом не считается', () => {
    expect(parseLoginReply({ event: 'login', code: '1' })!.ok).toBe(false);
  });

  it('посторонние сообщения не путаются с ответом на вход', () => {
    expect(parseLoginReply({ event: 'subscribe' })).toBeNull();
    expect(parseLoginReply(null)).toBeNull();
  });
});

describe('разбор живого события', () => {
  const standard = {
    txHash: '5xTx', walletAddress: 'Wal1', chainIndex: '501',
    tokenContractAddress: 'Tok1', tokenSymbol: 'AAA',
    quoteTokenSymbol: 'SOL', quoteTokenAmount: '2.5',
    tokenPrice: '0.00042', marketCap: '410000',
    realizedPnlUsd: '820', tradeType: 2, tradeTime: 1786800000000,
    trackerType: 1,
  };

  // Живой пример из документации использует другие названия.
  const aliased = {
    walletAddress: 'Wal1', baseTokenChainIndex: '501',
    baseTokenContractAddress: 'Tok1', baseTokenSymbol: 'AAA',
    quoteTokenSymbol: 'SOL', quoteTokenAmount: '2.5',
    tradePrice: '0.00042', marketCap: '410000',
    tradeType: 1, tradeTime: '1786800000000',
  };

  it('стандартные названия полей', () => {
    const e = parseLiveTrade(standard);
    expect(e.chain).toBe('SOLANA');
    expect(e.side).toBe('SELL');
    expect(e.priceUsd).toBe(0.00042);
    expect(e.realizedPnlUsd).toBe(820);
  });

  it('запасные названия baseToken* и tradePrice', () => {
    // Без их поддержки половина ленты молча оказалась бы пустой.
    const e = parseLiveTrade(aliased);
    expect(e.chain).toBe('SOLANA');
    expect(e.tokenAddress).toBe('Tok1');
    expect(e.tokenSymbol).toBe('AAA');
    expect(e.priceUsd).toBe(0.00042);
    expect(e.side).toBe('BUY');
  });

  it('время принимается числом и строкой', () => {
    expect(parseLiveTrade(standard).tradedAt).toBe(1786800000000);
    expect(parseLiveTrade(aliased).tradedAt).toBe(1786800000000);
  });

  it('событие без txHash не отвергается', () => {
    // В официальном примере txHash отсутствует вовсе.
    const e = parseLiveTrade(aliased);
    expect(e.txHash).toBeNull();
    expect(e.id).toMatch(/^h:/);
    expect(e.parsingConfidence).toBeLessThan(1);
  });

  it('без txHash ключ устойчив: одно событие — один ключ', () => {
    expect(parseLiveTrade(aliased).id).toBe(parseLiveTrade(aliased).id);
  });

  it('разные события дают разные ключи', () => {
    const other = { ...aliased, quoteTokenAmount: '9.9' };
    expect(parseLiveTrade(aliased).id).not.toBe(parseLiveTrade(other).id);
  });

  it('с txHash ключ строится по нему', () => {
    expect(parseLiveTrade(standard).id).toContain('5xTx');
  });

  it('у покупки нет зафиксированного результата', () => {
    expect(parseLiveTrade({ ...standard, tradeType: 1 }).realizedPnlUsd).toBeNull();
  });

  it('нехватка обязательных полей даёт контролируемую ошибку', () => {
    // Процесс сокета от этого падать не должен.
    expect(() => parseLiveTrade({ ...standard, walletAddress: '' })).toThrow(LiveParseError);
    expect(() => parseLiveTrade({ ...standard, tradeTime: '' })).toThrow(LiveParseError);
    expect(() => parseLiveTrade({ ...standard, tradeType: 9 })).toThrow(LiveParseError);
    expect(() => parseLiveTrade({ ...standard, chainIndex: '999' })).toThrow(LiveParseError);
  });

  it('незнакомые поля не мешают', () => {
    expect(() => parseLiveTrade({ ...standard, somethingNew: 42 })).not.toThrow();
  });

  it('адрес EVM нормализуется, Solana сохраняется', () => {
    const evm = parseLiveTrade({
      ...standard, chainIndex: '1',
      walletAddress: '0xAABB', tokenContractAddress: '0xCCDD',
    });
    expect(evm.wallet).toBe('0xaabb');
    expect(parseLiveTrade(standard).wallet).toBe('Wal1');
  });
});

describe('свёртка', () => {
  it('устойчива и различает входы', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
  });
});

describe('раскладка подписок', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `addr${i}`);

  it('до двухсот адресов — одно соединение', () => {
    expect(planConnections(many(200))).toHaveLength(1);
  });

  it('свыше двухсот — несколько соединений', () => {
    // Превышение не даёт ошибки: лишние адреса просто не подписались бы.
    const plans = planConnections(many(450));
    expect(plans).toHaveLength(3);
    expect(plans[0]!.addresses).toHaveLength(MAX_ADDRESSES_PER_CONNECTION);
    expect(plans[2]!.addresses).toHaveLength(50);
  });

  it('дубликаты не подписываются дважды', () => {
    expect(planConnections(['a', 'b', 'a', 'b'])[0]!.addresses).toEqual(['a', 'b']);
  });

  it('раскладка устойчива между запусками', () => {
    // Иначе после обрыва адреса перемешались бы между соединениями.
    const a = planConnections(many(300));
    const b = planConnections([...many(300)].reverse());
    expect(a).toEqual(b);
  });

  it('пустой список даёт ноль соединений', () => {
    expect(planConnections([])).toHaveLength(0);
  });
});

describe('разница подписок', () => {
  it('добавления и удаления считаются раздельно', () => {
    const d = diffSubscriptions(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(d.toAdd).toEqual(['d']);
    expect(d.toRemove).toEqual(['a']);
  });

  it('без изменений — пусто', () => {
    const d = diffSubscriptions(['a'], ['a']);
    expect(d.toAdd).toHaveLength(0);
    expect(d.toRemove).toHaveLength(0);
  });
});

describe('задержка переподключения', () => {
  it('растёт с попытками', () => {
    const half = () => 0.5;
    expect(reconnectDelay(0, half)).toBeLessThan(reconnectDelay(3, half));
  });

  it('имеет потолок', () => {
    // Без него после суток простоя соединение не восстановится.
    expect(reconnectDelay(50, () => 1)).toBeLessThanOrEqual(RECONNECT_MAX_MS * 1.25);
  });

  it('разброс не даёт всем соединениям бить одновременно', () => {
    expect(reconnectDelay(3, () => 0)).not.toBe(reconnectDelay(3, () => 1));
  });
});
