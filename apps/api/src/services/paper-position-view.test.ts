import { afterEach, expect, it, vi } from 'vitest';
const db = vi.hoisted(() => ({ $queryRaw: vi.fn() }));
vi.mock('../lib/prisma.js', () => ({ prisma: db }));
import { positionOperations, storedPositionCandles } from './paper-position-view.js';
afterEach(() => vi.clearAllMocks());
it('uses persisted execution evidence and never recalculates fills at target prices', () => {
  const result = positionOperations({ ledger: [{ id: 'p', eventType: 'PARTIAL_EXIT', metadata: { sellPct: 25, execution: { at: '2026-09-14T10:00:01Z', executionPriceUsd: '2.97', targetPriceUsd: '3.03', quantity: '25', pnlUsd: '49.1', netUsd: '74.25' } } }] });
  expect(result[0]).toMatchObject({ kind: 'PARTIAL_EXIT', executionPriceUsd: 2.97, targetPriceUsd: 3.03, quantity: 25, pnlUsd: 49.1, evidence: 'RECORDED' });
});
it('legacy partials stay unknown while actual persisted legacy entry and close prices survive', () => {
  const result = positionOperations({ entryExecutionPriceUsd: '1.01', entryQuantity: '100', exitExecutionPriceUsd: '1.98', ledger: ['INITIALIZE', 'OPEN', 'PARTIAL_EXIT', 'CLOSE'].map((eventType, index) => ({ id: String(index), eventType, amountUsd: '50', createdAt: new Date(1_000 + index) })) });
  expect(result).toHaveLength(3);
  expect(result[0]).toMatchObject({ executionPriceUsd: 1.01, quantity: 100, pnlUsd: null, evidence: 'LEGACY' });
  expect(result[1]).toMatchObject({ executionPriceUsd: null, quantity: null, pnlUsd: null, targetPriceUsd: null });
  expect(result[2]).toMatchObject({ executionPriceUsd: 1.98, quantity: null });
});
it('missing and invalid persisted fields are not represented as zero-price executions', () => {
  expect(positionOperations(null)).toEqual([]);
  expect(positionOperations({ ledger: [{ id: 'bad', eventType: 'OPEN', metadata: { execution: { executionPriceUsd: 'NaN', quantity: 'Infinity' } } }] })[0]).toMatchObject({ executionPriceUsd: null, quantity: null, at: null });
});
it('shares one bounded stored-candle batch for 15s without making provider requests', async () => {
  const now = Date.parse('2026-09-14T10:10:00Z');
  const windows = [{ id: 'cache-test', tokenId: 'token', entryAt: new Date(now - 600_000), exitAt: null }];
  db.$queryRaw.mockResolvedValue([{ id: 'cache-test', openTime: new Date(now - 300_000), open: 1, high: 2, low: .5, close: 1.5, volumeUsd: 100 }]);
  const first = await storedPositionCandles(windows, now);
  expect(first.get('cache-test')).toHaveLength(1);
  expect((await storedPositionCandles(windows, now + 14_999)).get('cache-test')).toEqual(first.get('cache-test'));
  expect(db.$queryRaw).toHaveBeenCalledTimes(1);
  const sql = db.$queryRaw.mock.calls[0]![0];
  expect(sql.sql).toContain('LIMIT 160');
  expect(sql.sql).toContain("interval = '5m'");
  await storedPositionCandles(windows, now + 15_000);
  expect(db.$queryRaw).toHaveBeenCalledTimes(2);
});
it('without a token and entry timestamp history is empty, not guessed', async () => {
  const result = await storedPositionCandles([{ id: 'no-entry', tokenId: 'token', entryAt: null, exitAt: null }]);
  expect(result.size).toBe(0); expect(db.$queryRaw).not.toHaveBeenCalled();
});
