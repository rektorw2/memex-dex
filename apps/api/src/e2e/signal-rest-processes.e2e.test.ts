import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, beforeEach, expect, it } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { claimSharedSignalPoll, finishSharedSignalPoll, signalRestPlan } from '../services/signal-rest-schedule.js';
import { requireE2eDatabaseUrl } from './e2e-database.js';

const exec = promisify(execFile);
const chains = ['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE'];
const plan = signalRestPlan({ plan: 'growth', monthlyBudget: 900_000, requestsPerSecond: 1, consumers: 1, legacyIntervalMs: 60_000 }, chains.length);
const moduleUrl = new URL('../services/signal-rest-schedule.ts', import.meta.url).href;
const prismaUrl = new URL('../lib/prisma.ts', import.meta.url).href;

async function processClaim(owner: string) {
  // Each child is a new process/client with no shared memory. Same real
  // production admission service and DB clock; external HTTP never starts.
  const url = requireE2eDatabaseUrl();
  const code = `import { claimSharedSignalPoll } from ${JSON.stringify(moduleUrl)};
    import { prisma } from ${JSON.stringify(prismaUrl)};
    try { console.log(JSON.stringify(await claimSharedSignalPoll(${JSON.stringify(chains)}, ${plan.intervalMs}, ${JSON.stringify(owner)}))); }
    finally { await prisma.$disconnect(); }`;
  const { stdout } = await exec(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    env: { ...process.env, NODE_ENV: 'test', DATABASE_URL: url, DIRECT_DATABASE_URL: url }, timeout: 15_000,
  });
  return JSON.parse(stdout.trim()) as { chain: string | null; blockedUntil: number };
}
beforeEach(async () => { await prisma.paperMetadataGate.deleteMany(); });
afterAll(async () => { await prisma.$disconnect(); });

it('three actual processes share one quota slot; restart preserves interval, rotation and 429', async () => {
  const owners = ['first', 'second', 'third'];
  const results = await Promise.all(owners.map(processClaim));
  expect(results.filter(r => r.chain != null)).toHaveLength(1);
  expect(results.find(r => r.chain != null)?.chain).toBe('SOLANA');
  const winner = owners[results.findIndex(r => r.chain != null)]!;
  await finishSharedSignalPoll(winner, plan.intervalMs, 0);
  const row = await prisma.paperMetadataGate.findUniqueOrThrow({ where: { id: 1 } });
  const state = (row.state as any).signalRest;
  const databaseNow = (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0]!.now.getTime();
  expect(databaseNow).toBeLessThan(state.nextAt);
  expect((await processClaim('early-restart')).chain).toBeNull();
  await new Promise(resolve => setTimeout(resolve, Math.max(0, state.nextAt - Date.now()) + 30));
  const next = await processClaim('after-slot');
  expect(next.chain).toBe('BNB');
  const blocked = Date.now() + 120_000;
  await finishSharedSignalPoll('after-slot', plan.intervalMs, blocked);
  expect(await processClaim('after-429-restart')).toEqual({ chain: null, blockedUntil: blocked });
  expect(plan.estimatedMonthlyCalls).toBeLessThanOrEqual(900_000);
  const multi = signalRestPlan({ plan: 'growth', monthlyBudget: 900_000, requestsPerSecond: 1, consumers: 3, legacyIntervalMs: 60_000 }, 5);
  expect(multi.estimatedMonthlyCalls).toBeLessThanOrEqual(900_000);
});

it('new processes cannot release a lease belonging to another owner', async () => {
  expect((await processClaim('owner')).chain).toBe('SOLANA');
  await finishSharedSignalPoll('not-owner', plan.intervalMs, 0);
  expect((await claimSharedSignalPoll(chains, plan.intervalMs, 'competitor')).chain).toBeNull();
});
