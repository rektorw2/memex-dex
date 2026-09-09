import { randomUUID } from 'node:crypto';
import type { Chain } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fetchPoolForToken, reservePoolMetadataSlot } from './market-data.js';
import { logger } from '../lib/logger.js';

export type MetadataAdmission = 'accepted' | 'in_flight' | 'completed' | 'waiting_capacity' | 'exhausted' | 'expired';
type Attempt = { tokenId: string; owner: string; firstAt: number; leaseUntil: number; attempts: number; completed: boolean };
type Gate = { nextAt: number; requests: Attempt[] };
const LEASE_MS = 15_000;
const WINDOW_MS = 60_000;

/** One bounded, locked database row coordinates all strategies/processes.
 * No durable queue: at most twelve starts/minute and two unfinished leases.
 * A crash leaves a lease recoverable once, within the caller's ORIGINAL deadline.
 */
async function locked<T>(work: (gate: Gate, now: number) => T): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "PaperMetadataGate" ("id", "state") VALUES (1, '{"nextAt":0,"requests":[]}'::jsonb) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ state: Gate }>>`SELECT "state" FROM "PaperMetadataGate" WHERE "id" = 1 FOR UPDATE`;
    // Read after acquiring the lock, rather than transaction start time.
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const gate = row!.state;
    const now = clock!.now.getTime();
    gate.requests = gate.requests.filter(r => now < Math.max(r.firstAt + WINDOW_MS, r.leaseUntil));
    const result = work(gate, now);
    await tx.$executeRaw`UPDATE "PaperMetadataGate" SET "state" = ${JSON.stringify(gate)}::jsonb WHERE "id" = 1`;
    return result;
  });
}

export async function requestPaperTokenMetadata(
  tokenId: string, chain: Chain, address: string, deadlineAt: number,
): Promise<MetadataAdmission> {
  const owner = randomUUID();
  let leaseUntil = 0;
  const result = await locked<MetadataAdmission>((gate, now) => {
    if (now >= deadlineAt) return 'expired';
    const previous = gate.requests.find(r => r.tokenId === tokenId);
    if (previous?.completed) return 'completed';
    if (previous && previous.leaseUntil > now) return 'in_flight';
    if (previous && previous.attempts >= 2) return 'exhausted';
    if (now < gate.nextAt || gate.requests.filter(r => !r.completed && r.leaseUntil > now).length >= 2) return 'waiting_capacity';
    leaseUntil = now + LEASE_MS;
    gate.nextAt = now + 5_000;
    if (previous) Object.assign(previous, { owner, leaseUntil, attempts: previous.attempts + 1 });
    else gate.requests.push({ tokenId, owner, firstAt: now, leaseUntil, attempts: 1, completed: false });
    return 'accepted';
  });
  if (result !== 'accepted') return result;

  // The provider gets no queue ticket: it either obtains its own rate slot
  // immediately or reports waiting_capacity. Its HTTP timeout ends before this lease.
  // A paused old owner must not start a request after losing its lease.
  const until = Math.min(deadlineAt, leaseUntil - 1_000);
  if (Date.now() >= until) return 'expired';
  if (!reservePoolMetadataSlot()) {
    await locked(gate => {
      const request = gate.requests.find(r => r.tokenId === tokenId && r.owner === owner);
      if (request) { request.leaseUntil = 0; request.attempts--; }
    });
    return 'waiting_capacity';
  }
  const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, until - Date.now())));
  void fetchPoolForToken(chain, address, { signal, reserved: true }).then(async pool => {
    const date = pool?.poolCreatedAt;
    if (signal.aborted || !date || !Number.isFinite(date.getTime()) || date.getTime() <= 0 || date.getTime() > Date.now()) return;
    await prisma.token.updateMany({
      where: { id: tokenId, chain, address, poolCreatedAt: null },
      data: { poolCreatedAt: date },
    });
  }).catch(error => logger.debug({ tokenId, errorCode: error?.code ?? 'METADATA_UNAVAILABLE' }, 'PAPER: дата пула не получена'))
    .finally(async () => {
      await locked(gate => {
        const request = gate.requests.find(r => r.tokenId === tokenId && r.owner === owner);
        if (request) request.completed = true;
      }).catch(error => logger.debug({ tokenId, error }, 'PAPER: lease метаданных восстановится после таймаута'));
    });
  return result;
}
