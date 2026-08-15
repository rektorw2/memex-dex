import { describe, it, expect } from 'vitest';
import { crossCheck, MAX_PRICE_SPREAD, type SourceReading } from './cross-source.js';

const gecko = (p: number | null, l: number | null, v = 100_000): SourceReading => ({
  source: 'GeckoTerminal', priceUsd: p, liquidityUsd: l, volume24hUsd: v,
});
const dex = (p: number | null, l: number | null, v = 100_000): SourceReading => ({
  source: 'DexScreener', priceUsd: p, liquidityUsd: l, volume24hUsd: v,
});
const okx = (p: number | null, l: number | null, v = 100_000): SourceReading => ({
  source: 'OKX', priceUsd: p, liquidityUsd: l, volume24hUsd: v,
});

describe('crossCheck — согласие источников', () => {
  it('близкие числа проходят без замечаний', () => {
    const r = crossCheck([gecko(0.0012, 250_000), dex(0.00121, 248_000), okx(0.00119, 252_000)]);
    expect(r.blockers).toHaveLength(0);
    expect(r.known).toBe(3);
  });

  it('согласованная цена — медиана, а не максимум', () => {
    // Максимум был прежним способом свести числа, и именно он
    // пропускал завышенные: достаточно одному источнику ошибиться.
    const r = crossCheck([gecko(1.0, 100_000), dex(1.02, 100_000), okx(1.01, 100_000)]);
    expect(r.agreed.priceUsd).toBeCloseTo(1.01, 6);
  });

  it('медиана из двух значений — среднее', () => {
    const r = crossCheck([gecko(1.0, 100_000), dex(1.1, 100_000)]);
    expect(r.agreed.priceUsd).toBeCloseTo(1.05, 6);
  });
});

describe('crossCheck — расхождения', () => {
  it('разная цена у источников блокирует', () => {
    // Один из них читает подделанный пул — какой именно, снаружи
    // не определить, поэтому доверять нельзя обоим.
    const r = crossCheck([gecko(1.6, 500_000), dex(0.0001, 500_000)]);
    expect(r.blockers.some((b) => b.includes('расходятся в цене'))).toBe(true);
  });

  it('в сообщении видно, какой источник что сказал', () => {
    const r = crossCheck([gecko(1.6, 100_000), dex(0.5, 100_000)]);
    expect(r.blockers[0]).toContain('GeckoTerminal');
    expect(r.blockers[0]).toContain('DexScreener');
  });

  it('расхождение в пределах порога допустимо', () => {
    // Разные пулы и задержка обновления дают единицы процентов.
    const r = crossCheck([gecko(1.0, 100_000), dex(1.15, 100_000)]);
    expect(r.priceSpread!).toBeLessThan(MAX_PRICE_SPREAD);
    expect(r.blockers).toHaveLength(0);
  });

  it('ликвидность, отличающаяся в разы, блокирует', () => {
    // Ровно случай HLZ: один источник видит миллиарды,
    // другой — реальные десятки тысяч.
    const r = crossCheck([gecko(1.6, 3_690_000_000), dex(1.6, 50_000)]);
    expect(r.blockers.some((b) => b.includes('отличается'))).toBe(true);
  });

  it('двукратная разница ликвидности допустима', () => {
    // Источники считают её по разным пулам, это нормально.
    const r = crossCheck([gecko(1.0, 100_000), dex(1.0, 200_000)]);
    expect(r.blockers).toHaveLength(0);
  });
});

describe('crossCheck — присутствие', () => {
  it('неизвестный всем токен блокируется', () => {
    const r = crossCheck([gecko(null, null), dex(null, null)]);
    expect(r.known).toBe(0);
    expect(r.blockers.some((b) => b.includes('Ни один источник'))).toBe(true);
  });

  it('молодой пул, известный одному источнику, только предупреждает', () => {
    // Остальные подхватывают с задержкой — это ожидаемо.
    const r = crossCheck([gecko(0.001, 50_000), dex(null, null)], { poolAgeHours: 3 });
    expect(r.blockers).toHaveLength(0);
    expect(r.warnings.some((w) => w.includes('с задержкой'))).toBe(true);
  });

  it('старый пул, известный одному источнику, подозрителен', () => {
    // За неделю его увидели бы все, и то, что не увидели, —
    // само по себе признак.
    const r = crossCheck([gecko(0.001, 50_000), dex(null, null)], { poolAgeHours: 400 });
    expect(r.warnings.some((w) => w.includes('необычно'))).toBe(true);
  });

  it('единственный опрошенный источник не вызывает подозрений', () => {
    // Сеть может не поддерживаться остальными — это не вина токена.
    const r = crossCheck([gecko(0.001, 50_000)], { poolAgeHours: 400 });
    expect(r.warnings).toHaveLength(0);
    expect(r.queried).toBe(1);
  });
});

describe('crossCheck — устойчивость', () => {
  it('пустой список не ломается', () => {
    const r = crossCheck([]);
    expect(r.known).toBe(0);
    expect(r.agreed.priceUsd).toBeNull();
  });

  it('нули и отрицательные значения игнорируются', () => {
    const r = crossCheck([gecko(0, 0), dex(0.001, 50_000)]);
    expect(r.agreed.priceUsd).toBeCloseTo(0.001, 9);
    // Разброс между единственным годным значением не считается.
    expect(r.priceSpread).toBeNull();
  });

  it('частичные данные не мешают сверке остального', () => {
    // У источника есть цена, но нет ликвидности — цену сверяем,
    // ликвидность считаем по тем, у кого она есть.
    const r = crossCheck([gecko(0.001, null), dex(0.00101, 50_000)]);
    expect(r.blockers).toHaveLength(0);
    expect(r.agreed.liquidityUsd).toBe(50_000);
  });
});
