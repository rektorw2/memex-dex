/**
 * Готовность сетей на сервере: живой список OKX решает судьбу
 * Robinhood Chain, узел без сигналов сеть не открывает.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../lib/env.js', () => ({
  env: { BNB_RPC_URL: 'https://bsc', RHC_RPC_URL: 'https://rh', RHC_CHAIN_ID: 4663, OKX_API_KEY: 'k', OKX_API_SECRET: 's', OKX_PASSPHRASE: 'p' },
}));
vi.mock('../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() } }));
const probes = vi.hoisted(() => ({ BNB: 'VERIFIED', ROBINHOOD: 'VERIFIED' } as Record<string, string>));
vi.mock('./evm-chain-probe.js', () => ({ evmProbeState: (n: string) => ({ state: n === 'SOLANA' ? 'NOT_APPLICABLE' : probes[n], chainId: null, checkedAt: 1 }), refreshEvmProbes: async () => undefined }));

const market = await import('./okx-market.js');
const { agentNetworksReadiness, readyAgentNetworks, isAgentNetworkReady } = await import('./agent-networks.js');

describe('готовность сетей агента', () => {
  it('до ответа OKX: Solana и BNB по документации, Robinhood ждёт', () => {
    market.setOkxSignalChainIndexes(null);
    market.setOkxMarketChainIndexes(null);
    expect(readyAgentNetworks()).toEqual(['SOLANA', 'BNB']);
    const rh = agentNetworksReadiness().find((n) => n.chain === 'ROBINHOOD')!;
    expect(rh.available).toBe(false);
    expect(rh.reasons.map((r) => r.code)).toContain('OKX_SIGNAL_UNCONFIRMED');
    expect(isAgentNetworkReady('4663')).toBe(false);
  });

  it('Robinhood готова только когда OKX назвал 4663 и в сигналах, и в ценах, а узел ответил chainId 4663', () => {
    market.setOkxSignalChainIndexes(['501', '56', '4663']);
    market.setOkxMarketChainIndexes(['501', '56']);
    expect(readyAgentNetworks()).toEqual(['SOLANA', 'BNB']);
    expect(market.isOkxSupported('ROBINHOOD')).toBe(false);
    market.setOkxMarketChainIndexes(['501', '56', '4663']);
    expect(readyAgentNetworks()).toEqual(['SOLANA', 'BNB', 'ROBINHOOD']);
    expect(market.isOkxSupported('ROBINHOOD')).toBe(true);
    expect(isAgentNetworkReady('ROBINHOOD')).toBe(true);
    probes.ROBINHOOD = 'MISMATCH';
    expect(readyAgentNetworks()).toEqual(['SOLANA', 'BNB']);
    expect(agentNetworksReadiness().find((n) => n.chain === 'ROBINHOOD')!.reasons.map((r) => r.code)).toEqual(['RPC_CHAIN_MISMATCH']);
    probes.ROBINHOOD = 'VERIFIED';
    market.setOkxSignalChainIndexes(null);
    market.setOkxMarketChainIndexes(null);
  });

  it('живой список без BNB закрывает BNB, несмотря на документацию', () => {
    market.setOkxSignalChainIndexes(['501']);
    expect(readyAgentNetworks()).toEqual(['SOLANA']);
    market.setOkxSignalChainIndexes(null);
  });

  it('узел BNB не проверен — BNB недоступна, хотя списки OKX её содержат', () => {
    market.setOkxSignalChainIndexes(['501', '56']);
    market.setOkxMarketChainIndexes(['501', '56']);
    probes.BNB = 'NOT_VERIFIED';
    expect(readyAgentNetworks()).toEqual(['SOLANA']);
    expect(agentNetworksReadiness().find((n) => n.chain === 'BNB')!.reasons[0]!.code).toBe('RPC_NOT_VERIFIED');
    probes.BNB = 'VERIFIED';
    market.setOkxSignalChainIndexes(null);
    market.setOkxMarketChainIndexes(null);
  });
});


it('живые подтверждения OKX имеют срок действия; свежий ответ восстанавливает сеть', () => {
  vi.useFakeTimers();
  try {
    market.setOkxSignalChainIndexes(['501','56','4663']);market.setOkxMarketChainIndexes(['501','56','4663']);
    expect(isAgentNetworkReady('ROBINHOOD')).toBe(true);
    vi.advanceTimersByTime(66*60_000);
    expect(readyAgentNetworks()).toEqual([]);
    market.setOkxSignalChainIndexes(['501','56','4663']);market.setOkxMarketChainIndexes(['501','56','4663']);
    expect(isAgentNetworkReady('ROBINHOOD')).toBe(true);
  } finally { market.setOkxSignalChainIndexes(null);market.setOkxMarketChainIndexes(null);vi.useRealTimers(); }
});
