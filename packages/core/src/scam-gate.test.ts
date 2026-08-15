import { describe, it, expect } from 'vitest';
import { checkScam, scamSummary, type ScamSignals } from './scam-gate.js';

/** Чистый токен: проверен, ничего подозрительного. */
const clean = (over: Partial<ScamSignals> = {}): ScamSignals => ({
  isHoneypot: false,
  mintable: false,
  freezable: false,
  ownerCanModify: false,
  buyTaxPct: 0,
  sellTaxPct: 0,
  lpLocked: true,
  top10Pct: 25,
  creatorPct: 5,
  holderCount: 500,
  liquidityUsd: '120000',
  volume24hUsd: '400000',
  buys24h: 300,
  sells24h: 250,
  poolAgeHours: 72,
  securityChecked: true,
  ...over,
});

describe('checkScam — блокировка', () => {
  it('ханипот блокируется', () => {
    const d = checkScam(clean({ isHoneypot: true }));
    expect(d.verdict).toBe('BLOCK');
    expect(d.score).toBe(100);
    expect(d.blockers[0]).toContain('Продажа заблокирована');
  });

  it('живой mint authority блокируется', () => {
    expect(checkScam(clean({ mintable: true })).verdict).toBe('BLOCK');
  });

  it('возможность заморозки блокируется', () => {
    expect(checkScam(clean({ freezable: true })).verdict).toBe('BLOCK');
  });

  it('запретительный налог на продажу блокируется', () => {
    // 30% на выходе — это не комиссия, а способ забрать треть вклада.
    expect(checkScam(clean({ sellTaxPct: 30 })).verdict).toBe('BLOCK');
    expect(checkScam(clean({ sellTaxPct: 20 })).verdict).toBe('BLOCK');
    // Ниже порога — предупреждение, но не запрет.
    expect(checkScam(clean({ sellTaxPct: 19 })).verdict).toBe('WARN');
  });

  it('незалоченная ликвидность блокирует только вместе с правами владельца', () => {
    // По отдельности каждое — повод для осторожности, вместе —
    // готовый механизм вывода средств.
    expect(checkScam(clean({ lpLocked: false })).verdict).toBe('WARN');
    expect(checkScam(clean({ ownerCanModify: true })).verdict).toBe('WARN');
    expect(checkScam(clean({ lpLocked: false, ownerCanModify: true })).verdict).toBe('BLOCK');
  });

  it('микроскопическая ликвидность блокируется', () => {
    const d = checkScam(clean({ liquidityUsd: '900' }));
    expect(d.verdict).toBe('BLOCK');
    expect(d.blockers[0]).toContain('выйти без обвала');
  });

  it('при блокировке предупреждения не считаются', () => {
    // Первая причина — та, что решает; остальное человеку уже не нужно.
    const d = checkScam(clean({ isHoneypot: true, top10Pct: 95, holderCount: 3 }));
    expect(d.verdict).toBe('BLOCK');
    expect(d.warnings).toHaveLength(0);
  });
});

describe('checkScam — предупреждения', () => {
  it('чистый токен проходит без замечаний', () => {
    const d = checkScam(clean());
    expect(d.verdict).toBe('OK');
    expect(d.warnings).toHaveLength(0);
    expect(d.score).toBe(0);
  });

  it('непроверенный контракт помечается', () => {
    // Отсутствие данных — не то же самое, что их благополучие.
    const d = checkScam({ liquidityUsd: '100000', securityChecked: false });
    expect(d.verdict).toBe('WARN');
    expect(d.warnings.some((w) => w.includes('не проверен'))).toBe(true);
  });

  it('концентрация у топ-10 повышает оценку сильнее при крайних значениях', () => {
    const mid = checkScam(clean({ top10Pct: 60 }));
    const high = checkScam(clean({ top10Pct: 90 }));
    expect(high.score).toBeGreaterThan(mid.score);
  });

  it('мало держателей', () => {
    const d = checkScam(clean({ holderCount: 12 }));
    expect(d.warnings.some((w) => w.includes('Держателей'))).toBe(true);
  });

  it('свежий пул помечается', () => {
    const d = checkScam(clean({ poolAgeHours: 2 }));
    expect(d.warnings.some((w) => w.includes('история ещё не сложилась'))).toBe(true);
  });
});

describe('checkScam — поведенческие признаки', () => {
  it('покупки без продаж — подпись ловушки', () => {
    const d = checkScam(clean({ buys24h: 400, sells24h: 0 }));
    expect(d.verdict).toBe('WARN');
    expect(d.warnings.some((w) => w.includes('ни одной продажи'))).toBe(true);
  });

  it('сильный перекос покупок к продажам', () => {
    const d = checkScam(clean({ buys24h: 300, sells24h: 10 }));
    expect(d.warnings.some((w) => w.includes('раз больше, чем продаж'))).toBe(true);
  });

  it('на малой выборке сделок перекос не считается', () => {
    // При десяти сделках такое соотношение получается случайно,
    // и предупреждение было бы шумом.
    const d = checkScam(clean({ buys24h: 8, sells24h: 0 }));
    expect(d.warnings.some((w) => w.includes('продажи'))).toBe(false);
  });

  it('оборот, несопоставимый с ликвидностью, — накрутка', () => {
    // Реальная торговля на такой оборот просто осушила бы пул.
    const d = checkScam(clean({ liquidityUsd: '10000', volume24hUsd: '5000000' }));
    expect(d.warnings.some((w) => w.includes('накрутку'))).toBe(true);
  });

  it('нормальное соотношение оборота к ликвидности не тревожит', () => {
    const d = checkScam(clean({ liquidityUsd: '100000', volume24hUsd: '500000' }));
    expect(d.warnings.some((w) => w.includes('накрутку'))).toBe(false);
  });
});

describe('checkScam — устойчивость к пустым данным', () => {
  it('полностью пустой ввод не блокирует, но предупреждает', () => {
    const d = checkScam({});
    expect(d.verdict).toBe('WARN');
    expect(d.blockers).toHaveLength(0);
  });

  it('null в проверках контракта не считается благополучием', () => {
    // GoPlus вернул null — значит не проверено, а не «всё чисто».
    const d = checkScam({
      isHoneypot: null,
      mintable: null,
      lpLocked: null,
      securityChecked: false,
      liquidityUsd: '50000',
    });
    expect(d.verdict).toBe('WARN');
    expect(d.blockers).toHaveLength(0);
  });

  it('нулевая ликвидность не блокирует по недостатку данных', () => {
    // Ноль здесь означает «не знаем», а не «пул пуст»: пустой пул
    // не попал бы в выдачу источника вообще.
    const d = checkScam(clean({ liquidityUsd: '0' }));
    expect(d.blockers.some((b) => b.includes('обвала'))).toBe(false);
  });

  it('оценка не выходит за 100', () => {
    const d = checkScam({
      securityChecked: false,
      lpLocked: false,
      ownerCanModify: false,
      top10Pct: 99,
      creatorPct: 90,
      holderCount: 2,
      buys24h: 500,
      sells24h: 0,
      liquidityUsd: '20000',
      volume24hUsd: '9000000',
      poolAgeHours: 1,
    });
    expect(d.score).toBeLessThanOrEqual(100);
    expect(d.score).toBeGreaterThan(60);
  });
});

describe('scamSummary', () => {
  it('при блокировке показывает решающую причину', () => {
    const d = checkScam(clean({ isHoneypot: true }));
    expect(scamSummary(d)).toContain('Продажа заблокирована');
  });

  it('при нескольких предупреждениях сообщает про остальные', () => {
    const d = checkScam(clean({ lpLocked: false, top10Pct: 90, holderCount: 10 }));
    expect(scamSummary(d)).toContain('и ещё');
  });

  it('чистый токен не называется безопасным', () => {
    // Мем-коин может обесцениться при любых метриках, и формулировка
    // не должна обещать больше проверенного.
    const s = scamSummary(checkScam(clean()));
    expect(s).toContain('не найдено');
    expect(s.toLowerCase()).not.toContain('безопас');
  });
});
