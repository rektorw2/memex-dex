/**
 * Общий ключ живого события.
 *
 * Проверяет одну конкретную поломку, которую иначе не поймать: сокет
 * и опрос описывают одну сделку по-разному — первый называет сеть
 * числовым индексом и направление числом, второй именем сети
 * и словом. Пока ключ строился в каждом месте по-своему, одна сделка
 * получала два ключа, и защита от повторной записи между источниками
 * не работала совсем.
 *
 * Заметить это трудно: пока сокет лежит, повторов нет — источник
 * один. Они появляются ровно тогда, когда сокет поднимается, и тогда
 * каждая сделка записывается дважды, а очередь пересчёта растёт
 * без причины.
 */

import { describe, it, expect } from 'vitest';
import { liveEventId, parseLiveTrade } from './okx-ws-model.js';

const WALLET = '0xbd57a3c017b340aec66c0762e5ac626363df79bc';
const TOKEN = '0x20b53da3b3f059fa472dc62025e33426ec197777';
const TX = '0xc0132603531cb9178b99334be4a79f8b9add5d716f54202b288dfc79eaff539b';

describe('ключ одинаков у обоих источников', () => {
  it('сообщение сокета и запись опроса дают один ключ', () => {
    // Сокет: сеть числом, направление числом.
    const fromSocket = parseLiveTrade({
      chainIndex: '56',
      walletAddress: WALLET,
      tokenContractAddress: TOKEN,
      tradeType: '1',
      tradeTime: '1786931054000',
      txHash: TX,
      quoteTokenAmount: '0.2968',
    });

    // Опрос: сеть именем, направление словом.
    const fromRest = liveEventId({
      chain: 'BNB',
      wallet: WALLET,
      tokenAddress: TOKEN,
      side: 'BUY',
      txHash: TX,
      tradedAt: 1_786_931_054_000,
      quoteAmount: 0.2968,
    });

    expect(fromSocket.id).toBe(fromRest);
  });

  it('разный регистр адреса не даёт второй записи', () => {
    const a = liveEventId({
      chain: 'BNB',
      wallet: WALLET.toUpperCase(),
      tokenAddress: TOKEN.toUpperCase(),
      side: 'BUY',
      txHash: TX,
    });

    const b = liveEventId({
      chain: 'BNB',
      wallet: WALLET,
      tokenAddress: TOKEN,
      side: 'BUY',
      txHash: TX,
    });

    expect(a).toBe(b);
  });

  it('покупка и продажа в одной транзакции различаются', () => {
    // Обмен даёт две ноги в одном хеше; склеив их, мы потеряли бы
    // половину сделки.
    const buy = liveEventId({ chain: 'BNB', wallet: WALLET, tokenAddress: TOKEN, side: 'BUY', txHash: TX });
    const sell = liveEventId({ chain: 'BNB', wallet: WALLET, tokenAddress: TOKEN, side: 'SELL', txHash: TX });

    expect(buy).not.toBe(sell);
  });

  it('одна транзакция в разных сетях — разные события', () => {
    const bnb = liveEventId({ chain: 'BNB', wallet: WALLET, tokenAddress: TOKEN, side: 'BUY', txHash: TX });
    const eth = liveEventId({ chain: 'ETHEREUM', wallet: WALLET, tokenAddress: TOKEN, side: 'BUY', txHash: TX });

    expect(bnb).not.toBe(eth);
  });
});

describe('без хеша транзакции', () => {
  it('ключ строится из содержания и повторяем', () => {
    const args = {
      chain: 'SOLANA' as const,
      wallet: 'HN7cABqLq46Es1jh92dQQpjPnKUiRVMPzZ6PjMuU5FYr',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      side: 'SELL' as const,
      tradedAt: 1_786_931_054_000,
      quoteAmount: 12.5,
    };

    expect(liveEventId(args)).toBe(liveEventId(args));
    expect(liveEventId(args)).toMatch(/^h:/);
  });

  it('разное время даёт разные ключи', () => {
    const base = {
      chain: 'SOLANA' as const,
      wallet: 'HN7cABqLq46Es1jh92dQQpjPnKUiRVMPzZ6PjMuU5FYr',
      tokenAddress: 'So11111111111111111111111111111111111111112',
      side: 'BUY' as const,
      quoteAmount: 1,
    };

    expect(liveEventId({ ...base, tradedAt: 1 })).not.toBe(
      liveEventId({ ...base, tradedAt: 2 }),
    );
  });

  it('Solana не теряет регистр адреса', () => {
    // Приведение сделало бы адрес другим кошельком.
    const upper = 'HN7CABQLQ46ES1JH92DQQPJPNKUIRVMPZZ6PJMUU5FYR';
    const mixed = 'HN7cABqLq46Es1jh92dQQpjPnKUiRVMPzZ6PjMuU5FYr';

    expect(
      liveEventId({ chain: 'SOLANA', wallet: upper, tokenAddress: 'X', side: 'BUY', txHash: 'sig' }),
    ).not.toBe(
      liveEventId({ chain: 'SOLANA', wallet: mixed, tokenAddress: 'X', side: 'BUY', txHash: 'sig' }),
    );
  });
});
