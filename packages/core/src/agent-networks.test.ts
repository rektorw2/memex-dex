import { describe, expect, it } from 'vitest';
import { AGENT_NETWORKS, AGENT_NETWORK_INFO, PAPER_COST_MODELS, agentNetworkReadiness, normalizeAgentNetwork } from './agent-networks.js';
import { PAPER_AGENT_STRATEGIES, evaluatePaperSignal, strategyForNetwork } from './paper-agent.js';

describe('сети агента', () => {
  it('три сети, у каждой нативный актив и модель расходов', () => {
    expect(AGENT_NETWORKS).toEqual(['SOLANA', 'BNB', 'ROBINHOOD']);
    expect(AGENT_NETWORK_INFO.ROBINHOOD).toMatchObject({ chainId: 4663, nativeSymbol: 'ETH', okxChainIndex: '4663' });
    expect(AGENT_NETWORK_INFO.BNB).toMatchObject({ chainId: 56, nativeSymbol: 'BNB' });
    for (const chain of AGENT_NETWORKS) expect(PAPER_COST_MODELS[chain].costModelKey).toContain(chain.toLowerCase());
  });

  it('нормализует имена и chainIndex источника, неизвестное не угадывает', () => {
    expect(normalizeAgentNetwork('501')).toBe('SOLANA');
    expect(normalizeAgentNetwork('BSC')).toBe('BNB');
    expect(normalizeAgentNetwork('56')).toBe('BNB');
    expect(normalizeAgentNetwork('4663')).toBe('ROBINHOOD');
    expect(normalizeAgentNetwork('ETHEREUM')).toBeNull();
    expect(normalizeAgentNetwork('1')).toBeNull();
  });

  const ALL = ['501', '56', '4663'];
  it('готовность считается по живому списку OKX, а не по константе', () => {
    const okx = ['501', '56'];
    expect(agentNetworkReadiness({ chain: 'SOLANA', okxSignalChainIndexes: okx, okxMarketChainIndexes: okx, rpc: 'NOT_APPLICABLE' })).toMatchObject({ available: true, signalsConfirmed: true, reasons: [] });
    const rh = agentNetworkReadiness({ chain: 'ROBINHOOD', okxSignalChainIndexes: okx, okxMarketChainIndexes: ALL, rpc: 'VERIFIED' });
    expect(rh.available).toBe(false);
    expect(rh.reasons.map((r) => r.code)).toEqual(['OKX_SIGNAL_UNSUPPORTED']);
    expect(rh.reasons[0]!.message).toContain('4663');
  });

  it('пока списки OKX не получены: документированной сети верим по документации, Robinhood ждёт подтверждения', () => {
    const bnb = agentNetworkReadiness({ chain: 'BNB', okxSignalChainIndexes: null, okxMarketChainIndexes: null, rpc: 'VERIFIED' });
    expect(bnb).toMatchObject({ available: true, signalsConfirmed: false, signalBasis: 'docs' });
    const rh = agentNetworkReadiness({ chain: 'ROBINHOOD', okxSignalChainIndexes: null, okxMarketChainIndexes: null, rpc: 'VERIFIED' });
    expect(rh.available).toBe(false);
    expect(rh.signalBasis).toBe('none');
    expect(rh.reasons.map((r) => r.code)).toEqual(['OKX_SIGNAL_UNCONFIRMED', 'OKX_MARKET_UNCONFIRMED']);
  });

  it('живой список, в котором сети нет, сильнее документации', () => {
    const v = agentNetworkReadiness({ chain: 'BNB', okxSignalChainIndexes: ['501'], okxMarketChainIndexes: ALL, rpc: 'VERIFIED' });
    expect(v.available).toBe(false);
    expect(v.reasons[0]!.code).toBe('OKX_SIGNAL_UNSUPPORTED');
  });

  it('поддержка сигналов не равна работающим ценам: Market API проверяется отдельно', () => {
    const v = agentNetworkReadiness({ chain: 'ROBINHOOD', okxSignalChainIndexes: ALL, okxMarketChainIndexes: ['501', '56'], rpc: 'VERIFIED' });
    expect(v.signalsConfirmed).toBe(true);
    expect(v.available).toBe(false);
    expect(v.reasons.map((r) => r.code)).toEqual(['OKX_MARKET_UNSUPPORTED']);
  });

  it('настроенный узел — не проверенная сеть: до eth_chainId сеть недоступна, чужой chainId — несовпадение', () => {
    for (const [rpc, code] of [['NOT_CONFIGURED', 'RPC_NOT_CONFIGURED'], ['NOT_VERIFIED', 'RPC_NOT_VERIFIED'], ['MISMATCH', 'RPC_CHAIN_MISMATCH'], ['FAILED', 'RPC_FAILED']] as const) {
      const v = agentNetworkReadiness({ chain: 'ROBINHOOD', okxSignalChainIndexes: ALL, okxMarketChainIndexes: ALL, rpc });
      expect(v.available, rpc).toBe(false);
      expect(v.reasons.map((r) => r.code)).toEqual([code]);
    }
    expect(agentNetworkReadiness({ chain: 'ROBINHOOD', okxSignalChainIndexes: ALL, okxMarketChainIndexes: ALL, rpc: 'VERIFIED' }).available).toBe(true);
    // У Solana chainId нет — состояние узла на готовность не влияет.
    expect(agentNetworkReadiness({ chain: 'SOLANA', okxSignalChainIndexes: ALL, okxMarketChainIndexes: ALL, rpc: 'NOT_APPLICABLE' }).available).toBe(true);
  });

  it('стратегия получает модель расходов сети, пороги не меняются', () => {
    const base = PAPER_AGENT_STRATEGIES[0]!;
    const bnb = strategyForNetwork(base, 'BNB');
    expect(bnb.minAmountUsd).toBe(base.minAmountUsd);
    expect(bnb.costModelKey).toBe('bnb-conservative-v1');
    expect(bnb.networkFeeUsdPerSide).toBe(0.15);
  });

  it('решение агента принимает сигналы BNB и Robinhood, а Ethereum — нет', () => {
    const base = PAPER_AGENT_STRATEGIES[0]!;
    const now = 1_700_000_000_000;
    const snap = (network: string) => ({ network, walletTypes: ['smart_money'] as never, amountUsd: 5_000, signaledAtMs: now - 5_000, receivedAtMs: now - 4_000, origin: 'WEBSOCKET_LIVE' as const, poolCreatedAtMs: now - 60_000, priceUsd: 1 });
    expect(evaluatePaperSignal(base, snap('56'), now).code).not.toBe('NETWORK_NOT_SUPPORTED_PHASE_2');
    expect(evaluatePaperSignal(base, snap('4663'), now).code).not.toBe('NETWORK_NOT_SUPPORTED_PHASE_2');
    expect(evaluatePaperSignal(base, snap('1'), now).code).toBe('NETWORK_NOT_SUPPORTED_PHASE_2');
  });
});

it.each(['SOLANA','BNB','ROBINHOOD'] as const)('все пять стратегий создают допустимое решение с собственной моделью расходов в %s', network => {
  const now=1_700_000_000_000;
  const decisions=PAPER_AGENT_STRATEGIES.map(strategy => {
    const config=strategyForNetwork(strategy,network);
    expect(config.minAmountUsd).toBe(strategy.minAmountUsd);
    expect(config.costModelKey).toBe(PAPER_COST_MODELS[network].costModelKey);
    return evaluatePaperSignal(config,{network,walletTypes:['smart_money'],amountUsd:20_000,signaledAtMs:now-15_000,receivedAtMs:now-1000,origin:'WEBSOCKET_LIVE',poolCreatedAtMs:now-60_000,priceUsd:1},now);
  });
  expect(decisions).toHaveLength(5);
  expect(decisions.every(d=>d.state==='ELIGIBLE')).toBe(true);
});
