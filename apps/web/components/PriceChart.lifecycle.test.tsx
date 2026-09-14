import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PriceChart } from './PriceChart';
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const registry = vi.hoisted(() => ({ charts: [] as any[] }));
vi.mock('lightweight-charts', () => ({ createChart: () => {
  const state = { disposed: false, lines: new Set(), handlers: new Set(), remove: vi.fn() };
  const live = () => { if (state.disposed) throw Error('Object is disposed'); };
  const series = { applyOptions: live, setData: live, update: live, setMarkers: live,
    createPriceLine: (line: unknown) => { live(); state.lines.add(line); return line; },
    removePriceLine: (line: unknown) => { live(); state.lines.delete(line); },
  };
  const scale = { subscribeVisibleLogicalRangeChange: live, unsubscribeVisibleLogicalRangeChange: live, fitContent: live, getVisibleLogicalRange: () => null, setVisibleLogicalRange: live, scrollToRealTime: live };
  registry.charts.push(state);
  return { addCandlestickSeries: () => series, addLineSeries: () => series, timeScale: () => scale, applyOptions: live,
    subscribeCrosshairMove: (handler: unknown) => { live(); state.handlers.add(handler); },
    subscribeClick: live,
    unsubscribeCrosshairMove: (handler: unknown) => { live(); state.handlers.delete(handler); },
    unsubscribeClick: live,
    remove: () => { live(); state.remove(); state.disposed = true; state.lines.clear(); state.handlers.clear(); },
  };
} }));
afterEach(() => { cleanup(); registry.charts = []; });
const candles = [{ time: 1000 as any, open: 1, high: 2, low: .5, close: 1.5 }, { time: 1300 as any, open: 1.5, high: 3, low: 1, close: 2 }];
const levels = [{ price: 3.03, label: 'TP', color: '#22c7b8', kind: 'target' as const }];
it('removes an entire chart on tab navigation without touching disposed lines or subscriptions', () => {
  const view = render(<PriceChart candles={candles} levels={levels} onMarkerSelect={() => {}} />);
  expect(registry.charts[0].lines.size).toBe(1);
  expect(() => view.unmount()).not.toThrow();
  expect(registry.charts[0].remove).toHaveBeenCalledOnce();
});
it('updates levels on a live chart, and reattaches them if the chart is recreated', () => {
  const props = { candles, levels, onMarkerSelect: () => {} };
  const view = render(<PriceChart {...props} height={220} />);
  view.rerender(<PriceChart {...props} levels={[{ ...levels[0]!, price: 4 }]} height={220} />);
  expect([...registry.charts[0].lines]).toEqual([{ price: 4, color: '#22c7b8', lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'TP' }]);
  view.rerender(<PriceChart {...props} height={240} />);
  expect(registry.charts[0].disposed).toBe(true);
  expect(registry.charts[1].lines.size).toBe(1);
  expect(registry.charts[1].handlers.size).toBe(1);
});
