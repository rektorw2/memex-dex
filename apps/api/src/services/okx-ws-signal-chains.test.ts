import { afterEach, expect, it, vi } from 'vitest';
import { OKX_SIGNAL_CHANNEL, parseOkxSignalMessage, type OkxSignal } from '@memex/core';
import { OkxWalletWebSocketClient, type SocketLike } from './okx-ws-client.js';

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
afterEach(() => vi.useRealTimers());
const ack = (chainIndex: string) => ({ event: 'subscribe', arg: { channel: OKX_SIGNAL_CHANNEL, chainIndex } });
function fixture() {
  vi.useFakeTimers();
  const sockets: Socket[] = [], received: OkxSignal[] = [], rejected: string[] = [];
  const client = new OkxWalletWebSocketClient({
    id: 'ws-chain-review', addresses: [], signalChains: ['501', '56'], random: () => 0.5,
    factory: () => { const s = new Socket(); sockets.push(s); return s; },
    onEvent: () => {}, onSignal: value => received.push(value), onRejected: reason => rejected.push(reason),
  });
  client.start(); const socket = sockets[0]!;
  socket.onopen?.(); socket.deliver({ event: 'login', code: '0' }); socket.deliver(ack('501'));
  return { socket, sockets, client, received, rejected };
}
const row = (chainIndex: unknown) => ({
  chainIndex, timestamp: String(Date.now()),
  token: { tokenAddress: String(chainIndex) === '501' ? 'FN9ZSeNDdPV6bBF9DeDYxvqYK4JvFKeF7DBrhGGXJZ3Q' : '0x0000000000000000000000000000000000000001', symbol: 'TEST' },
  price: '1', walletType: '1', amountUsd: '1000',
});
const envelope = (data: unknown[], chainIndex?: unknown) => ({ arg: { channel: OKX_SIGNAL_CHANNEL, ...(chainIndex === undefined ? {} : { chainIndex }) }, data });

// The three independent valid-address reproductions, with the same assertions.
it('confirmed envelope cannot admit an unconfirmed different payload chain', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    const message = envelope([row('56')], '501');
    expect(parseOkxSignalMessage(message).map(s => s.chain)).toEqual(['BNB']);
    socket.deliver(message);
    expect(received).toHaveLength(0);
    expect(rejected).toEqual(['signal_chain_mismatch']);
    expect(client.stats().lastChannelEventAt).toBeNull();
  } finally { client.stop(); }
});
it('supported data envelope with row chain can deliver an acknowledged network', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    socket.deliver(envelope([row('501')]));
    expect(received).toHaveLength(1);
    expect(received[0]?.chain).toBe('SOLANA');
    expect(rejected).toEqual([]);
    // Another requested chain has not ACKed: overall connection is NOT the gate.
    expect(client.stats().subscriptionsVerified).toBe(false);
  } finally { client.stop(); }
});
it('matching envelope and payload chain still delivers the acknowledged network', () => {
  const { socket, client, received } = fixture();
  try {
    socket.deliver(envelope([row('501')], '501'));
    expect(received).toHaveLength(1);
  } finally { client.stop(); }
});
it.each(['data', 'signal-array', 'signal-object', 'arg', 'top-level-channel', 'envelope-fallback', 'numeric-chain'])('retains the parser-supported %s form', form => {
  const { socket, client, received, rejected } = fixture();
  const item = row('501');
  const message = form === 'data' ? envelope([item])
    : form === 'signal-array' ? { arg: { channel: OKX_SIGNAL_CHANNEL }, signal: [item] }
    : form === 'signal-object' ? { arg: { channel: OKX_SIGNAL_CHANNEL }, signal: item }
    : form === 'arg' ? { arg: { channel: OKX_SIGNAL_CHANNEL, ...item } }
    : form === 'top-level-channel' ? { channel: OKX_SIGNAL_CHANNEL, data: [item] }
    : form === 'numeric-chain' ? envelope([row(501)], 501)
    : envelope([{ ...item, chainIndex: undefined }], '501');
  try {
    const parsed = parseOkxSignalMessage(message);
    expect(parsed).toHaveLength(1);
    socket.deliver(message);
    expect(received).toEqual(parsed);
    expect(rejected).toEqual([]);
  } finally { client.stop(); }
});
it('rejects an unconfirmed actual network even without an envelope chain', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    socket.deliver(envelope([row('56')]));
    expect(received).toEqual([]);
    expect(rejected).toEqual(['signal_subscription_unconfirmed']);
  } finally { client.stop(); }
});
it('rejects a conflicting row even if both networks have ACKed; keeps its consistent sibling', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    socket.deliver(ack('56'));
    socket.deliver(envelope([row('56'), row('501')], '501'));
    expect(received.map(s => s.chain)).toEqual(['SOLANA']);
    expect(rejected).toEqual(['signal_chain_mismatch']);
  } finally { client.stop(); }
});
it('checks every network in a mixed batch independently before and after its ACK', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    const message = envelope([row('501'), row('56')]);
    socket.deliver(message);
    expect(received.map(s => s.chain)).toEqual(['SOLANA']);
    expect(rejected).toEqual(['signal_subscription_unconfirmed']);
    socket.deliver(ack('56')); socket.deliver(message);
    expect(received.map(s => s.chain)).toEqual(['SOLANA', 'SOLANA', 'BNB']);
    // Re-delivery is passed to durable providerKey deduplication, not dropped here.
    expect(received[0]?.providerKey).toBe(received[1]?.providerKey);
  } finally { client.stop(); }
});
it.each([undefined, null, '', '999999', false, {}])('does not admit a missing/unknown row network: %j', chainIndex => {
  const { socket, client, received, rejected } = fixture();
  try {
    const message = envelope([row(chainIndex)]);
    expect(parseOkxSignalMessage(message)).toEqual([]);
    socket.deliver(message);
    expect(received).toEqual([]);
    expect(rejected).toEqual(['signal_parse_failed']);
  } finally { client.stop(); }
});
it('unknown explicit envelope cannot confer trust on a known row', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    socket.deliver(envelope([row('501')], '999999'));
    expect(received).toEqual([]);
    expect(rejected).toEqual(['signal_chain_mismatch']);
  } finally { client.stop(); }
});
it('an unknown explicit row is not replaced by the acknowledged envelope chain', () => {
  const { socket, client, received, rejected } = fixture();
  try {
    socket.deliver(envelope([row('999999')], '501'));
    expect(received).toEqual([]);
    expect(rejected).toEqual(['signal_parse_failed']);
  } finally { client.stop(); }
});
it('disconnect invalidates ACKs immediately, including queued old callbacks; new socket needs its own ACK', () => {
  const { socket, sockets, client, received } = fixture();
  try {
    const message = envelope([row('501')], '501');
    socket.deliver(message); expect(received).toHaveLength(1);
    const queuedOldCallback = socket.onmessage!;
    socket.onclose?.();
    queuedOldCallback({ data: JSON.stringify(message) });
    expect(received).toHaveLength(1);
    vi.advanceTimersByTime(1_000);
    const next = sockets[1]!; next.onopen?.(); next.deliver({ event: 'login', code: '0' });
    queuedOldCallback({ data: JSON.stringify(ack('501')) });
    next.deliver(message); expect(received).toHaveLength(1);
    next.deliver(ack('501')); next.deliver(message);
    expect(received).toHaveLength(2);
    expect(received[0]?.providerKey).toBe(received[1]?.providerKey);
    // Old callbacks cannot use the now-valid new generation either.
    queuedOldCallback({ data: JSON.stringify(message) });
    expect(received).toHaveLength(2);
  } finally { client.stop(); }
});
