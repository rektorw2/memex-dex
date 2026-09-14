'use client';
import dynamic from 'next/dynamic';
import { useMemo, useState } from 'react';
import type { Time } from 'lightweight-charts';
import { OPERATION_LABELS, type PositionEvidence, type PositionOperation } from '@/lib/agent-position';

const PriceChart = dynamic(() => import('@/components/PriceChart').then(module => module.PriceChart), { ssr: false, loading: () => <div className="grid h-52 place-items-center text-xs text-muted">Загружаем график…</div> });
export const positionPrice = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? '—' : `$${value.toLocaleString('en-US', { maximumSignificantDigits: 7 })}`;
const qty = (n: number | null | undefined) => n == null ? 'не записан' : n.toLocaleString('ru-RU', { maximumSignificantDigits: 7 });

export function OperationDetail({ operation }: { operation: PositionOperation }) {
  return <div className="agent-operation-detail rounded-lg border border-white/10 bg-bg/60 p-3 text-xs" data-operation-detail={operation.id}>
    <div className="flex flex-wrap justify-between gap-2"><strong>{OPERATION_LABELS[operation.kind]}</strong><time dateTime={operation.at ?? undefined} className="text-muted">{operation.at ? new Date(operation.at).toLocaleString('ru-RU') : 'Время не записано'}</time></div>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2">
      <div><dt className="text-muted">Цена исполнения</dt><dd className="num mt-0.5 text-white">{positionPrice(operation.executionPriceUsd)}</dd></div>
      <div><dt className="text-muted">Целевой уровень</dt><dd className="num mt-0.5">{positionPrice(operation.targetPriceUsd)}</dd></div>
      <div><dt className="text-muted">Объём токенов</dt><dd className="num mt-0.5">{qty(operation.quantity)}</dd></div>
      <div><dt className="text-muted">Результат после издержек</dt><dd className={`num mt-0.5 ${(operation.pnlUsd ?? 0) >= 0 ? 'text-up' : 'text-down'}`}>{operation.kind === 'OPEN' ? 'Позиция открыта' : positionPrice(operation.pnlUsd)}</dd></div>
    </dl>
    {operation.evidence === 'LEGACY' && <p className="mt-2 text-muted">Старая запись: отсутствующие параметры исполнения не восстанавливаются предположениями.</p>}
  </div>;
}

export function PositionPriceChart({ position }: { position: PositionEvidence & { id: string; state: string; symbol: string; allocation?: { exit?: { stopPriceUsd: number | null; nextTargetPriceUsd: number | null } | null } } }) {
  const [selectedId, select] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const inspect = (id: string | null) => { if (id) { select(id); setExpanded(true); } };
  const operations = position.operations ?? [];
  const selected = operations.find(op => op.id === selectedId) ?? operations.at(-1) ?? null;
  const candles = useMemo(() => (position.chart?.candles ?? []).map(c => ({ ...c, time: c.time as Time })), [position.chart?.candles]);
  const markers = useMemo(() => operations.filter(op => op.at && op.executionPriceUsd != null).flatMap(op => {
    const time = Date.parse(op.at!) / 1000;
    // Anchor to an existing 5m candle; never manufacture a candle for a fill.
    const candle = [...candles].reverse().find(c => Number(c.time) <= time && time < Number(c.time) + 300);
    return candle ? [{ id: op.id, side: op.kind === 'OPEN' ? 'BUY' as const : 'SELL' as const, time: Number(candle.time), priceUsd: op.executionPriceUsd, pnlUsd: op.pnlUsd, strategyLabel: '', label: op.kind === 'OPEN' ? 'Вход' : op.kind === 'CLOSE' ? 'Выход' : `−${op.sellPct ?? '?'}%` }] : [];
  }), [operations, candles]);
  const levels = useMemo(() => {
    const result: Array<{ price: number; label: string; color: string; kind: 'target' | 'execution' | 'stop' }> = [];
    if (position.state !== 'PAPER_CLOSED') {
      if (position.allocation?.exit?.stopPriceUsd != null) result.push({ price: position.allocation.exit.stopPriceUsd, label: 'Стоп · уровень', color: '#ff7786', kind: 'stop' });
      if (position.allocation?.exit?.nextTargetPriceUsd != null) result.push({ price: position.allocation.exit.nextTargetPriceUsd, label: 'TP · цель', color: '#22c7b8', kind: 'target' });
    }
    if (selected?.executionPriceUsd != null) result.push({ price: selected.executionPriceUsd, label: 'Исполнение', color: '#c4b5fd', kind: 'execution' });
    return result;
  }, [position.state, position.allocation?.exit?.stopPriceUsd, position.allocation?.exit?.nextTargetPriceUsd, selected?.executionPriceUsd]);
  return <section className="mt-4 min-w-0 rounded-xl border border-white/10 bg-bg/35" aria-label={`История цены ${position.symbol}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-3 text-[11px]"><span className="font-medium text-muted">ЦЕНА · 5 МИН</span><span className={position.state === 'PAPER_CLOSED' ? 'text-muted' : position.quoteStale !== false ? 'text-warn' : 'text-up'}>{position.state === 'PAPER_CLOSED' ? 'Завершённая позиция' : position.quoteStale !== false ? 'Котировка устарела / не подтверждена' : 'Свежая котировка'}</span></div>
    {position.chart?.state === 'ready' && candles.length >= 2
      ? <PriceChart candles={candles} height={220} resetKey={`position:${position.id}`} markers={markers} levels={levels} onMarkerSelect={inspect} followLive={false} />
      : <div className="grid min-h-36 place-items-center px-5 py-6 text-center text-xs text-muted"><p>{position.chart?.state === 'unavailable' ? 'История цены временно недоступна' : 'Недостаточно сохранённой истории цены'}<span className="mt-2 block">Исполнения ниже — из журнала. Свечи не дорисовываем.</span></p></div>}
    <div className="space-y-3 p-3">
      <p className="text-[10px] text-muted">Пунктир — ожидаемые уровни, сплошная линия — выбранное исполнение. Метки привязаны к 5-минутным свечам; точное время — в деталях.</p>
      {operations.length ? <>
        <div className="flex flex-wrap gap-2" aria-label="Последовательность операций">{operations.map((op, index) => <button key={op.id} type="button" onClick={() => inspect(op.id)} onMouseEnter={() => inspect(op.id)} onFocus={() => inspect(op.id)} aria-pressed={expanded && selected?.id === op.id} className={`agent-operation min-h-9 rounded-lg border px-2.5 text-xs transition-colors ${expanded && selected?.id === op.id ? 'border-accent/60 bg-accent/15 text-white' : 'border-border text-muted hover:border-accent/40 hover:text-white'}`}><span className="mr-1 text-muted">{index + 1}.</span>{OPERATION_LABELS[op.kind]}{op.sellPct != null ? ` · ${op.sellPct}%` : ''}</button>)}</div>
        {expanded && selected && <div className="agent-fade"><OperationDetail operation={selected} /><button type="button" onClick={() => setExpanded(false)} className="mt-1 min-h-9 px-2 text-xs text-muted hover:text-white">Свернуть детали</button></div>}
      </> : <p className="text-xs text-muted">Детальные исполнения для этой старой позиции не записаны.</p>}
    </div>
  </section>;
}
