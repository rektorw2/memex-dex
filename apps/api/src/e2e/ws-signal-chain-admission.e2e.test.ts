import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { OKX_SIGNAL_CHANNEL, parseOkxSignalMessage } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { createToken, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun, setPrice } from './harness.js';
import { runPaperAgentTickOnce, setPaperSignalSourceProbe } from '../workers/paper-agent.js';
import { ingestOkxSignal } from '../workers/okx-signal-ingest.js';
import { setOkxMarketChainIndexes, setOkxSignalChainIndexes } from '../services/okx-market.js';
import { OkxWalletWebSocketClient, type SocketLike } from '../services/okx-ws-client.js';

// Only the external WebSocket transport/configuration is replaced. Real parser,
// network readiness, ingest, worker, allocation and PostgreSQL remain in use.
vi.mock('../lib/env.js', async original => {
  const actual = await original<typeof import('../lib/env.js')>();
  return { ...actual, env: { ...actual.env, OKX_WS_ENABLED: true } };
});
class Socket implements SocketLike {
  onopen: SocketLike['onopen'] = null; onclose: SocketLike['onclose'] = null;
  onerror: SocketLike['onerror'] = null; onmessage: SocketLike['onmessage'] = null;
  send() {} close() {}
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const ack = (chainIndex: string) => ({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex } });
let restore: () => void;
let client: OkxWalletWebSocketClient;
let sockets: Socket[], saves: Promise<unknown>[], rejected: string[];
beforeEach(async () => {
  restore = forbidNetwork(); await resetData();
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  setOkxSignalChainIndexes(['501', '56']); setOkxMarketChainIndexes(['501', '56']);
  sockets = []; saves = []; rejected = [];
  client = new OkxWalletWebSocketClient({
    id: 'ws-chain-e2e', addresses: [], signalChains: ['501', '56'], random: () => 0.5,
    factory: () => { const s = new Socket(); sockets.push(s); return s; }, onEvent: () => {},
    onSignal: s => { saves.push(ingestOkxSignal(s, 'WEBSOCKET_LIVE')); },
    onRejected: reason => rejected.push(reason),
  });
  setPaperSignalSourceProbe(() => ({
    configured: true, transportMode: client.stats().channelTransportMode,
    socketHealthy: client.isHealthy(), channelDeniedCode: client.stats().channelAccessDeniedCode,
    lastRestSuccessAtMs: null, lastRestErrorCode: null, restIntervalMs: 60_000,
    startedAtMs: Date.now() - 600_000, nowMs: Date.now(),
  }));
  client.start(); sockets[0]!.onopen?.(); sockets[0]!.deliver({ event: 'login', code: '0' });
  sockets[0]!.deliver(ack('501'));
});
afterEach(async () => {
  client.stop(); await Promise.all(saves); setPaperSignalSourceProbe(null);
  setOkxSignalChainIndexes(null); setOkxMarketChainIndexes(null);
  await expectNoSigningOrBroadcast(); restore();
});
afterAll(async () => { await prisma.$disconnect(); });

const row = (chainIndex: string, address: string, timestamp = Date.now() - 2_000) => ({
  chainIndex, timestamp: String(timestamp), token: { tokenAddress: address, symbol: 'WSGEM' },
  price: '1', walletType: '1', triggerWalletCount: '3', amountUsd: '1000',
});
const badAddress = '0x0000000000000000000000000000000000000001';

it('rejected rows create no signal, trading decision, allocation or OPEN ledger entry', async () => {
  const bad = row('56', badAddress);
  const messages = [
    { arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex: '501' }, data: [bad] },
    { arg: { channel: OKX_SIGNAL_CHANNEL }, data: [bad] },
    { arg: { channel: OKX_SIGNAL_CHANNEL }, data: [{ ...bad, chainIndex: '999999' }] },
    { arg: { channel: OKX_SIGNAL_CHANNEL }, data: [{ ...bad, chainIndex: undefined }] },
  ];
  expect(parseOkxSignalMessage(messages[0]).map(s => s.chain)).toEqual(['BNB']);
  for (const message of messages) sockets[0]!.deliver(message);
  await Promise.all(saves); sockets[0]!.deliver(ack('56')); await runPaperAgentTickOnce();
  expect(rejected).toEqual(['signal_chain_mismatch', 'signal_subscription_unconfirmed', 'signal_parse_failed', 'signal_parse_failed']);
  expect(await prisma.okxSignal.count()).toBe(0);
  expect(await prisma.paperAgentRun.count()).toBe(0);
  expect(await prisma.paperAgentAllocation.count()).toBe(0);
  expect(await prisma.paperAgentCapitalLedger.count({ where: { eventType: 'OPEN' } })).toBe(0);
});

it.each([true, false])('mixed batch (envelope=%s) opens only the acknowledged valid signal; reconnect/replay cannot reopen its closed position', async hasEnvelope => {
  const token = await createToken({ priceUsd: 1 }, new Date());
  const good = row('501', token.address);
  const message = {
    arg: { channel: OKX_SIGNAL_CHANNEL, ...(hasEnvelope ? { chainIndex: '501' } : {}) },
    data: [row('56', badAddress), good],
  };
  expect(parseOkxSignalMessage(message).map(s => s.chain)).toEqual(['BNB', 'SOLANA']);
  sockets[0]!.deliver(message); await Promise.all(saves);
  expect(rejected).toEqual([hasEnvelope ? 'signal_chain_mismatch' : 'signal_subscription_unconfirmed']);
  expect(await prisma.okxSignal.count()).toBe(1);
  expect(await prisma.okxSignal.count({ where: { chain: 'BNB' } })).toBe(0);
  sockets[0]!.deliver(ack('56')); await runPaperAgentTickOnce();
  const signal = await prisma.okxSignal.findFirstOrThrow();
  const opened = await baselineRun(signal.id);
  expect(opened.state).toBe('PAPER_OPEN');
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, isShadow: false } })).toBe(1);

  const validOnly = { arg: { channel: OKX_SIGNAL_CHANNEL }, data: [good] };
  const oldCallback = sockets[0]!.onmessage!; sockets[0]!.onclose?.();
  await vi.waitFor(() => expect(sockets).toHaveLength(2), { timeout: 3_000 });
  const next = sockets[1]!; next.onopen?.(); next.deliver({ event: 'login', code: '0' });
  // A captured callback is not a fresh ACK from this connection.
  oldCallback({ data: JSON.stringify(ack('501')) });
  next.deliver({ arg: { channel: OKX_SIGNAL_CHANNEL }, data: [{ ...good, timestamp: String(Date.now()) }] });
  await Promise.all(saves); expect(await prisma.okxSignal.count()).toBe(1);
  next.deliver(ack('501')); next.deliver(ack('56'));
  next.deliver(validOnly); next.deliver(validOnly); await Promise.all(saves); await runPaperAgentTickOnce();
  expect(await prisma.okxSignal.count()).toBe(1);
  expect((await baselineRun(signal.id)).decidedAt).toEqual(opened.decidedAt);
  expect(await prisma.paperAgentCapitalLedger.count({ where: { eventType: 'OPEN', allocation: { runId: opened.id, isShadow: false } } })).toBe(1);

  await setPrice(token.id, 3); await runPaperAgentTickOnce();
  const closed = await baselineRun(signal.id); expect(closed.state).toBe('PAPER_CLOSED');
  next.deliver(validOnly); await Promise.all(saves); await runPaperAgentTickOnce();
  expect(await baselineRun(signal.id)).toMatchObject({ id: closed.id, state: 'PAPER_CLOSED', decidedAt: closed.decidedAt, exitAt: closed.exitAt });
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, isShadow: false, state: 'OPEN' } })).toBe(0);
  expect(await prisma.paperAgentAllocation.count({ where: { runId: opened.id, isShadow: false, state: 'CLOSED' } })).toBe(1);
  expect(await prisma.paperAgentRun.count({ where: { chain: 'BNB' } })).toBe(0);
});
