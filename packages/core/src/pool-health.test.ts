import { describe, it, expect } from 'vitest';
import {
  checkPoolHealth,
  MIN_POOL_LIQUIDITY_USD,
  DRAIN_RATIO,
  ABSURD_VOLUME_RATIO,
} from './pool-health.js';

/**
 * Разбор конкретного случая, из-за которого правило появилось:
 * токен с ликвидностью меньше доллара, оборотом $793K за сутки
 * и ростом на 101%. Формально все числа настоящие, фактически
 * из пула вышли, и купить в нём можно только у себя самого.
 */

describe('осушенный пул', () => {
  it('ликвидность меньше доллара — токен непригоден', () => {
    const h = checkPoolHealth({
      liquidityUsd: 0.4,
      liquidityAtSignalUsd: 61_000,
      volume24hUsd: 793_000,
    });
    expect(h.isDead).toBe(true);
    expect(h.code).toBe('LOW_LIQUIDITY');
    expect(h.reason).toContain('исчерпана');
  });

  it('ровно ноль обрабатывается наравне с остальными', () => {
    // Прежнее условие требовало liquidity > 0 и пропускало
    // именно этот случай — ради которого правило и писалось.
    const h = checkPoolHealth({
      liquidityUsd: 0,
      liquidityAtSignalUsd: 50_000,
      volume24hUsd: 100_000,
    });
    expect(h.isDead).toBe(true);
  });

  it('обвал относительно находки ловится и выше порога', () => {
    // Пул был на полмиллиона, стал тридцать тысяч. Формально выше
    // минимума, фактически из него вышли.
    const h = checkPoolHealth({
      liquidityUsd: 30_000,
      liquidityAtSignalUsd: 500_000,
      volume24hUsd: 40_000,
    });
    expect(h.isDead).toBe(true);
    expect(h.code).toBe('DRAINED_POOL');
    expect(h.reason).toContain('94%');
  });

  it('обычные колебания глубины обвалом не считаются', () => {
    // Треть туда-сюда бывает при живой торговле, и объявлять это
    // бегством значило бы прятать здоровые токены.
    const h = checkPoolHealth({
      liquidityUsd: 70_000,
      liquidityAtSignalUsd: 100_000,
      volume24hUsd: 200_000,
    });
    expect(h.isDead).toBe(false);
  });

  it('оборот, несовместимый с глубиной пула', () => {
    // 793K оборота при 100 долларах в пуле: числа относятся
    // к разным моментам времени.
    const h = checkPoolHealth({
      liquidityUsd: 100_000,
      liquidityAtSignalUsd: 100_000,
      volume24hUsd: 200_000_000,
    });
    expect(h.isDead).toBe(true);
    expect(h.code).toBe('SUSPICIOUS_VOLUME');
  });

  it('высокий, но правдоподобный оборот проходит', () => {
    // Оборот вдесятеро выше пула — для мем-коина обычное дело.
    const h = checkPoolHealth({
      liquidityUsd: 100_000,
      liquidityAtSignalUsd: 100_000,
      volume24hUsd: 1_000_000,
    });
    expect(h.isDead).toBe(false);
  });
});

describe('здоровый пул', () => {
  it('обычная находка проходит без замечаний', () => {
    const h = checkPoolHealth({
      liquidityUsd: 120_000,
      liquidityAtSignalUsd: 100_000,
      volume24hUsd: 800_000,
    });
    expect(h.isDead).toBe(false);
    expect(h.reason).toBeNull();
    expect(h.code).toBeNull();
  });

  it('рост ликвидности не считается проблемой', () => {
    const h = checkPoolHealth({
      liquidityUsd: 900_000,
      liquidityAtSignalUsd: 50_000,
      volume24hUsd: 2_000_000,
    });
    expect(h.isDead).toBe(false);
  });
});

describe('неизвестность не приравнивается к пустоте', () => {
  it('неизвестная ликвидность не объявляет пул мёртвым', () => {
    // Отсутствие сведений — это отсутствие сведений, а не приговор.
    const h = checkPoolHealth({
      liquidityUsd: null,
      liquidityAtSignalUsd: 100_000,
      volume24hUsd: 500_000,
    });
    expect(h.isDead).toBe(false);
    expect(h.code).toBeNull();
  });

  it('отсутствие базы не мешает проверить абсолютную величину', () => {
    const h = checkPoolHealth({
      liquidityUsd: 500,
      liquidityAtSignalUsd: null,
      volume24hUsd: null,
    });
    expect(h.isDead).toBe(true);
    expect(h.code).toBe('LOW_LIQUIDITY');
  });

  it('мусор в числах не роняет проверку', () => {
    const h = checkPoolHealth({
      liquidityUsd: Number.NaN,
      liquidityAtSignalUsd: Number.POSITIVE_INFINITY,
      volume24hUsd: Number.NaN,
    });
    expect(h.isDead).toBe(false);
  });
});

describe('пороги', () => {
  it('согласованы между собой и осмысленны', () => {
    expect(MIN_POOL_LIQUIDITY_USD).toBeGreaterThan(0);
    // Доля потери, а не половина: обычные колебания не должны срабатывать.
    expect(DRAIN_RATIO).toBeGreaterThan(0);
    expect(DRAIN_RATIO).toBeLessThan(0.5);
    // Порог абсурда заведомо выше обычного порога подозрительности.
    expect(ABSURD_VOLUME_RATIO).toBeGreaterThan(100);
  });
});
