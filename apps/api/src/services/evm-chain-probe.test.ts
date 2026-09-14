/** Проверка узла EVM: только совпавший chainId делает сеть проверенной. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/env.js', () => ({ env: { BNB_RPC_URL: 'https://bsc', RHC_RPC_URL: 'https://rh', RHC_CHAIN_ID: 4663 } }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { probeEvmChain, evmProbeState, refreshEvmProbes, resetEvmProbesForTests } = await import('./evm-chain-probe.js');

const reply = (hex: string | null, ok = true) => (async () => ({ ok, json: async () => ({ jsonrpc: '2.0', id: 1, result: hex }) })) as unknown as typeof fetch;

beforeEach(() => resetEvmProbesForTests());
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('узел EVM-сети', () => {
  it('до проверки — NOT_VERIFIED, Solana — NOT_APPLICABLE', () => {
    expect(evmProbeState('BNB').state).toBe('NOT_VERIFIED');
    expect(evmProbeState('SOLANA').state).toBe('NOT_APPLICABLE');
  });
  it('верный chainId — VERIFIED; чужой — MISMATCH; отказ — FAILED', async () => {
    expect((await probeEvmChain('ROBINHOOD', reply('0x1237'))).state).toBe('VERIFIED');
    expect((await probeEvmChain('ROBINHOOD', reply('0x38'))).state).toBe('MISMATCH');
    expect((await probeEvmChain('BNB', reply('0x38'))).state).toBe('VERIFIED');
    expect((await probeEvmChain('BNB', (async () => { throw new Error('down'); }) as unknown as typeof fetch)).state).toBe('FAILED');
    expect(evmProbeState('BNB').state).toBe('FAILED');
  });
  it('повторная проверка — не чаще раза в десять минут', async () => {
    const calls: string[] = [];
    const f = (async (url: string) => { calls.push(String(url)); return { ok: true, json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) }; }) as unknown as typeof fetch;
    await refreshEvmProbes(1_000, f);
    await refreshEvmProbes(2_000, f);
    expect(calls).toHaveLength(2);
    await refreshEvmProbes(1_000 + 11 * 60_000, f);
    expect(calls).toHaveLength(4);
  });
});

it('проверка RPC истекает даже если фоновый цикл перестал выполняться', async () => {
  await probeEvmChain('BNB', reply('0x38'),1000);
  expect(evmProbeState('BNB',1001).state).toBe('VERIFIED');
  expect(evmProbeState('BNB',601000).state).toBe('NOT_VERIFIED');
});

it('Robinhood RPC failure retries after 15 seconds, independently of a successful BNB probe', async () => {
  let failed = true;
  const f = vi.fn(async (url: string) => ({ ok: !(url.includes('rh') && failed), json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) })) as unknown as typeof fetch;
  await refreshEvmProbes(1000, f);
  expect(evmProbeState('ROBINHOOD', 1000).state).toBe('FAILED');
  failed = false;
  await refreshEvmProbes(15999, f);
  expect(f).toHaveBeenCalledTimes(2);
  await refreshEvmProbes(16000, f);
  expect(f).toHaveBeenCalledTimes(3);
  expect(evmProbeState('ROBINHOOD', 16000).state).toBe('VERIFIED');
});

it('repeated failures use bounded backoff and repeated ticks do not flood RPC', async () => {
  const f = vi.fn(async (url: string) => ({ ok: !url.includes('rh'), json: async () => ({ result: '0x38' }) })) as unknown as typeof fetch;
  for (let now = 1000; now <= 166000; now += 1000) await refreshEvmProbes(now, f);
  // BNB once; Robinhood at 1, 16, 46, 106, 166 seconds.
  expect(f).toHaveBeenCalledTimes(6);
  expect(evmProbeState('ROBINHOOD', 166000).state).toBe('FAILED');
});

it('an expired confirmation stays unavailable until a successful short retry', async () => {
  await probeEvmChain('BNB', reply('0x38'), 1000);
  const f = vi.fn(async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
  await refreshEvmProbes(601000, f);
  expect(evmProbeState('BNB', 601000).state).toBe('FAILED');
  await refreshEvmProbes(616000, (async (url: string) => ({ ok: true, json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) })) as unknown as typeof fetch);
  expect(evmProbeState('BNB', 616000).state).toBe('VERIFIED');
});

it('overlapping refreshes share each network probe', async () => {
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const f = vi.fn(async (url: string) => { await wait; return { ok: true, json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) }; }) as unknown as typeof fetch;
  const tasks = [refreshEvmProbes(1000, f), refreshEvmProbes(1000, f)];
  release();
  await Promise.all(tasks);
  expect(f).toHaveBeenCalledTimes(2);
});

it('success resets the failure backoff, including after a later expired confirmation', async () => {
  let failed = true;
  const f = vi.fn(async (url: string) => ({ ok: !(url.includes('rh') && failed), json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) })) as unknown as typeof fetch;
  await refreshEvmProbes(1_000, f);
  await refreshEvmProbes(16_000, f);
  await refreshEvmProbes(46_000, f);
  failed = false;
  await refreshEvmProbes(106_000, f);
  expect(evmProbeState('ROBINHOOD', 106_000).state).toBe('VERIFIED');
  failed = true;
  await refreshEvmProbes(706_000, f);
  expect(evmProbeState('ROBINHOOD', 706_000).state).toBe('FAILED');
  expect(f).toHaveBeenCalledTimes(7);
  failed = false;
  await refreshEvmProbes(720_999, f);
  expect(f).toHaveBeenCalledTimes(7);
  await refreshEvmProbes(721_000, f);
  expect(f).toHaveBeenCalledTimes(8);
  expect(evmProbeState('ROBINHOOD', 721_000).state).toBe('VERIFIED');
});

it('MISMATCH remains unavailable until a matching response and uses the same short retry', async () => {
  let wrongNetwork = true;
  const f = vi.fn(async (url: string) => ({ ok: true, json: async () => ({ result: url.includes('rh') && !wrongNetwork ? '0x1237' : '0x38' }) })) as unknown as typeof fetch;
  await refreshEvmProbes(1_000, f);
  expect(evmProbeState('ROBINHOOD', 1_000)).toMatchObject({ state: 'MISMATCH', chainId: 56 });
  wrongNetwork = false;
  await refreshEvmProbes(15_999, f);
  expect(f).toHaveBeenCalledTimes(2);
  expect(evmProbeState('ROBINHOOD', 15_999).state).toBe('MISMATCH');
  await refreshEvmProbes(16_000, f);
  expect(f).toHaveBeenCalledTimes(3);
  expect(evmProbeState('ROBINHOOD', 16_000).state).toBe('VERIFIED');
});

it('TTL expires at the exact boundary and an unfinished refresh cannot extend it', async () => {
  await refreshEvmProbes(1_000, (async (url: string) => ({ ok: true, json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) })) as unknown as typeof fetch);
  expect(evmProbeState('BNB', 600_999).state).toBe('VERIFIED');
  expect(evmProbeState('BNB', 601_000).state).toBe('NOT_VERIFIED');
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = vi.fn(async () => { await pending; return { ok: false }; }) as unknown as typeof fetch;
  const tasks = [refreshEvmProbes(601_000, f), refreshEvmProbes(601_001, f)];
  try {
    expect(evmProbeState('BNB', 601_001).state).toBe('NOT_VERIFIED');
    expect(f).toHaveBeenCalledTimes(2);
  } finally { release(); await Promise.all(tasks); }
  expect(evmProbeState('BNB', 601_002).state).toBe('FAILED');
});

it('a stalled BNB request does not delay Robinhood confirmation or duplicate direct probes', async () => {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const f = vi.fn(async (url: string) => {
    if (!url.includes('rh')) await stalled;
    return { ok: true, json: async () => ({ result: url.includes('rh') ? '0x1237' : '0x38' }) };
  }) as unknown as typeof fetch;
  const batch = refreshEvmProbes(1_000, f);
  try {
    // Await the shared Robinhood operation while BNB is still suspended.
    const robinhood = await probeEvmChain('ROBINHOOD', f, 1_000);
    expect(robinhood.state).toBe('VERIFIED');
    expect(evmProbeState('BNB', 1_000).state).toBe('NOT_VERIFIED');
    expect(f).toHaveBeenCalledTimes(2);
  } finally { release(); await batch; }
});

it('a fresh module starts without cached permission or inherited failure backoff', async () => {
  const f = vi.fn(async (url: string) => ({ ok: !url.includes('rh'), json: async () => ({ result: '0x38' }) })) as unknown as typeof fetch;
  await refreshEvmProbes(1_000, f);
  await refreshEvmProbes(16_000, f);
  await refreshEvmProbes(46_000, f);
  vi.resetModules();
  const restarted = await import('./evm-chain-probe.js');
  expect(restarted.evmProbeState('BNB', 47_000).state).toBe('NOT_VERIFIED');
  expect(restarted.evmProbeState('ROBINHOOD', 47_000).state).toBe('NOT_VERIFIED');
  await restarted.refreshEvmProbes(47_000, f);
  expect(f).toHaveBeenCalledTimes(6);
  expect(restarted.evmProbeState('BNB', 47_000).state).toBe('VERIFIED');
  expect(restarted.evmProbeState('ROBINHOOD', 47_000).state).toBe('FAILED');
});

it.each(['headers', 'body'])('an aborted %s wait releases the shared probe and recovery keeps the original 15s retry', async stage => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
    expect(ms).toBe(8_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  });
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const payload = { result: url.includes('rh') ? '0x1237' : '0x38' };
    if (!url.includes('rh')) return { ok: true, json: async () => payload };
    const blocked = () => new Promise<never>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    if (stage === 'headers') return blocked();
    return { ok: true, json: blocked };
  }) as unknown as typeof fetch;
  const tasks = [refreshEvmProbes(1_000, f), refreshEvmProbes(1_000, f)];
  await vi.advanceTimersByTimeAsync(7_999);
  expect(evmProbeState('ROBINHOOD', 8_999).state).toBe('NOT_VERIFIED');
  await vi.advanceTimersByTimeAsync(1);
  await Promise.all(tasks);
  expect(evmProbeState('ROBINHOOD', 9_000).state).toBe('FAILED');
  expect(f).toHaveBeenCalledTimes(2);
  const recovered = vi.fn(reply('0x1237'));
  await refreshEvmProbes(15_999, recovered);
  expect(recovered).not.toHaveBeenCalled();
  await refreshEvmProbes(16_000, recovered);
  expect(recovered).toHaveBeenCalledTimes(1);
  expect(evmProbeState('ROBINHOOD', 16_000).state).toBe('VERIFIED');
});

it.each(['0x38junk', '0x38.1', '38', ' 0x38', '0x038', '0x20000000000000'])('malformed or unsafe chainId %s cannot confirm BNB', async value => {
  expect((await probeEvmChain('BNB', reply(value), 1_000)).state).toBe('FAILED');
  expect(evmProbeState('BNB', 1_000)).toMatchObject({ state: 'FAILED', chainId: null });
});

it('an RPC error cannot grant permission even if the response also contains a matching result', async () => {
  const f = (async () => ({ ok: true, json: async () => ({ result: '0x38', error: { code: -32603, message: 'upstream failure' } }) })) as unknown as typeof fetch;
  expect((await probeEvmChain('BNB', f, 1_000)).state).toBe('FAILED');
});
