import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { createToken, emitSignal, setupPaperAgent, resetData, forbidNetwork, expectNoSigningOrBroadcast, baselineRun } from './harness.js';
import { processPaperAgentSignal, runPaperAgentTickOnce, setPaperSignalSourceProbe } from '../workers/paper-agent.js';
import { ingestOkxSignal } from '../workers/okx-signal-ingest.js';
import { OkxWalletWebSocketClient, type SocketLike } from '../services/okx-ws-client.js';
import { OKX_SIGNAL_CHANNEL } from '@memex/core';

// External responses only: actual WS state machine/parser, ingest, metadata
// service/rate gate, PAPER worker, accounts and PostgreSQL are not mocked.
vi.mock('../services/agent-networks.js', () => ({ isAgentNetworkReady: () => true, readyAgentNetworks: () => ['SOLANA', 'BNB', 'ROBINHOOD'] }));
vi.mock('../lib/env.js', async original => {
  const actual = await original<typeof import('../lib/env.js')>();
  return { ...actual, env: { ...actual.env, OKX_WS_ENABLED: true } };
});
let restore: () => void;
beforeEach(async () => {
  restore = forbidNetwork(); await resetData(); await prisma.paperMetadataGate.deleteMany();
  await setupPaperAgent({ capitalUsd: '1000', maxOpenPositions: 4 });
  setPaperSignalSourceProbe(() => ({ configured: true, transportMode: 'REST_ONLY', socketHealthy: false, channelDeniedCode: '60036', lastRestSuccessAtMs: Date.now(), lastRestErrorCode: null, restIntervalMs: 60_000, startedAtMs: Date.now() - 1000, nowMs: Date.now() }));
});
afterEach(async () => { setPaperSignalSourceProbe(null); await expectNoSigningOrBroadcast(); vi.unstubAllGlobals(); vi.useRealTimers(); restore(); });
afterAll(async () => { await prisma.$disconnect(); });

it('restart discovery admits a timely signal before a full batch of expired history', async () => {
  const now = new Date(); const token = await createToken({ priceUsd: 1 }, now);
  await prisma.okxSignal.createMany({ data: Array.from({ length: 201 }, (_, i) => ({
    providerKey: `expired-${i}`, chain: 'SOLANA' as const, address: token.address, tokenId: token.id,
    symbol: 'OLD', name: 'Old signal', signaledAt: new Date(now.getTime() - 60_000 - i),
    receivedAt: new Date(now.getTime() - 59_000), ingestOrigin: 'WEBSOCKET_LIVE', source: 'okx_websocket',
    walletTypes: ['smart_money'], triggerWalletAddresses: [], amountUsd: 1000, priceUsd: 1,
  })) });
  const fresh = await emitSignal({ tokenId: token.id, priceUsd: 1 }, now);
  // No in-memory enqueue: empty memory after restart must discover the latest event.
  await runPaperAgentTickOnce();
  expect((await baselineRun(fresh.id)).state).toBe('PAPER_OPEN');
  expect(await prisma.paperAgentAllocation.count({ where: { isShadow: false, state: 'OPEN' } })).toBe(1);
});

class Socket implements SocketLike {
  sent: string[] = []; onopen: SocketLike['onopen'] = null; onmessage: SocketLike['onmessage'] = null;
  onerror: SocketLike['onerror'] = null; onclose: SocketLike['onclose'] = null;
  send(value: string) { this.sent.push(value); }
  close() {}
  deliver(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
}

it.each([false, true])('official WS denial → recovery → pool metadata; late=%s preserves deadline and final history', async late => {
  const now = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now);
  const address = '0x03d148407da8696888d154a00ac02d5182756f0a';
  let finishPool!: (value: Response) => void;
  const http = vi.fn(async (url: string) => {
    expect(url).toContain(`/networks/robinhood/tokens/${address}/pools`);
    return new Promise<Response>(resolve => { finishPool = resolve; });
  });
  vi.stubGlobal('fetch', http);
  const sockets: Socket[] = [], saves: Promise<unknown>[] = [];
  const client = new OkxWalletWebSocketClient({ id: 'delivery-e2e', addresses: [], signalChains: ['4663'],
    random: () => 0.5,
    factory: () => { const s = new Socket(); sockets.push(s); return s; },
    onEvent: () => {}, onSignal: signal => { saves.push(ingestOkxSignal(signal, 'WEBSOCKET_LIVE')); },
  });
  const acknowledge = (s: Socket) => { s.onopen?.(); s.deliver({ event: 'login', code: '0' }); s.deliver({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex: '4663' } }); };
  const event = { arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex: '4663', timestamp: String(now - 2000), token: { tokenAddress: address, symbol: 'GEM', name: 'Gem' }, price: '1', walletType: '1', triggerWalletCount: '3', amountUsd: '1000' } };
  try {
    client.start(); sockets[0]!.onopen?.(); sockets[0]!.deliver({ event: 'login', code: '0' });
    sockets[0]!.deliver({ event: 'error', code: '60036' });
    expect(client.stats().channelTransportMode).toBe('REST_ONLY');
    client.retrySignalAccess(); acknowledge(sockets[1]!);
    expect(client.stats().subscriptionsVerified).toBe(true);
    sockets[1]!.deliver(event); await Promise.all(saves);
    const signal = await prisma.okxSignal.findFirstOrThrow();
    // DB defaults use PostgreSQL's real clock; do not evaluate before receipt.
    vi.setSystemTime(Math.max(now, signal.receivedAt.getTime()) + 1);
    await processPaperAgentSignal(signal.id);
    expect((await baselineRun(signal.id)).decisionCode).toBe('WAITING_FOR_TOKEN_METADATA');
    await vi.waitFor(() => expect(http).toHaveBeenCalledTimes(1));
    expect((await baselineRun(signal.id)).decisionCode).toBe('WAITING_FOR_TOKEN_METADATA');
    vi.setSystemTime(now + (late ? 31_000 : 1_000));
    finishPool(new Response(JSON.stringify({ data: [{ attributes: { address: 'pool', pool_created_at: new Date(now - 60_000).toISOString(), reserve_in_usd: '10000' }, relationships: { base_token: { data: { id: `robinhood_${address}` } }, quote_token: { data: { id: 'robinhood_quote' } } } }], included: [] })));
    await vi.waitFor(async () => expect(((await prisma.paperMetadataGate.findUniqueOrThrow({ where: { id: 1 } })).state as any).requests[0].completed).toBe(true));
    await runPaperAgentTickOnce();
    const result = await baselineRun(signal.id);
    expect(result.state).toBe(late ? 'SKIPPED' : 'PAPER_OPEN');
    if (late) expect(result.decisionCode).toBe('DECISION_DEADLINE_EXCEEDED');
    // New socket, real resubscription, same provider event; no second allocation.
    sockets[1]!.onclose?.();
    await vi.waitFor(() => expect(sockets).toHaveLength(3), { timeout: 3_000 });
    acknowledge(sockets.at(-1)!);
    sockets.at(-1)!.deliver(event); await Promise.all(saves); await runPaperAgentTickOnce();
    expect(await prisma.okxSignal.count()).toBe(1);
    expect((await baselineRun(signal.id)).decidedAt).toEqual(result.decidedAt);
    expect(await prisma.paperAgentAllocation.count({ where: { runId: result.id, isShadow: false } })).toBe(late ? 0 : 1);
  } finally { client.stop(); }
});
