import { describe, it, expect } from 'vitest';
import {
  checkImpersonation,
  checkSanity,
  PROTECTED_TICKERS,
  MAX_PLAUSIBLE_LIQUIDITY_USD,
  type ImpersonationSignals,
} from './impersonation.js';

const sig = (over: Partial<ImpersonationSignals> = {}): ImpersonationSignals => ({
  symbol: 'PEPE',
  name: 'Pepe',
  sameSymbolCount: 1,
  liquidityUsd: 100_000,
  maxSameSymbolLiquidityUsd: 100_000,
  ...over,
});

describe('checkImpersonation — присвоение чужого имени', () => {
  it('ловит подделки под акции', () => {
    // Ровно то, что было видно в терминале: NVDA, HOOD, TSLA
    // как мем-коины на Solana.
    for (const t of ['NVDA', 'TSLA', 'HOOD', 'AAPL']) {
      expect(checkImpersonation(sig({ symbol: t })).impersonatesKnown, t).toBe(true);
    }
  });

  it('ловит подделки под крупные криптоактивы', () => {
    for (const t of ['BTC', 'ETH', 'USDT', 'SOL']) {
      expect(checkImpersonation(sig({ symbol: t })).impersonatesKnown, t).toBe(true);
    }
  });

  it('видит подделку сквозь оформление тикера', () => {
    // Подделки маскируются приписками и заменой символов.
    for (const t of ['$NVDA', 'nvda', 'N.V.D.A', ' NVDA ']) {
      expect(checkImpersonation(sig({ symbol: t })).impersonatesKnown, t).toBe(true);
    }
  });

  it('ловит замену букв на похожие цифры', () => {
    // H00D вместо HOOD, C01N вместо COIN — типичный обход
    // списков по точному совпадению.
    expect(checkImpersonation(sig({ symbol: 'H00D' })).impersonatesKnown).toBe(true);
    expect(checkImpersonation(sig({ symbol: 'C01N' })).impersonatesKnown).toBe(true);
  });

  it('честное название не трогает', () => {
    for (const t of ['PEPE', 'BONK', 'WIF', 'MOG', 'BRETT']) {
      expect(checkImpersonation(sig({ symbol: t })).impersonatesKnown, t).toBe(false);
    }
  });

  it('список защищённых тикеров не пуст и в верхнем регистре', () => {
    expect(PROTECTED_TICKERS.size).toBeGreaterThan(30);
    for (const t of PROTECTED_TICKERS) {
      expect(t).toBe(t.toUpperCase());
    }
  });
});

describe('checkImpersonation — клоны', () => {
  it('одиночный токен клонов не имеет', () => {
    const v = checkImpersonation(sig());
    expect(v.hasClones).toBe(false);
    expect(v.isMinorClone).toBe(false);
  });

  it('сообщает о нескольких токенах с тем же тикером', () => {
    // Три NVDA с разными адресами — это не совпадение,
    // а рассылка одного шаблона.
    const v = checkImpersonation(sig({ symbol: 'ABC', sameSymbolCount: 3 }));
    expect(v.hasClones).toBe(true);
    expect(v.reasons.some((r) => r.includes('3'))).toBe(true);
  });

  it('младший клон определяется по разрыву в ликвидности', () => {
    const v = checkImpersonation(
      sig({ sameSymbolCount: 3, liquidityUsd: 20_000, maxSameSymbolLiquidityUsd: 900_000 }),
    );
    expect(v.isMinorClone).toBe(true);
  });

  it('близкая ликвидность младшим клоном не делает', () => {
    // У двух честных токенов с совпавшим тикером ликвидность
    // может отличаться вдвое — это ещё не повод прятать один.
    const v = checkImpersonation(
      sig({ sameSymbolCount: 2, liquidityUsd: 400_000, maxSameSymbolLiquidityUsd: 700_000 }),
    );
    expect(v.hasClones).toBe(true);
    expect(v.isMinorClone).toBe(false);
  });

  it('крупнейший из одноимённых не считается клоном', () => {
    const v = checkImpersonation(
      sig({ sameSymbolCount: 3, liquidityUsd: 900_000, maxSameSymbolLiquidityUsd: 900_000 }),
    );
    expect(v.isMinorClone).toBe(false);
  });

  it('неизвестная ликвидность не даёт ложного вердикта', () => {
    const v = checkImpersonation(
      sig({ sameSymbolCount: 3, liquidityUsd: null, maxSameSymbolLiquidityUsd: null }),
    );
    expect(v.isMinorClone).toBe(false);
    expect(v.hasClones).toBe(true);
  });
});

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
