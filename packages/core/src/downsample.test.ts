import { describe, it, expect } from 'vitest';
import { downsample, pointsForWidth } from './downsample.js';

const mk = (vals: number[]) => vals.map((v, i) => ({ t: i * 1000, p: v, m: v }));

describe('прореживание', () => {
  it('короткий ряд не трогает', () => {
    const pts = mk([1, 2, 3]);
    expect(downsample(pts, 20)).toBe(pts);
  });

  it('длинный ряд урезает до предела', () => {
    expect(downsample(mk(Array.from({ length: 48 }, (_, i) => i + 1)), 20).length).toBeLessThanOrEqual(20);
  });

  it('крайние точки сохраняются', () => {
    const pts = mk(Array.from({ length: 48 }, (_, i) => i + 1));
    const out = downsample(pts, 10);
    expect(out[0]).toEqual(pts[0]);
    expect(out[out.length - 1]).toEqual(pts[47]);
  });

  it('пик не теряется — иначе график противоречит подписи «пик»', () => {
    // Одиночный выброс в середине: наивное «каждая N-я» его теряет.
    const vals = Array.from({ length: 48 }, () => 1);
    vals[23] = 99;
    const out = downsample(mk(vals), 10);
    expect(out.some((p) => p.m === 99)).toBe(true);
  });

  it('провал тоже сохраняется', () => {
    const vals = Array.from({ length: 48 }, () => 10);
    vals[31] = 0.5;
    const out = downsample(mk(vals), 10);
    expect(out.some((p) => p.m === 0.5)).toBe(true);
  });

  it('порядок по времени не нарушается', () => {
    const out = downsample(mk(Array.from({ length: 48 }, (_, i) => Math.sin(i) + 2)), 12);
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.t).toBeGreaterThan(out[i - 1]!.t);
    }
  });

  it('пустые и битые данные не роняют', () => {
    expect(downsample([], 10)).toEqual([]);
    expect(downsample(null as never, 10)).toEqual([]);
    const nulls = Array.from({ length: 30 }, (_, i) => ({ t: i, p: null, m: null }));
    expect(downsample(nulls, 10).length).toBeLessThanOrEqual(10);
  });
});

describe('число точек под ширину', () => {
  it('растёт с шириной, но не бесконечно', () => {
    expect(pointsForWidth(300)).toBe(25);
    expect(pointsForWidth(10_000)).toBe(48);
    expect(pointsForWidth(1)).toBe(2);
  });
});
