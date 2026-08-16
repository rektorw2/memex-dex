import { describe, it, expect } from 'vitest';
import { checkSanity, MAX_PLAUSIBLE_LIQUIDITY_USD } from './impersonation.js';

// Проверка подделок переехала в token-registry.test.ts: она определяется
// несовпадением адреса, а не тикером. Здесь осталась правдоподобность
// чисел — она от реестра не зависит.

describe('checkSanity', () => {
  it('ловит неправдоподобную ликвидность', () => {
    // Ровно случай HLZ из терминала: $3.69B на Base.
    const p = checkSanity({
      liquidityUsd: 3_690_000_000,
      volume24hUsd: 1000,
      fdvUsd: null,
      priceChange24h: 0,
    });
    expect(p.some((x) => x.includes('неправдоподобна'))).toBe(true);
  });

  it('правдоподобная ликвидность проходит', () => {
    const p = checkSanity({
      liquidityUsd: 5_000_000,
      volume24hUsd: 2_000_000,
      fdvUsd: 50_000_000,
      priceChange24h: 12,
    });
    expect(p).toHaveLength(0);
  });

  it('ловит капитализацию, несопоставимую с ликвидностью', () => {
    // Почти всё предложение неторгуемо — продать заметный объём
    // не получится ни по какой цене.
    const p = checkSanity({
      liquidityUsd: 10_000,
      volume24hUsd: 5_000,
      fdvUsd: 50_000_000,
      priceChange24h: 0,
    });
    expect(p.some((x) => x.includes('выйти из позиции'))).toBe(true);
  });

  it('ловит нарисованный рост', () => {
    const p = checkSanity({
      liquidityUsd: 50_000,
      volume24hUsd: 10_000,
      fdvUsd: null,
      priceChange24h: 120_913,
    });
    expect(p.some((x) => x.includes('одной сделкой'))).toBe(true);
  });

  it('обычный рост в сотни процентов не отсекается', () => {
    // +543% на мем-коине бывает по-настоящему, и объявлять это
    // нарисованным было бы неверно.
    const p = checkSanity({
      liquidityUsd: 500_000,
      volume24hUsd: 2_000_000,
      fdvUsd: 5_000_000,
      priceChange24h: 543,
    });
    expect(p.some((x) => x.includes('одной сделкой'))).toBe(false);
  });

  it('пустые данные не дают ложных срабатываний', () => {
    expect(
      checkSanity({ liquidityUsd: null, volume24hUsd: null, fdvUsd: null, priceChange24h: null }),
    ).toHaveLength(0);
  });

  it('нулевая ликвидность не ломает деление', () => {
    const p = checkSanity({
      liquidityUsd: 0,
      volume24hUsd: 0,
      fdvUsd: 1_000_000,
      priceChange24h: 0,
    });
    expect(p.every((x) => Number.isFinite(x.length))).toBe(true);
  });

  it('потолок ликвидности задан с запасом', () => {
    // У крупнейших мем-коинов ликвидность держится в десятках
    // миллионов — потолок должен быть заметно выше.
    expect(MAX_PLAUSIBLE_LIQUIDITY_USD).toBeGreaterThan(100_000_000);
  });
});
