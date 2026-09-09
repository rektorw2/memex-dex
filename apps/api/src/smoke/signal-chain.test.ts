/**
 * Проверка серверной цепочки на подделке базы: три исхода различимы,
 * успех — только когда у сигнала есть сохранённое решение по каждой
 * стратегии. Пропуск — тоже решение.
 */
import { describe, expect, it } from 'vitest';
import { runSignalChainCheck, type StoredRunRow, type StoredSignalRow } from './signal-chain.js';
import { SMOKE_EXIT } from './exit-codes.js';

const T = new Date('2026-09-08T10:00:00Z');
const signal = (over: Partial<StoredSignalRow> = {}): StoredSignalRow => ({
  id: 'sig-1', providerKey: 'okx-signal:1', chain: 'SOLANA', symbol: 'GEM', ingestOrigin: 'WEBSOCKET_LIVE', paperAgentIngestCode: 'QUEUED_LIVE',
  signaledAt: T, receivedAt: new Date(T.getTime() + 300), ...over,
});
const run = (over: Partial<StoredRunRow> = {}): StoredRunRow => ({ id: 'run-1', strategyId: 's-baseline', strategyKey: 'baseline', state: 'SKIPPED', decisionCode: 'AMOUNT_BELOW_MIN', decidedAt: T, ...over });
const ENABLED = [{ id: 's-baseline', key: 'baseline' }];
const one = async () => ENABLED;

function clock() {
  let now = 0;
  return { now: () => now, wait: async (ms: number) => { now += ms; } };
}

describe('серверная цепочка по одному сигналу', () => {
  it('нет сигналов за окно — неполно', async () => {
    const c = clock();
    const r = await runSignalChainCheck({ findSignal: async () => null, findRuns: async () => [], listEnabledStrategies: one, waitMs: 3_000, ...c });
    expect(r).toMatchObject({ code: SMOKE_EXIT.incomplete, status: 'incomplete', signal: null });
    expect(r.gaps[0]).toContain('ни одного сигнала');
  });

  it('сигнал есть, но не поставлен агенту (NETWORK_NOT_READY) — неполно, без выдуманного успеха', async () => {
    const c = clock();
    const r = await runSignalChainCheck({ findSignal: async () => signal({ chain: 'ROBINHOOD', paperAgentIngestCode: 'NETWORK_NOT_READY' }), findRuns: async () => [], listEnabledStrategies: one, waitMs: 1_000, ...c });
    expect(r.status).toBe('incomplete');
    expect(r.signal?.ingestCode).toBe('NETWORK_NOT_READY');
  });

  it('сигнал поставлен, run нет за окно — неполно (воркер не подтверждён)', async () => {
    const c = clock();
    const r = await runSignalChainCheck({ findSignal: async () => signal(), findRuns: async () => [], listEnabledStrategies: one, waitMs: 2_000, ...c });
    expect(r.status).toBe('incomplete');
    expect(r.gaps.join()).toContain('Воркер не создал');
  });

  it('решение появляется позже — дожидается и подтверждает; пропуск считается решением', async () => {
    const c = clock();
    let polls = 0;
    const r = await runSignalChainCheck({
      findSignal: async () => signal(),
      findRuns: async () => { polls += 1; return polls < 3 ? [run({ decisionCode: null, decidedAt: null, state: 'PENDING' })] : [run()]; },
      listEnabledStrategies: one,
      waitMs: 10_000, ...c,
    });
    expect(r).toMatchObject({ code: SMOKE_EXIT.ok, status: 'complete', gaps: [] });
    expect(r.runs).toEqual([{ strategyKey: 'baseline', state: 'SKIPPED', decisionCode: 'AMOUNT_BELOW_MIN', enabled: true }]);
    expect(r.lines.some((line) => line.includes('Позиция не требовалась'))).toBe(true);
  });

  it('решение есть не у всех стратегий — неполно', async () => {
    const c = clock();
    const r = await runSignalChainCheck({ findSignal: async () => signal(), findRuns: async () => [run()], listEnabledStrategies: async () => [...ENABLED, { id: 's2', key: 'shadow-2' }, { id: 's3', key: 'shadow-3' }, { id: 's4', key: 'shadow-4' }, { id: 's5', key: 'shadow-5' }], waitMs: 1_000, ...c });
    expect(r.status).toBe('incomplete');
    expect(r.gaps.join()).toContain('shadow-2');
    expect(r.gaps.join()).toContain('shadow-5');
  });

  it('решение выключенной стратегии не заменяет отсутствующее решение действующей', async () => {
    const c = clock();
    const r = await runSignalChainCheck({
      findSignal: async () => signal(),
      findRuns: async () => [run({ id: 'old', strategyId: 's-old', strategyKey: 'disabled-baseline-v2' })],
      listEnabledStrategies: one,
      waitMs: 1_000, ...c,
    });
    expect(r.status).toBe('incomplete');
    expect(r.code).toBe(SMOKE_EXIT.incomplete);
    expect(r.gaps.join()).toContain('только решения выключенных стратегий');
    expect(r.runs).toEqual([{ strategyKey: 'disabled-baseline-v2', state: 'SKIPPED', decisionCode: 'AMOUNT_BELOW_MIN', enabled: false }]);
  });

  it('исторический run выключенной стратегии рядом с решением действующей — успех по действующей, историческое отмечено', async () => {
    const c = clock();
    const r = await runSignalChainCheck({
      findSignal: async () => signal(),
      findRuns: async () => [run({ id: 'old', strategyId: 's-old', strategyKey: 'disabled-baseline-v2' }), run()],
      listEnabledStrategies: one,
      waitMs: 1_000, ...c,
    });
    expect(r.status).toBe('complete');
    expect(r.lines.some((line) => line.includes('в зачёт не идут'))).toBe(true);
  });

  it('нет включённых стратегий — неполно, не успех', async () => {
    const c = clock();
    const r = await runSignalChainCheck({ findSignal: async () => signal(), findRuns: async () => [run()], listEnabledStrategies: async () => [], waitMs: 1_000, ...c });
    expect(r.status).toBe('incomplete');
    expect(r.gaps[0]).toContain('Нет ни одной включённой стратегии');
  });

  it('по явному идентификатору ищет именно его', async () => {
    const c = clock();
    const seen: Array<string | null> = [];
    await runSignalChainCheck({ findSignal: async (id) => { seen.push(id); return null; }, findRuns: async () => [], listEnabledStrategies: one, waitMs: 0, ...c }, 'sig-42');
    expect(seen).toEqual(['sig-42']);
  });
});
