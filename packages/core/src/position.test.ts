import { describe, it, expect } from 'vitest';
import { emptyPosition, applyBuy, applySell, unrealizedPnlUsd } from './position.js';
import { D } from './money.js';

describe('учёт позиции (WAC)', () => {
  it('усредняет цену входа при докупке', () => {
    let p = emptyPosition();
    p = applyBuy(p, { quantity: 1000, priceUsd: 0.10 });   // 100 USD
    p = applyBuy(p, { quantity: 1000, priceUsd: 0.20 });   // 200 USD
    expect(p.quantity.toString()).toBe('2000');
    expect(p.costBasisUsd.toString()).toBe('300');
    expect(p.avgCostUsd.toString()).toBe('0.15');
  });

  it('включает комиссии входа в себестоимость', () => {
    const p = applyBuy(emptyPosition(), { quantity: 100, priceUsd: 1, feesUsd: 3 });
    expect(p.costBasisUsd.toString()).toBe('103');
    expect(p.avgCostUsd.toString()).toBe('1.03');
  });

  it('не меняет avgCost при частичной продаже', () => {
    let p = applyBuy(emptyPosition(), { quantity: 1000, priceUsd: 0.10 });
    const r = applySell(p, { quantity: 400, priceUsd: 0.25 });
    expect(r.position.avgCostUsd.toString()).toBe('0.1');
    expect(r.position.quantity.toString()).toBe('600');
    expect(r.realizedPnlUsd.toString()).toBe('60');       // 400*(0.25-0.10)
    expect(r.position.costBasisUsd.toString()).toBe('60'); // 600 * 0.10
  });

  it('обнуляет позицию при полном выходе', () => {
    const p = applyBuy(emptyPosition(), { quantity: 500, priceUsd: 2 });
    const r = applySell(p, { quantity: 500, priceUsd: 3 });
    expect(r.position.quantity.toString()).toBe('0');
    expect(r.position.costBasisUsd.toString()).toBe('0');
    expect(r.position.avgCostUsd.toString()).toBe('0');
    expect(r.realizedPnlUsd.toString()).toBe('500');
  });

  it('считает убыток отрицательным PnL', () => {
    const p = applyBuy(emptyPosition(), { quantity: 100, priceUsd: 10 });
    const r = applySell(p, { quantity: 100, priceUsd: 4 });
    expect(r.realizedPnlUsd.toString()).toBe('-600');
  });

  it('вычитает комиссии выхода из выручки', () => {
    const p = applyBuy(emptyPosition(), { quantity: 100, priceUsd: 1 });
    const r = applySell(p, { quantity: 100, priceUsd: 2, feesUsd: 15 });
    expect(r.proceedsUsd.toString()).toBe('185');
    expect(r.realizedPnlUsd.toString()).toBe('85');
  });

  it('распределяет копируемый объём пропорционально при продаже', () => {
    let p = applyBuy(emptyPosition(), { quantity: 600, priceUsd: 1, isCopied: true });
    p = applyBuy(p, { quantity: 400, priceUsd: 1, isCopied: false });
    expect(p.copiedQuantity.toString()).toBe('600');

    const r = applySell(p, { quantity: 500, priceUsd: 2 });
    expect(r.copiedShare.toString()).toBe('0.6');
    expect(r.copiedQtySold.toString()).toBe('300');
    expect(r.position.copiedQuantity.toString()).toBe('300');
  });

  it('не даёт продать больше, чем есть', () => {
    const p = applyBuy(emptyPosition(), { quantity: 10, priceUsd: 1 });
    expect(() => applySell(p, { quantity: 11, priceUsd: 1 })).toThrow(/недостаточное/);
  });

  it('корректно работает с ценой мем-коина в 12 знаков', () => {
    let p = applyBuy(emptyPosition(), { quantity: '1000000000', priceUsd: '0.000000001234' });
    expect(p.costBasisUsd.toString()).toBe('1.234');
    const r = applySell(p, { quantity: '1000000000', priceUsd: '0.000000012340' });
    expect(r.realizedPnlUsd.toString()).toBe('11.106');
  });

  it('считает нереализованный PnL по рыночной цене', () => {
    const p = applyBuy(emptyPosition(), { quantity: 100, priceUsd: 1 });
    expect(unrealizedPnlUsd(p, 1.5).toString()).toBe('50');
    expect(unrealizedPnlUsd(p, 0.4).toString()).toBe('-60');
  });
});
