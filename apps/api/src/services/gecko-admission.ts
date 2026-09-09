import { prisma } from '../lib/prisma.js';
export type MetadataAttempt = { tokenId: string; owner: string; firstAt: number; leaseUntil: number; attempts: number; completed: boolean; outcome?: string; deadlineAt?: number };
export type MetadataGate = {
  nextAt: number; requests: MetadataAttempt[];
  signalRest?: { nextAt: number; blockedUntil: number; cursor: number; leaseUntil: number; owner: string };
  provider?: { nextAt: number; backgroundNextAt: number; urgentUntil: number; blockedUntil: number };
};
/** Same singleton/lock as metadata leases. Optional JSON fields are additive:
 * old releases preserve them, and no trading rows or migrations are changed.
 */
export async function withMetadataGate<T>(work: (gate: MetadataGate, now: number) => T): Promise<T> {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`INSERT INTO "PaperMetadataGate" ("id", "state") VALUES (1, '{"nextAt":0,"requests":[]}'::jsonb) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<Array<{ state: MetadataGate }>>`SELECT "state" FROM "PaperMetadataGate" WHERE "id" = 1 FOR UPDATE`;
    const [clock] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const gate = row!.state; const now = clock!.now.getTime();
    gate.requests = gate.requests.filter(r => now < Math.max(r.firstAt + 60_000, r.leaseUntil) && !(r.attempts === 0 && r.deadlineAt != null && now >= r.deadlineAt));
    const result = work(gate, now);
    await tx.$executeRaw`UPDATE "PaperMetadataGate" SET "state" = ${JSON.stringify(gate)}::jsonb WHERE "id" = 1`;
    return result;
  });
}

/** Shared across processes/restarts: total <=8/min, background <=2/min.
 * Metadata's separate gate admits <=12/min and <=2 unfinished leases.
 * No lock is held during waiting/HTTP. Retry-After applies to both classes.
 */
export class GeckoRateLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private async reserve(deadlineAt?: number): Promise<{ accepted: boolean; waitMs: number }> {
    return withMetadataGate((gate, now) => {
      const p = gate.provider ??= { nextAt: 0, backgroundNextAt: 0, urgentUntil: 0, blockedUntil: 0 };
      if (deadlineAt != null) {
        if (now >= deadlineAt) return { accepted: false, waitMs: 0 };
        p.urgentUntil = Math.max(p.urgentUntil, Math.min(deadlineAt, now + 30_000));
      }
      const target = Math.max(p.nextAt, p.blockedUntil, ...(deadlineAt == null ? [p.backgroundNextAt, p.urgentUntil] : []));
      if (target > now) return { accepted: false, waitMs: target - now };
      p.nextAt = now + 7_500;
      if (deadlineAt == null) p.backgroundNextAt = now + 30_000;
      else p.urgentUntil = 0;
      return { accepted: true, waitMs: 0 };
    });
  }
  async tryTake(deadlineAt: number): Promise<boolean> { return (await this.reserve(deadlineAt)).accepted; }
  take(): Promise<void> {
    const ticket = this.tail.then(async () => {
      for (;;) {
        const result = await this.reserve(); if (result.accepted) return;
        await new Promise(resolve => setTimeout(resolve, Math.max(1, result.waitMs)));
      }
    });
    this.tail = ticket.catch(() => undefined); return ticket;
  }
  async backoff(ms: number): Promise<void> {
    await withMetadataGate((gate, now) => {
      const p = gate.provider ??= { nextAt: 0, backgroundNextAt: 0, urgentUntil: 0, blockedUntil: 0 };
      p.blockedUntil = Math.max(p.blockedUntil, now + Math.max(0, ms));
    });
  }
}
