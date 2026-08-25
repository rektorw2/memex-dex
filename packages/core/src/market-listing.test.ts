import { describe, it, expect } from 'vitest';
import {
  isStablecoinAsset,
  belongsInMarketList,
  priceChange24h,
  priceChangeFrom,
  hasRecentMarketActivity,
  tokenDisplaySymbol,
  isDisplayableToken,
  bestPairPerToken,
  PRICE_CHANGE_MAX_STALENESS_MS,
  ACTIVE_MIN_VOLUME_USD,
} from './market-listing.js';

/**
 * Правила витрины «Рынок».
 *
 * Время везде задаётся явно: расчёт, зависящий от того, когда его
 * запустили, проверяет календарь, а не код.
 */

const NOW = Date.parse('2026-08-25T12:00:00.000Z');
const HOUR = 3_600_000;

/** Настоящий USDC на Solana. Адрес из подтверждённого реестра. */
const REAL_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Подделка: тот же символ, свой адрес. Так они и выглядят. */
const FAKE_USDC = 'FAKEusdc1111111111111111111111111111111111';

// ──────────────────────────── Стейблкоины ───────────────────────────────────

describe('исключение стейблкоинов из списка', () => {
  it('настоящий USDC не показывается в «Рынке»', () => {
    const usdc = { chain: 'SOLANA', address: REAL_USDC, symbol: 'USDC' };

    expect(isStablecoinAsset(usdc)).toBe(true);
    expect(belongsInMarketList(usdc)).toBe(false);
  });

  it('настоящий USDT на Ethereum тоже', () => {
    expect(
      belongsInMarketList({
        chain: 'ETHEREUM',
        address: '0xdac17f958d2ee523a2206206994597c13d831ec7',
      }),
    ).toBe(false);
  });

  it('адрес в контрольной форме узнаётся так же, как в нижнем регистре', () => {
    // У EVM регистр не значим: два написания — один адрес.
    expect(
      isStablecoinAsset({
        chain: 'ETHEREUM',
        address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      }),
    ).toBe(true);
  });

  it('обычный токен остаётся в списке', () => {
    expect(
      belongsInMarketList({ chain: 'SOLANA', address: 'BonkKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKKK' }),
    ).toBe(true);
  });

  it('подделка с символом USDC стейблкоином не считается', () => {
    /*
     * Ключевое место. Исключать по совпадению текста значило бы
     * убрать подделку из списка вместе с оригиналом — то есть
     * избавить мошенника от единственной витрины, где его токен
     * виден рядом с проверенными и со своим уровнем риска.
     */
    const fake = { chain: 'SOLANA', address: FAKE_USDC, symbol: 'USDC', name: 'USD Coin' };

    expect(isStablecoinAsset(fake)).toBe(false);
    expect(belongsInMarketList(fake)).toBe(true);
  });

  it('валюта котировки остаётся валютой котировки', () => {
    // Скрыть строку в витрине и удалить актив — разные действия.
    // `isQuote` продолжает работать для торговли, портфеля и кошельков.
    const quote = { chain: 'BASE', address: '0xsome-quote', isQuote: true };

    expect(isStablecoinAsset(quote)).toBe(true);
    expect(belongsInMarketList(quote)).toBe(false);
  });

  it('токен без метки котировки и вне реестра не скрывается', () => {
    expect(
      belongsInMarketList({ chain: 'BNB', address: '0xdeadbeef', isQuote: false }),
    ).toBe(true);
  });
});

// ─────────────────────── Изменение цены за 24 часа ──────────────────────────

describe('изменение цены строго за сутки', () => {
  it('свежее поле провайдера принимается', () => {
    expect(
      priceChange24h({
        priceChange24h: '42.5',
        priceUpdatedAt: new Date(NOW - HOUR),
        now: NOW,
      }),
    ).toBe(42.5);
  });

  it('отсутствие данных даёт null, а не ноль', () => {
    // Ноль утверждает «цена не изменилась». Это не то же самое,
    // что «мы не знаем», хотя на витрине выглядит одинаково.
    for (const value of [null, undefined, '']) {
      expect(
        priceChange24h({ priceChange24h: value, priceUpdatedAt: new Date(NOW), now: NOW }),
      ).toBeNull();
    }
  });

  it('устаревшая котировка даёт null', () => {
    const stale = priceChange24h({
      priceChange24h: '42.5',
      priceUpdatedAt: new Date(NOW - PRICE_CHANGE_MAX_STALENESS_MS - 1),
      now: NOW,
    });

    // Число, посчитанное три дня назад, суточным изменением
    // не является, как бы точно оно тогда ни считалось.
    expect(stale).toBeNull();
  });

  it('граница свежести включающая', () => {
    expect(
      priceChange24h({
        priceChange24h: '1',
        priceUpdatedAt: new Date(NOW - PRICE_CHANGE_MAX_STALENESS_MS),
        now: NOW,
      }),
    ).toBe(1);
  });

  it('без времени котировки доверия нет', () => {
    expect(
      priceChange24h({ priceChange24h: '42.5', priceUpdatedAt: null, now: NOW }),
    ).toBeNull();
  });

  it('нечисловое значение не превращается в NaN на экране', () => {
    expect(
      priceChange24h({ priceChange24h: 'скоро', priceUpdatedAt: new Date(NOW), now: NOW }),
    ).toBeNull();
  });

  it('падение сохраняет знак', () => {
    expect(
      priceChange24h({ priceChange24h: -18.25, priceUpdatedAt: new Date(NOW), now: NOW }),
    ).toBe(-18.25);
  });

  it('результат не зависит от момента запуска теста', () => {
    const a = priceChange24h({ priceChange24h: '5', priceUpdatedAt: new Date(NOW), now: NOW });
    const b = priceChange24h({
      priceChange24h: '5',
      priceUpdatedAt: new Date(NOW + 10 * 86_400_000),
      now: NOW + 10 * 86_400_000,
    });

    expect(a).toBe(b);
  });
});

describe('изменение по двум ценам', () => {
  it('обычный рост', () => {
    expect(priceChangeFrom(2, 3)).toBeCloseTo(50, 10);
  });

  it('нулевая база не даёт бесконечности', () => {
    // «+∞%» на витрине читается как рекорд, а не как отсутствие базы.
    expect(priceChangeFrom(0, 5)).toBeNull();
    expect(priceChangeFrom(-1, 5)).toBeNull();
  });

  it('неизвестная сторона даёт null', () => {
    expect(priceChangeFrom(null, 5)).toBeNull();
    expect(priceChangeFrom(5, null)).toBeNull();
  });

  it('очень малая, но настоящая цена считается', () => {
    const change = priceChangeFrom(0.000000001, 0.000000002);

    expect(change).toBeCloseTo(100, 6);
    expect(Number.isFinite(change!)).toBe(true);
  });
});

// ────────────────────── Активность за последние сутки ───────────────────────

describe('активность за 24 часа', () => {
  const base = {
    volume24hUsd: 0,
    priceUpdatedAt: new Date(NOW - HOUR),
    now: NOW,
  };

  it('есть сделки — активен', () => {
    expect(hasRecentMarketActivity({ ...base, buys24h: 3, sells24h: 1 })).toBe(true);
  });

  it('есть заметный объём — активен', () => {
    expect(hasRecentMarketActivity({ ...base, volume24hUsd: ACTIVE_MIN_VOLUME_USD })).toBe(true);
  });

  it('копеечный объём без сделок активностью не считается', () => {
    expect(hasRecentMarketActivity({ ...base, volume24hUsd: 5 })).toBe(false);
  });

  it('данные старше суток ничего не говорят о сегодня', () => {
    expect(
      hasRecentMarketActivity({
        volume24hUsd: 500_000,
        buys24h: 100,
        priceUpdatedAt: new Date(NOW - 25 * HOUR),
        now: NOW,
      }),
    ).toBe(false);
  });

  it('без времени данных активности нет', () => {
    expect(
      hasRecentMarketActivity({ volume24hUsd: 500_000, priceUpdatedAt: null, now: NOW }),
    ).toBe(false);
  });

  it('свежая котировка сама по себе активностью не является', () => {
    // Цена обновляется и у пула, где сутки никто не торговал:
    // это работа нашего воркера, а не событие на рынке.
    expect(
      hasRecentMarketActivity({
        volume24hUsd: 0,
        buys24h: 0,
        sells24h: 0,
        priceUpdatedAt: new Date(NOW),
        now: NOW,
      }),
    ).toBe(false);
  });
});

// ─────────────────── Подпись токена и свёртка пар ───────────────────────────

describe('подпись токена без метаданных', () => {
  it('символ показывается как есть', () => {
    expect(tokenDisplaySymbol({ symbol: 'WIF', address: '0xabc' })).toBe('WIF');
  });

  it('вместо ??? показывается сокращённый адрес', () => {
    const label = tokenDisplaySymbol({
      symbol: null,
      address: '0x1234567890abcdef1234567890abcdef12345678',
    });

    // Три вопросительных знака выглядят как поломка интерфейса
    // и не отличают один такой токен от другого.
    expect(label).not.toContain('?');
    expect(label).toBe('0x1234…5678');
  });

  it('пустой символ считается отсутствующим', () => {
    expect(tokenDisplaySymbol({ symbol: '   ', address: '0xabcdef0123456789abcd' })).toContain('…');
  });

  it('короткий адрес не сокращается', () => {
    expect(tokenDisplaySymbol({ symbol: null, address: '0xabc' })).toBe('0xabc');
  });

  it('запись без сети или адреса показывать нельзя', () => {
    expect(isDisplayableToken({ chain: 'SOLANA', address: 'abc' })).toBe(true);
    expect(isDisplayableToken({ chain: '', address: 'abc' })).toBe(false);
    expect(isDisplayableToken({ chain: 'SOLANA', address: '  ' })).toBe(false);
    expect(isDisplayableToken({ chain: null, address: null })).toBe(false);
  });
});

describe('свёртка нескольких пар одного токена', () => {
  const token = 'So11111111111111111111111111111111111111112';

  it('остаётся одна строка — с наибольшей ликвидностью', () => {
    const kept = bestPairPerToken([
      { chain: 'SOLANA', address: token, pairAddress: 'p1', liquidityUsd: 1_000 },
      { chain: 'SOLANA', address: token, pairAddress: 'p2', liquidityUsd: 90_000 },
      { chain: 'SOLANA', address: token, pairAddress: 'p3', liquidityUsd: 500 },
    ]);

    expect(kept).toHaveLength(1);
    // Та же пара определяет цену, по которой реально можно купить.
    expect(kept[0]!.pairAddress).toBe('p2');
  });

  it('один адрес в разных сетях — разные токены', () => {
    const kept = bestPairPerToken([
      { chain: 'BASE', address: '0xabc', liquidityUsd: 10 },
      { chain: 'BNB', address: '0xabc', liquidityUsd: 10 },
    ]);

    expect(kept).toHaveLength(2);
  });

  it('записи без адреса отбрасываются, а не сливаются в одну', () => {
    const kept = bestPairPerToken([
      { chain: 'SOLANA', address: '', liquidityUsd: 100 },
      { chain: 'SOLANA', address: token, liquidityUsd: 100 },
    ]);

    expect(kept).toHaveLength(1);
    expect(kept[0]!.address).toBe(token);
  });

  it('неизвестная ликвидность не вытесняет известную', () => {
    const kept = bestPairPerToken([
      { chain: 'SOLANA', address: token, pairAddress: 'known', liquidityUsd: 5 },
      { chain: 'SOLANA', address: token, pairAddress: 'unknown', liquidityUsd: null },
    ]);

    expect(kept[0]!.pairAddress).toBe('known');
  });
});
