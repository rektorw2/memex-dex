import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { processPaperAgentSignal, runPaperAgentTickOnce, setPaperSignalSourceProbe } from '../workers/paper-agent.js';
import { requestPaperTokenMetadata } from '../services/paper-token-metadata.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';

// Real worker, service and PostgreSQL. Only the metadata provider is replaced.
const provider = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/market-data.js', () => ({ fetchPoolForToken: provider.fetch, reservePoolMetadataSlot: () => true }));
let restore: () => void;
const otherConnection = new PrismaClient();
beforeEach(async () => {
  restore = forbidNetwork(); await resetData();
  await prisma.paperMetadataGate.deleteMany();
  await setupPaperAgent({capitalUsd:'1000',maxOpenPositions:4});
  provider.fetch.mockReset(); provider.fetch.mockImplementation(() => new Promise(() => {}));
  setPaperSignalSourceProbe(() => ({configured:true,transportMode:'WEBSOCKET',socketHealthy:true,channelDeniedCode:null,lastRestSuccessAtMs:Date.now(),lastRestErrorCode:null,restIntervalMs:60_000,startedAtMs:Date.now()-600_000,nowMs:Date.now()}));
});
afterEach(async () => {setPaperSignalSourceProbe(null); await expectNoSigningOrBroadcast(); restore();});
afterAll(async () => {await otherConnection.$disconnect(); await prisma.$disconnect();});
async function fixture() {
  const now = new Date();
  const token = await createToken({priceUsd:1,poolCreatedAt:null},now);
  const signal = await emitSignal({tokenId:token.id,priceUsd:1},now);
  // Synthetic official-origin delivery, with network forbidden. This exercises
  // the same admission path as production, without the TEST_HARNESS exemption.
  await prisma.okxSignal.update({where:{id:signal.id},data:{ingestOrigin:'WEBSOCKET_LIVE'}});
  return {token,signal};
}
async function editGate(edit: (state: any) => void) {
  const row = await prisma.paperMetadataGate.findUniqueOrThrow({where:{id:1}});
  const state = row.state as any; edit(state);
  await prisma.paperMetadataGate.update({where:{id:1},data:{state}});
}
it('PostgreSQL admission is serialized against a separate connection holding the row lock', async () => {
  await requestPaperTokenMetadata('seed','SOLANA','seed',Date.now()+30_000);
  await editGate(s => {s.nextAt=0;});
  let release!: () => void, acquired!: () => void;
  const held = new Promise<void>(r => {acquired=r;});
  const lock = otherConnection.$transaction(async tx => {
    await tx.$queryRaw`SELECT "state" FROM "PaperMetadataGate" WHERE id=1 FOR UPDATE`;
    acquired(); await new Promise<void>(r => {release=r;});
  });
  await held;
  const requests = Promise.all(Array.from({length:10}, () => requestPaperTokenMetadata('same','BNB','same',Date.now()+30_000)));
  release(); await lock;
  const results = await requests;
  expect(results.filter(r=>r==='accepted')).toHaveLength(1);
  expect(results.filter(r=>r==='in_flight')).toHaveLength(9);
  expect(provider.fetch).toHaveBeenCalledTimes(2);
});
it('different tokens and all enabled strategies wait for capacity; reconciliation resumes with no in-memory delivery', async () => {
  const a = await fixture(), b = await fixture();
  await requestPaperTokenMetadata('occupant','SOLANA','occupant',Date.now()+30_000);
  await processPaperAgentSignal(a.signal.id); await processPaperAgentSignal(b.signal.id);
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  expect(await prisma.paperAgentRun.count({where:{signalId:a.signal.id,state:'RECEIVED'}})).toBe(5);
  await editGate(s => {s.nextAt=0;});
  provider.fetch.mockResolvedValue({poolCreatedAt:new Date(Date.now()-60_000)});
  await runPaperAgentTickOnce();
  await vi.waitFor(async () => expect((await prisma.token.findUniqueOrThrow({where:{id:a.token.id}})).poolCreatedAt).not.toBeNull());
  await editGate(s => {s.nextAt=0;}); await runPaperAgentTickOnce();
  await vi.waitFor(async () => expect((await prisma.token.findUniqueOrThrow({where:{id:b.token.id}})).poolCreatedAt).not.toBeNull());
  await runPaperAgentTickOnce();
  expect(provider.fetch).toHaveBeenCalledTimes(3);
  expect((await baselineRun(a.signal.id)).state).toBe('PAPER_OPEN');
  expect((await baselineRun(b.signal.id)).state).toBe('PAPER_OPEN');
  await Promise.all([processPaperAgentSignal(a.signal.id),processPaperAgentSignal(a.signal.id)]);
  expect(await prisma.paperAgentRun.count({where:{signalId:a.signal.id}})).toBe(5);
  expect(await prisma.paperAgentNotification.count({where:{run:{signalId:a.signal.id},eventType:'PAPER_BUY'}})).toBe(5);
});
it('persisted unfinished attempt recovers once; expired signal never obtains a fresh deadline', async () => {
  const {signal} = await fixture();
  await processPaperAgentSignal(signal.id);
  expect(provider.fetch).toHaveBeenCalledTimes(1);
  await editGate(s => {s.nextAt=0; s.requests[0].leaseUntil=0;});
  await runPaperAgentTickOnce(); expect(provider.fetch).toHaveBeenCalledTimes(2);
  await editGate(s => {s.nextAt=0; s.requests[0].leaseUntil=0;});
  await runPaperAgentTickOnce(); expect(provider.fetch).toHaveBeenCalledTimes(2);
  await prisma.okxSignal.update({where:{id:signal.id},data:{signaledAt:new Date(Date.now()-40_000)}});
  await runPaperAgentTickOnce(); expect((await baselineRun(signal.id)).state).toBe('SKIPPED');
  expect(provider.fetch).toHaveBeenCalledTimes(2);
});
