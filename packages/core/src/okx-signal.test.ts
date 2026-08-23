import { describe, expect, it } from 'vitest';
import {
  OKX_SIGNAL_CHANNEL,
  parseOkxSignal,
  parseOkxSignalMessage,
  parseSignalWalletTypes,
} from './okx-signal.js';

const row = {
  timestamp: '1774364940575',
  chainIndex: '501',
  token: {
    tokenAddress: 'FN9ZSeNDdPV6bBF9DeDYxvqYK4JvFKeF7DBrhGGXJZ3Q',
    symbol: 'VanCleef',
    name: 'Van Cleef Memes',
    logo: 'https://static.okx.com/token.webp',
    marketCapUsd: '64466.67',
    holders: '445',
    top10HolderPercent: '17.9547',
  },
  price: '0.00012249',
  walletType: '1,2,3',
  triggerWalletCount: '3',
  triggerWalletAddress: 'wallet-b,wallet-a',
  amountUsd: '669.45',
  soldRatioPercent: '64.29',
};

describe('OKX Signal — REST', () => {
  it('разбирает официальный ответ без потери времени и метрик', () => {
    const signal = parseOkxSignal(row)!;

    expect(signal.chain).toBe('SOLANA');
    expect(signal.symbol).toBe('VanCleef');
    expect(signal.marketCapUsd).toBeCloseTo(64_466.67);
    expect(signal.walletTypes).toEqual(['smart_money', 'kol', 'whale']);
    expect(signal.signaledAt.toISOString()).toBe('2026-03-24T15:09:00.575Z');
    expect(signal.providerKey).toMatch(/^okx-signal:/);
  });

  it('одинаковое событие получает одинаковый ключ', () => {
    expect(parseOkxSignal(row)?.providerKey).toBe(parseOkxSignal({ ...row })?.providerKey);
    expect(parseOkxSignal(row)?.providerKey).toBe(
      parseOkxSignal({ ...row, triggerWalletAddress: 'wallet-a,wallet-b' })?.providerKey,
    );
  });

  it('не склеивает две покупки разных кошельков в один сигнал', () => {
    expect(parseOkxSignal(row)?.providerKey).not.toBe(
      parseOkxSignal({ ...row, triggerWalletAddress: 'wallet-c,wallet-d' })?.providerKey,
    );
  });

  it('запись без сети, адреса или времени отвергается', () => {
    expect(parseOkxSignal({ ...row, chainIndex: '999' })).toBeNull();
    expect(parseOkxSignal({ ...row, token: {} })).toBeNull();
    expect(parseOkxSignal({ ...row, timestamp: '' })).toBeNull();
  });
});

describe('OKX Signal — WebSocket', () => {
  it('понимает форму официального push-примера', () => {
    const signals = parseOkxSignalMessage({
      arg: {
        channel: OKX_SIGNAL_CHANNEL,
        chainIndex: '501',
        timestamp: row.timestamp,
        token: row.token,
        price: row.price,
        walletType: '1,2',
        triggerWalletCount: '3',
        amountUsd: row.amountUsd,
        soldRatioPercentage: '0',
      },
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.walletTypes).toEqual(['smart_money', 'kol']);
    expect(signals[0]?.soldRatioPct).toBe(0);
  });

  it('понимает data-массив и дополняет сеть из arg', () => {
    const signals = parseOkxSignalMessage({
      arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex: '501' },
      data: [{ ...row, chainIndex: undefined }],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]?.chain).toBe('SOLANA');
  });

  it('ack подписки и чужой канал не становятся сигналами', () => {
    expect(parseOkxSignalMessage({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL } })).toEqual([]);
    expect(parseOkxSignalMessage({ arg: { channel: 'trades', token: row.token } })).toEqual([]);
  });
});

describe('типы кошельков Signal', () => {
  it('поддерживает коды, имена и отбрасывает неизвестное', () => {
    expect(parseSignalWalletTypes('SMART_MONEY,2,WHALE,99')).toEqual([
      'smart_money',
      'kol',
      'whale',
    ]);
  });
});
