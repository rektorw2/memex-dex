/** Read-only position evidence. No provider calls, hot-token registration or worker hooks. */
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma.js';

const value = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
};
const iso = (v: unknown): string | null => {
  const n = v == null ? NaN : new Date(v as string).getTime();
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
};

export function positionOperations(allocation: any) {
  const rows = (allocation?.ledger ?? []).filter((r: any) => ['OPEN', 'PARTIAL_EXIT', 'CLOSE'].includes(r.eventType));
  return rows.map((row: any) => {
    const execution = row.metadata?.execution;
    const kind = row.eventType as 'OPEN' | 'PARTIAL_EXIT' | 'CLOSE';
    // Old partial fills have no persisted execution price: deliberately null.
    const price = value(execution?.executionPriceUsd) ?? (kind === 'OPEN' ? value(allocation.entryExecutionPriceUsd) : kind === 'CLOSE' ? value(allocation.exitExecutionPriceUsd) : null);
    const quantity = value(execution?.quantity) ?? (kind === 'OPEN' ? value(allocation.entryQuantity) : null);
    return {
      id: row.id, kind,
      at: iso(execution?.at) ?? (kind === 'OPEN' ? iso(allocation.entryAt) : kind === 'CLOSE' ? iso(allocation.exitAt) : null) ?? iso(row.createdAt),
      executionPriceUsd: price, quantity, netUsd: value(execution?.netUsd) ?? (kind === 'OPEN' ? null : value(row.amountUsd)),
      pnlUsd: value(execution?.pnlUsd), targetPriceUsd: value(execution?.targetPriceUsd),
      reason: row.metadata?.exitReason ?? null,
      sellPct: value(row.metadata?.sellPct), remainingPct: value(row.metadata?.remainingPct),
      legs: execution?.legs ?? [],
      evidence: execution ? 'RECORDED' : 'LEGACY',
    };
  }).sort((a: any, b: any) => Date.parse(a.at ?? '') - Date.parse(b.at ?? '') || a.id.localeCompare(b.id));
}

export interface PositionMarketWindow { id: string; tokenId: string | null; entryAt: Date | null; exitAt: Date | null }
export interface PositionCandle { time: number; open: number; high: number; low: number; close: number; volumeUsd: number }
const cached = new Map<string, { until: number; candles: PositionCandle[] }>();
/** One bounded indexed SQL batch, shared for 15s, using only already-stored candles. */
export async function storedPositionCandles(windows: PositionMarketWindow[], now = Date.now()): Promise<Map<string, PositionCandle[]>> {
  const result = new Map<string, PositionCandle[]>();
  const pending: Array<{ id: string; tokenId: string; from: string; to: string }> = [];
  for (const row of windows.slice(0, 100)) {
    if (!row.tokenId || !row.entryAt) continue;
    const hit = cached.get(row.id);
    if (hit && hit.until > now) { result.set(row.id, hit.candles); continue; }
    pending.push({ id: row.id, tokenId: row.tokenId, from: new Date(Math.floor(row.entryAt.getTime() / 300_000) * 300_000 - 300_000).toISOString(), to: new Date((row.exitAt?.getTime() ?? now) + (row.exitAt ? 300_000 : 0)).toISOString() });
  }
  if (!pending.length) return result;
  const rows = await prisma.$queryRaw<Array<{ id: string; openTime: Date; open: Prisma.Decimal; high: Prisma.Decimal; low: Prisma.Decimal; close: Prisma.Decimal; volumeUsd: Prisma.Decimal }>>(Prisma.sql`
    SELECT w.id, c.* FROM jsonb_to_recordset(${JSON.stringify(pending)}::jsonb)
      AS w(id text, "tokenId" text, "from" timestamptz, "to" timestamptz)
    CROSS JOIN LATERAL (
      SELECT "openTime", open, high, low, close, "volumeUsd" FROM "Candle"
      WHERE "tokenId" = w."tokenId" AND interval = '5m'
        AND "openTime" >= w."from" AND "openTime" <= w."to"
      ORDER BY "openTime" DESC LIMIT 160
    ) c`);
  for (const item of pending) {
    const candles = rows.filter(row => row.id === item.id).map(row => ({ time: row.openTime.getTime() / 1000, open: Number(row.open), high: Number(row.high), low: Number(row.low), close: Number(row.close), volumeUsd: Number(row.volumeUsd) }))
      .filter(row => [row.open, row.high, row.low, row.close].every(n => Number.isFinite(n) && n > 0))
      .sort((a, b) => a.time - b.time);
    result.set(item.id, candles); cached.set(item.id, { until: now + 15_000, candles });
  }
  while (cached.size > 300) cached.delete(cached.keys().next().value!);
  return result;
}
