/** Проверка узла EVM: только совпавший chainId делает сеть проверенной. */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/env.js', () => ({ env: { BNB_RPC_URL: 'https://bsc', RHC_RPC_URL: 'https://rh', RHC_CHAIN_ID: 4663 } }));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));

const { probeEvmChain, evmProbeState, refreshEvmProbes, resetEvmProbesForTests } = await import('./evm-chain-probe.js');

const reply = (hex: string | null, ok = true) => (async () => ({ ok, json: async () => ({ jsonrpc: '2.0', id: 1, result: hex }) })) as unknown as typeof fetch;

beforeEach(() => resetEvmProbesForTests());

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
