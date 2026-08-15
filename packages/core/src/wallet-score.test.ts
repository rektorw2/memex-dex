import { describe, it, expect } from 'vitest';
import {
  scoreWallet,
  wilsonLowerBound,
  summarizeWalletSignal,
  MIN_TRADES_FOR_SCORE,
  type WalletTradeOutcome,
} from './wallet-score.js';

const trade = (
  outcomeMultiple: number | null,
  amountUsd = 1000,
  poolAgeHours: number | null = 4,
): WalletTradeOutcome => ({ amountUsd, outcomeMultiple, poolAgeHours });

describe('wilsonLowerBound', () => {
  it('на малой выборке даёт заметно меньше сырой доли', () => {
    // 3 из 3 — это 100% по факту, но ожидать 100% дальше нельзя.
    const lower = wilsonLowerBound(3, 3);
    expect(lower).toBeLessThan(0.5);
    expect(lower).toBeGreaterThan(0.3);
  });

  it('с ростом выборки приближается к сырой доле', () => {
    const small = wilsonLowerBound(3, 3);
    const medium = wilsonLowerBound(30, 30);
    const large = wilsonLowerBound(300, 300);

    expect(medium).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(medium);
    expect(large).toBeGreaterThan(0.98);
  });

  it('одинаковая доля при большей выборке оценивается выше', () => {
    expect(wilsonLowerBound(40, 50)).toBeGreaterThan(wilsonLowerBound(4, 5));
  });

  it('нулевая и пустая выборка не ломают расчёт', () => {
    expect(wilsonLowerBound(0, 0)).toBe(0);
    expect(wilsonLowerBound(0, 10)).toBe(0);
  });
});

describe('scoreWallet', () => {
  it('не выставляет оценку при недостатке данных', () => {
    const r = scoreWallet([trade(10), trade(8), trade(12)]);

    expect(r.settled).toBe(3);
    expect(r.hitRate).toBe(1);
    // Три подряд удачных покупки не делают кошелёк умным.
    expect(r.score).toBeNull();
    expect(r.label).not.toBe('smart');
    expect(r.reason).toContain('3');
  });

  it('незакрытые сделки не считаются ни успехом, ни провалом', () => {
    const r = scoreWallet([trade(3), trade(null), trade(null), trade(4)]);

    expect(r.settled).toBe(2);
    expect(r.hitRate).toBe(1);
    // Объём при этом учитывается по всем сделкам.
    expect(r.volumeUsd).toBe(4000);
  });

  it('стабильно прибыльный ранний кошелёк получает метку smart', () => {
    const trades = [
      trade(6, 5000, 2), trade(3, 4000, 1), trade(8, 6000, 3),
      trade(0.5, 2000, 4), trade(4, 5000, 2), trade(12, 3000, 1),
      trade(2.5, 4000, 3), trade(0.9, 1000, 5),
    ];
    const r = scoreWallet(trades);

    expect(r.settled).toBe(8);
    expect(r.wins2x).toBe(6);
    expect(r.score).not.toBeNull();
    expect(r.score!).toBeGreaterThanOrEqual(60);
    expect(r.label).toBe('smart');
  });

  it('частые обнуления сбивают оценку даже при высокой средней кратности', () => {
    // Одна покупка на 50x и семь обнулений: средняя кратность высокая,
    // но повторять за таким кошельком нельзя.
    const lucky = scoreWallet([
      trade(50, 1000, 2), trade(0.05, 1000, 2), trade(0.1, 1000, 2),
      trade(0.02, 1000, 2), trade(0.15, 1000, 2), trade(0.08, 1000, 2),
      trade(0.03, 1000, 2), trade(0.12, 1000, 2),
    ]);

    expect(lucky.avgMultiple).toBeGreaterThan(6);
    expect(lucky.rugs).toBe(7);
    expect(lucky.label).not.toBe('smart');
    expect(lucky.score!).toBeLessThan(60);
  });

  it('крупный объём без результата помечается как кит, а не как смарт', () => {
    const trades = Array.from({ length: 8 }, () => trade(1.1, 20_000, 30));
    const r = scoreWallet(trades);

    expect(r.volumeUsd).toBe(160_000);
    expect(r.wins2x).toBe(0);
    expect(r.label).toBe('whale');
  });

  it('поздний вход снижает оценку при том же результате', () => {
    const base = (h: number) =>
      Array.from({ length: 8 }, () => trade(3, 2000, h));

    const early = scoreWallet(base(1));
    const late = scoreWallet(base(48));

    expect(early.score!).toBeGreaterThan(late.score!);
  });

  it('взвешивает кратность по размеру покупки', () => {
    // Крупно зашёл в удачное, мелко — в неудачное.
    const smart = scoreWallet([
      trade(10, 10_000, 2), trade(0.5, 100, 2), trade(10, 10_000, 2),
      trade(0.5, 100, 2), trade(10, 10_000, 2), trade(0.5, 100, 2),
    ]);
    // Наоборот: крупно в неудачное.
    const dumb = scoreWallet([
      trade(10, 100, 2), trade(0.5, 10_000, 2), trade(10, 100, 2),
      trade(0.5, 10_000, 2), trade(10, 100, 2), trade(0.5, 10_000, 2),
    ]);

    expect(smart.avgMultiple).toBeGreaterThan(dumb.avgMultiple);
  });

  it('пустой список не ломается', () => {
    const r = scoreWallet([]);
    expect(r.settled).toBe(0);
    expect(r.score).toBeNull();
    expect(r.volumeUsd).toBe(0);
    expect(r.medianEntryHours).toBeNull();
  });

  it('порог выборки соблюдается ровно', () => {
    const below = scoreWallet(Array.from({ length: MIN_TRADES_FOR_SCORE - 1 }, () => trade(5)));
    const at = scoreWallet(Array.from({ length: MIN_TRADES_FOR_SCORE }, () => trade(5)));

    expect(below.score).toBeNull();
    expect(at.score).not.toBeNull();
  });
});

describe('summarizeWalletSignal', () => {
  it('свежие покупки весят больше давних', () => {
    const fresh = summarizeWalletSignal([
      { label: 'smart', score: 80, amountUsd: 5000, hoursAgo: 0.5 },
      { label: 'smart', score: 75, amountUsd: 3000, hoursAgo: 1 },
    ]);
    const stale = summarizeWalletSignal([
      { label: 'smart', score: 80, amountUsd: 5000, hoursAgo: 72 },
      { label: 'smart', score: 75, amountUsd: 3000, hoursAgo: 80 },
    ]);

    expect(fresh.strength).toBeGreaterThan(stale.strength);
    // Количество и сумма при этом одинаковы — меняется только сила сигнала.
    expect(fresh.smartCount).toBe(stale.smartCount);
    expect(fresh.smartVolumeUsd).toBe(stale.smartVolumeUsd);
  });

  it('сила сигнала насыщается, а не растёт линейно', () => {
    const mk = (n: number) =>
      Array.from({ length: n }, () => ({
        label: 'smart' as const, score: 70, amountUsd: 1000, hoursAgo: 1,
      }));

    const two = summarizeWalletSignal(mk(2)).strength;
    const five = summarizeWalletSignal(mk(5)).strength;
    const twenty = summarizeWalletSignal(mk(20)).strength;

    expect(five).toBeGreaterThan(two);
    expect(twenty).toBeLessThanOrEqual(100);
    // Прирост с 5 до 20 меньше прироста с 2 до 5.
    expect(twenty - five).toBeLessThan(five - two);
  });

  it('различает отсутствие кошельков и наличие только китов', () => {
    const none = summarizeWalletSignal([]);
    const whalesOnly = summarizeWalletSignal([
      { label: 'whale', score: null, amountUsd: 80_000, hoursAgo: 1 },
    ]);

    expect(none.strength).toBe(0);
    expect(none.verdict).toContain('не замечено');
    expect(whalesOnly.smartCount).toBe(0);
    expect(whalesOnly.strength).toBeGreaterThan(0);
    expect(whalesOnly.verdict).toContain('подтверждённой историей нет');
  });

  it('склоняет числительные корректно', () => {
    const mk = (n: number) =>
      summarizeWalletSignal(
        Array.from({ length: n }, () => ({
          label: 'smart' as const, score: 70, amountUsd: 1000, hoursAgo: 1,
        })),
      ).verdict;

    expect(mk(1)).toContain('1 кошелёк');
    expect(mk(3)).toContain('3 кошелька');
    expect(mk(5)).toContain('5 кошельков');
    expect(mk(11)).toContain('11 кошельков');
    expect(mk(21)).toContain('21 кошелёк');
  });
});

describe('метка early не выдаётся при плохом подтверждённом результате', () => {
  it('ранний вход с семью обнулениями остаётся без метки', () => {
    const r = scoreWallet([
      { amountUsd: 1000, outcomeMultiple: 60, poolAgeHours: 2 },
      ...Array.from({ length: 7 }, () => ({
        amountUsd: 1000, outcomeMultiple: 0.06, poolAgeHours: 2,
      })),
    ]);

    expect(r.rugs).toBe(7);
    // Заходит рано — но это уже не «результат не подтверждён»,
    // а «результат подтверждён и он плохой».
    expect(r.label).toBe('none');
  });

  it('ранний вход при среднем результате метку сохраняет', () => {
    const r = scoreWallet(
      Array.from({ length: 8 }, (_, i) => ({
        amountUsd: 1000,
        outcomeMultiple: i % 2 ? 2.2 : 0.9,
        poolAgeHours: 2,
      })),
    );

    expect(r.score!).toBeGreaterThanOrEqual(35);
    expect(r.score!).toBeLessThan(60);
    expect(r.label).toBe('early');
  });
});
