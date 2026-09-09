import { withMetadataGate } from './gecko-admission.js';
import { OKX_PLAN_NAMES, okxPlanQuota, parseOkxPlan } from '@memex/core';

const MONTH_MS = 31 * 24 * 60 * 60_000;
export type RestScheduleConfig = {
  plan?: string; monthlyBudget?: number; requestsPerSecond?: number; consumers?: number; legacyIntervalMs: number;
};
/** An explicitly allocated share, never an inference about the key's balance.
 * Leave at least half of the documented Premium quota to competing endpoints.
 * Consumers includes other processes using this allocation/key. External usage
 * and provider-side signal publication latency remain unobservable here.
 */
export function signalRestPlan(config: RestScheduleConfig, chainCount: number) {
  const knownPlan = OKX_PLAN_NAMES.includes(config.plan as never);
  const requested = Math.max(0, config.monthlyBudget ?? 0);
  const allocated = knownPlan ? Math.min(requested, Math.floor(okxPlanQuota(parseOkxPlan(config.plan)).premium / 2)) : 0;
  const consumers = Math.max(1, config.consumers ?? 1);
  const rps = Math.max(0, config.requestsPerSecond ?? 0);
  const configured = allocated > 0 && rps > 0;
  // Rounded to the worker's 250ms tick; never catch up by sending a burst.
  const intervalMs = configured
    ? Math.ceil(Math.max(MONTH_MS * consumers / allocated, 1000 * consumers / rps, 1000) / 250) * 250
    : config.legacyIntervalMs;
  const roundMs = intervalMs * chainCount;
  const status = !configured ? 'BUDGET_UNCONFIRMED' : chainCount === 0 ? 'NO_CHAINS' : roundMs > 20_000 ? 'INSUFFICIENT_BUDGET' : 'CONDITIONAL';
  return {
    status, intervalMs, chainCount, roundMs, allocatedMonthlyCalls: allocated,
    estimatedMonthlyCalls: Math.ceil(MONTH_MS / intervalMs) * consumers, consumers,
    timelyEntryGuaranteed: false,
    message: status === 'BUDGET_UNCONFIRMED'
      ? 'Бюджет и частота OKX REST не подтверждены. Своевременный вход не обеспечен; требуется восстановить WS или выделить квоту.'
      : status === 'INSUFFICIENT_BUDGET'
        ? 'Квоты REST недостаточно для обхода сетей с запасом до срока 30 секунд. Требуется восстановить WS.'
        : status === 'NO_CHAINS' ? 'Нет подтверждённых сетей для REST.'
          : 'Расписание REST укладывается в 20 секунд без учёта задержек провайдера и сети. Вход до 30 секунд не гарантирован.',
  };
}

/** One in-flight poll, fair rotation, no backlog. All failures consume their
 * time slot, and Retry-After blocks every chain. A slow response cannot create
 * a catch-up burst. State is process-local; the explicit allocation is divided
 * by the configured number of consumers, not advertised as account accounting.
 */
export class SignalRestSchedule {
  nextAt = 0;
  blockedUntil = 0;
  private cursor = 0;
  private inFlight = false;
  private failures = 0;
  claim<T>(chains: readonly T[], now: number, intervalMs: number): T | null {
    if (this.inFlight || chains.length === 0 || now < Math.max(this.nextAt, this.blockedUntil)) return null;
    this.inFlight = true;
    this.nextAt = now + intervalMs;
    return chains[this.cursor++ % chains.length]!;
  }
  complete(now: number, intervalMs: number, failure?: { kind: string; retryAfterMs?: number | null }) {
    this.inFlight = false;
    this.nextAt = Math.max(this.nextAt, now + intervalMs);
    if (!failure) { this.failures = 0; return; }
    this.failures++;
    const minimum = ['auth', 'quota', 'budget', 'not-configured', 'permanent'].includes(failure.kind) ? 300_000
      : failure.kind === 'rate-limit' ? 60_000 : Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
    this.blockedUntil = Math.max(this.blockedUntil, now + Math.max(minimum, failure.retryAfterMs ?? 0));
  }
}

/** The provider/key poll slot is shared by deployment processes and survives
 * restarts. The bounded lease is longer than the HTTP timeout; no durable job
 * queue and no catch-up. Unknown external users of the key still require an
 * explicit owner allocation and cannot be accounted for by this database.
 */
export async function claimSharedSignalPoll<T>(chains: readonly T[], intervalMs: number, owner: string) {
  return withMetadataGate((gate, now) => {
    const state = gate.signalRest ??= { nextAt: 0, blockedUntil: 0, cursor: 0, leaseUntil: 0, owner: '' };
    if (!chains.length || now < Math.max(state.nextAt, state.blockedUntil, state.leaseUntil)) return { chain: null, blockedUntil: state.blockedUntil };
    const chain = chains[state.cursor % chains.length]!; state.cursor = (state.cursor + 1) % chains.length;
    state.owner = owner; state.leaseUntil = now + 30000; state.nextAt = now + intervalMs;
    return { chain, blockedUntil: state.blockedUntil };
  });
}
export async function finishSharedSignalPoll(owner: string, intervalMs: number, blockedUntil: number) {
  await withMetadataGate((gate, now) => {
    const state = gate.signalRest; if (!state || state.owner !== owner) return;
    state.leaseUntil = 0; state.nextAt = Math.max(state.nextAt, now + intervalMs);
    state.blockedUntil = Math.max(state.blockedUntil, blockedUntil);
  });
}
