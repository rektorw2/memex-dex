import { describe, it, expect } from 'vitest';
import { calcPerformanceFee, calcHighWaterMarkFee, calcSwapFee } from './fees.js';
import { applyBuy, applySell, emptyPosition } from './position.js';

const BPS_10PCT = 1000;

describe('performance fee 10%', () => {
  it('берёт 10% с прибыли полностью копируемой позиции', () => {
    const r = calcPerformanceFee({ realizedPnlUsd: 1000, copiedShare: 1, feeBps: BPS_10PCT });
    expect(r.feeUsd.toString()).toBe('100');
    expect(r.netPnlUsd.toString()).toBe('900');
    expect(r.reason).toBe('charged');
  });

  it('не берёт комиссию с убытка', () => {
    const r = calcPerformanceFee({ realizedPnlUsd: -500, copiedShare: 1, feeBps: BPS_10PCT });
    expect(r.feeUsd.toString()).toBe('0');
    expect(r.reason).toBe('no_profit');
  });

  it('не берёт комиссию при нулевой прибыли', () => {
    const r = calcPerformanceFee({ realizedPnlUsd: 0, copiedShare: 1, feeBps: BPS_10PCT });
    expect(r.feeUsd.toString()).toBe('0');
  });

  it('берёт комиссию только с копируемой доли', () => {
    // 1000 USD прибыли, но лишь 40% позиции набрано копированием
    const r = calcPerformanceFee({ realizedPnlUsd: 1000, copiedShare: 0.4, feeBps: BPS_10PCT });
    expect(r.basisPnlUsd.toString()).toBe('400');
    expect(r.feeUsd.toString()).toBe('40');
  });

  it('игнорирует сделки без копируемого объёма', () => {
    const r = calcPerformanceFee({ realizedPnlUsd: 1000, copiedShare: 0, feeBps: BPS_10PCT });
    expect(r.feeUsd.toString()).toBe('0');
    expect(r.reason).toBe('no_copied_volume');
  });

  it('делит комиссию между лидером и платформой', () => {
    const r = calcPerformanceFee({
      realizedPnlUsd: 1000, copiedShare: 1, feeBps: BPS_10PCT, leaderShareBps: 7000,
    });
    expect(r.feeUsd.toString()).toBe('100');
    expect(r.leaderShareUsd.toString()).toBe('70');
    expect(r.platformShareUsd.toString()).toBe('30');
  });

  describe('перенос убытков (опция)', () => {
    it('накапливает убыток вместо комиссии', () => {
      const r = calcPerformanceFee({
        realizedPnlUsd: -300, copiedShare: 1, feeBps: BPS_10PCT, useLossCarryForward: true,
      });
      expect(r.lossCarryForwardUsd.toString()).toBe('300');
    });

    it('гасит прибыль накопленным убытком до комиссии', () => {
      const r = calcPerformanceFee({
        realizedPnlUsd: 500, copiedShare: 1, feeBps: BPS_10PCT,
        lossCarryForwardUsd: 300, useLossCarryForward: true,
      });
      expect(r.basisPnlUsd.toString()).toBe('200');
      expect(r.feeUsd.toString()).toBe('20');
      expect(r.lossCarryForwardUsd.toString()).toBe('0');
    });

    it('не берёт комиссию, если убыток больше прибыли', () => {
      const r = calcPerformanceFee({
        realizedPnlUsd: 200, copiedShare: 1, feeBps: BPS_10PCT,
        lossCarryForwardUsd: 500, useLossCarryForward: true,
      });
      expect(r.feeUsd.toString()).toBe('0');
      expect(r.reason).toBe('offset_by_losses');
      expect(r.lossCarryForwardUsd.toString()).toBe('300');
    });

    it('БЕЗ опции берёт комиссию даже если пользователь суммарно в минусе', () => {
      // Сознательно зафиксированное поведение выбранной модели —
      // должно быть явно написано в оферте.
      const r = calcPerformanceFee({
        realizedPnlUsd: 200, copiedShare: 1, feeBps: BPS_10PCT, lossCarryForwardUsd: 500,
      });
      expect(r.feeUsd.toString()).toBe('20');
    });
  });

  it('сквозной сценарий: вход 1000$, выход 3000$, комиссия 200$', () => {
    const pos = applyBuy(emptyPosition(), { quantity: 10_000, priceUsd: 0.1, isCopied: true });
    const sell = applySell(pos, { quantity: 10_000, priceUsd: 0.3 });
    expect(sell.realizedPnlUsd.toString()).toBe('2000');

    const fee = calcPerformanceFee({
      realizedPnlUsd: sell.realizedPnlUsd,
      copiedShare: sell.copiedShare,
      feeBps: BPS_10PCT,
    });
    expect(fee.feeUsd.toString()).toBe('200');
    expect(fee.netPnlUsd.toString()).toBe('1800');
    // Пользователь получает 1000 (тело) + 1800 = 2800
    expect(sell.proceedsUsd.minus(fee.feeUsd).toString()).toBe('2800');
  });
});

describe('high-water mark (альтернативная модель)', () => {
  it('берёт комиссию только с прироста над максимумом', () => {
    const a = calcHighWaterMarkFee({ cumulativePnlUsd: 1000, highWaterMarkUsd: 0, feeBps: BPS_10PCT });
    expect(a.feeUsd.toString()).toBe('100');
    expect(a.newHighWaterMarkUsd.toString()).toBe('1000');

    const b = calcHighWaterMarkFee({ cumulativePnlUsd: 800, highWaterMarkUsd: 1000, feeBps: BPS_10PCT });
    expect(b.feeUsd.toString()).toBe('0');
    expect(b.newHighWaterMarkUsd.toString()).toBe('1000');

    const c = calcHighWaterMarkFee({ cumulativePnlUsd: 1500, highWaterMarkUsd: 1000, feeBps: BPS_10PCT });
    expect(c.feeUsd.toString()).toBe('50');
  });
});

describe('комиссия за своп', () => {
  it('нулевая при нулевой ставке', () => {
    expect(calcSwapFee(1000, 0).toString()).toBe('0');
  });
  it('считается в bps от суммы входа', () => {
    expect(calcSwapFee(1000, 50).toString()).toBe('5');
  });
});
