import { withMetadataGate as locked } from './gecko-admission.js';
import { randomUUID } from 'node:crypto';
import type { Chain } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { fetchPoolForToken, reservePoolMetadataSlot } from './market-data.js';
import { logger } from '../lib/logger.js';

export type MetadataAdmission = 'accepted' | 'in_flight' | 'completed' | 'waiting_capacity' | 'exhausted' | 'expired';
const LEASE_MS = 15_000;
const MAX_TRACKED = 32;

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
    if (!previous && gate.requests.length >= MAX_TRACKED) return 'waiting_capacity';
    if (now < gate.nextAt || gate.requests.filter(r => !r.completed && r.leaseUntil > now).length >= 2) return 'waiting_capacity';
    leaseUntil = now + LEASE_MS;
    gate.nextAt = now + 5_000;
    if (previous) Object.assign(previous, { owner, leaseUntil, attempts: previous.attempts + 1 });
    else gate.requests.push({ tokenId, owner, firstAt: now, leaseUntil, attempts: 1, completed: false, deadlineAt });
    return 'accepted';
  });
  if (result !== 'accepted') return result;

  // The provider gets no queue ticket: it either obtains its own rate slot
  // immediately or reports waiting_capacity. Its HTTP timeout ends before this lease.
  // A paused old owner must not start a request after losing its lease.
  const until = Math.min(deadlineAt, leaseUntil - 1_000);
  if (Date.now() >= until) return 'expired';
  if (!await reservePoolMetadataSlot(until)) {
    await locked((gate, now) => {
      const request = gate.requests.find(r => r.tokenId === tokenId && r.owner === owner);
      if (request) {
        request.leaseUntil = 0; request.attempts--;
        // No HTTP request started: do not spend the global five-second slot.
        // Preserve a newer owner's reservation, if one exists.
        if (gate.nextAt === leaseUntil - LEASE_MS + 5_000) gate.nextAt = now;
      }
    });
    return 'waiting_capacity';
  }
  if (Date.now() >= until) return 'expired';
  const signal = AbortSignal.timeout(Math.max(1, Math.min(10_000, until - Date.now())));
  let outcome = 'POOL_DATE_UNAVAILABLE';
  void fetchPoolForToken(chain, address, { signal, reserved: true, onUnavailable: reason => { outcome = reason; } }).then(async pool => {
    const date = pool?.poolCreatedAt;
    if (signal.aborted || !date || !Number.isFinite(date.getTime()) || date.getTime() <= 0 || date.getTime() > Date.now()) return;
    const updated = await prisma.token.updateMany({
      where: { id: tokenId, chain, address, poolCreatedAt: null },
      data: { poolCreatedAt: date },
    });
    outcome = updated.count > 0 ? 'POOL_DATE_SAVED' : 'TOKEN_ALREADY_UPDATED';
  }).catch(error => logger.debug({ tokenId, errorCode: error?.code ?? 'METADATA_UNAVAILABLE' }, 'PAPER: дата пула не получена'))
    .finally(async () => {
      await locked(gate => {
        const request = gate.requests.find(r => r.tokenId === tokenId && r.owner === owner);
        if (request) { request.completed = true; request.outcome = signal.aborted ? 'DEADLINE' : outcome; }
        logger.debug({ tokenId, chain, outcome: signal.aborted ? 'DEADLINE' : outcome }, 'PAPER: результат получения даты пула');
      }).catch(error => logger.debug({ tokenId, error }, 'PAPER: lease метаданных восстановится после таймаута'));
    });
  return result;
}
