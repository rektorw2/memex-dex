import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PositionPriceChart } from './PositionPriceChart';

const chart = vi.hoisted(() => ({ props: null as any }));
vi.mock('next/dynamic', () => ({ default: () => (props: any) => { chart.props = props; return <div data-testid="real-chart-boundary" />; } }));
afterEach(() => { cleanup(); chart.props = null; });
const time = Date.parse('2026-09-14T10:00:00Z') / 1000;
const position = () => ({
  id: 'p', state: 'PAPER_OPEN', symbol: 'TEST', quoteStale: false,
  chart: { state: 'ready', candles: [time, time + 300].map(t => ({ time: t, open: 1, high: 3.5, low: .9, close: 3.2, volumeUsd: 17 })) },
  allocation: { exit: { stopPriceUsd: 2.4, nextTargetPriceUsd: 3.03 } },
  operations: [
    { id: 'entry', kind: 'OPEN' as const, at: '2026-09-14T10:00:12Z', executionPriceUsd: 1.01, quantity: 100, targetPriceUsd: null, pnlUsd: null, netUsd: null, evidence: 'RECORDED' },
    { id: 'partial', kind: 'PARTIAL_EXIT' as const, at: '2026-09-14T10:05:34Z', executionPriceUsd: 2.97, quantity: 25, targetPriceUsd: 3.03, pnlUsd: 49.1, netUsd: 74.25, sellPct: 25, evidence: 'RECORDED' },
  ],
});
it('passes only stored OHLC and recorded fills; future targets are lines, not executions', () => {
  const row = position(); render(<PositionPriceChart position={row} />);
  expect(chart.props.candles).toEqual(row.chart.candles);
  expect(chart.props.markers.map((m: any) => m.id)).toEqual(['entry', 'partial']);
  expect(chart.props.markers.map((m: any) => m.time)).toEqual([time, time + 300]);
  expect(chart.props.levels).toEqual([
    { price: 2.4, label: 'Стоп · уровень', color: '#ff7786', kind: 'stop' },
    { price: 3.03, label: 'TP · цель', color: '#22c7b8', kind: 'target' },
    { price: 2.97, label: 'Исполнение', color: '#c4b5fd', kind: 'execution' },
  ]);
  expect(document.querySelector('[data-operation-detail]')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Частичная фиксация/ }));
  expect(screen.getByText('$2.97')).toBeTruthy();
  expect(screen.getByText('$3.03')).toBeTruthy();
  expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-09-14T10:05:34Z');
  expect(screen.queryByRole('button', { name: /Выход/ })).toBeNull();
});
it('supports keyboard focus, hover and chart marker selection for execution details', () => {
  render(<PositionPriceChart position={position()} />);
  const entry = screen.getByRole('button', { name: /Вход/ });
  fireEvent.focus(entry);
  expect(entry.getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByText('$1.01')).toBeTruthy();
  fireEvent.mouseEnter(screen.getByRole('button', { name: /Частичная фиксация/ }));
  expect(screen.getByText('$49.1')).toBeTruthy();
  fireEvent.click(entry);
  expect(screen.getByText('Позиция открыта')).toBeTruthy();
});
it('does not invent candles or markers when history is missing', () => {
  const row = position(); row.chart = { state: 'missing', candles: [] };
  render(<PositionPriceChart position={row} />);
  expect(chart.props).toBeNull();
  expect(screen.getByText('Недостаточно сохранённой истории цены')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Частичная фиксация/ })).toBeTruthy();
});
it('labels stale quotes and never draws an unknown legacy partial execution', () => {
  const row: any = position(); row.quoteStale = true;
  row.operations[1] = { ...row.operations[1], executionPriceUsd: null, quantity: null, evidence: 'LEGACY' };
  render(<PositionPriceChart position={row} />);
  expect(screen.getByText('Котировка устарела / не подтверждена')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: /Частичная фиксация/ }));
  expect(screen.getByText(/Старая запись/)).toBeTruthy();
  expect(screen.getByText('не записан')).toBeTruthy();
  expect(chart.props.markers.map((m: any) => m.id)).toEqual(['entry']);
});
it('closed positions expose no future target or stop and do not manufacture out-of-window bars', () => {
  const row = position(); row.state = 'PAPER_CLOSED'; row.operations[0]!.at = '2026-09-14T09:00:12Z';
  render(<PositionPriceChart position={row} />);
  expect(screen.getByText('Завершённая позиция')).toBeTruthy();
  expect(chart.props.levels.map((l: any) => l.kind)).toEqual(['execution']);
  expect(chart.props.markers.map((m: any) => m.id)).toEqual(['partial']);
  expect(chart.props.candles).toHaveLength(2);
});
