import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { runPaperAgentTickOnce, queuePaperAgentSignal } from '../workers/paper-agent.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun, activeSession, activeAllocations } from './harness.js';
const NOW = new Date('2026-09-09T00:00:00Z');
let restore: () => void;
beforeEach(async () => {vi.useFakeTimers();vi.setSystemTime(NOW);restore=forbidNetwork();await resetData();await setupPaperAgent({capitalUsd:'1000',maxOpenPositions:4});});
afterEach(async () => {await expectNoSigningOrBroadcast();restore();vi.useRealTimers();});
afterAll(async () => {await prisma.$disconnect();});
async function waiting() {
  const token=await createToken({priceUsd:1},NOW);
  await prisma.token.update({where:{id:token.id},data:{poolCreatedAt:null}});
  const signal=await emitSignal({tokenId:token.id,priceUsd:1},NOW);
  queuePaperAgentSignal(signal.id);await runPaperAgentTickOnce();
  expect(await baselineRun(signal.id)).toMatchObject({state:'RECEIVED',decisionCode:'WAITING_FOR_TOKEN_METADATA',decidedAt:null});
  return {token,signal};
}
it('persisted waiting run is recovered without queue, receives date and opens exactly once', async () => {
  const {token,signal}=await waiting();
  vi.setSystemTime(new Date(NOW.getTime()+5_000));
  await prisma.token.update({where:{id:token.id},data:{poolCreatedAt:new Date(NOW.getTime()-10*60_000)}});
  // No queue call: equivalent to empty process memory after restart.
  await runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).state).toBe('PAPER_OPEN');
  const session=await activeSession();
  queuePaperAgentSignal(signal.id,true);await runPaperAgentTickOnce();
  expect(await activeAllocations(session.id,'OPEN')).toHaveLength(1);
});
it('missing date expires and later metadata/delivery cannot rewrite old decision', async () => {
  const {token,signal}=await waiting();
  vi.setSystemTime(new Date(NOW.getTime()+31_000));await runPaperAgentTickOnce();
  const skipped=await baselineRun(signal.id);expect(skipped.state).toBe('SKIPPED');
  await prisma.token.update({where:{id:token.id},data:{poolCreatedAt:new Date(NOW.getTime()-60_000)}});
  queuePaperAgentSignal(signal.id,true);await runPaperAgentTickOnce();
  expect((await baselineRun(signal.id)).decidedAt).toEqual(skipped.decidedAt);
  expect((await activeSession()).openPositions).toBe(0);
});
it('date arriving after signal deadline never admits the signal', async () => {
  const {token,signal}=await waiting();
  vi.setSystemTime(new Date(NOW.getTime()+31_000));
  await prisma.token.update({where:{id:token.id},data:{poolCreatedAt:new Date(NOW.getTime()-60_000)}});
  await runPaperAgentTickOnce();
  expect(await baselineRun(signal.id)).toMatchObject({state:'SKIPPED',decisionCode:'DECISION_DEADLINE_EXCEEDED'});
});
