/**
 * Готовность сетей агента — факты сервера, правило из ядра.
 *
 * Сервер знает три вещи, которых нет у ядра: какие сети OKX назвал в
 * живых ответах `signal/supported/chain` и `market/supported/chain`
 * (сигналы и цены — разные списки) и что ответил узел сети на
 * `eth_chainId` (настроенный адрес — не проверенная сеть). Он собирает их в факты и отдаёт ядру
 * (`agentNetworkReadiness`), которое одно решает, доступна сеть или
 * нет и почему. Так интерфейс, воркер приёма сигналов и воркер агента
 * читают один и тот же вердикт, а не три похожих.
 */
import {
  AGENT_NETWORKS,
  AGENT_NETWORK_INFO,
  agentNetworkReadiness,
  normalizeAgentNetwork,
  type AgentNetwork,
  type AgentNetworkReadiness,
} from '@memex/core';
import { getOkxMarketChainIndexes, getOkxSignalChainIndexes } from './okx-market.js';
import { evmProbeState } from './evm-chain-probe.js';

export function agentNetworkReadinessOf(chain: AgentNetwork): AgentNetworkReadiness {
  return agentNetworkReadiness({
    chain,
    okxSignalChainIndexes: getOkxSignalChainIndexes(),
    okxMarketChainIndexes: getOkxMarketChainIndexes(),
    rpc: evmProbeState(chain).state,
  });
}

export function agentNetworksReadiness(): AgentNetworkReadiness[] {
  return AGENT_NETWORKS.map(agentNetworkReadinessOf);
}

/** Сети, в которых агент прямо сейчас может открывать сделки. */
export function readyAgentNetworks(): AgentNetwork[] {
  return AGENT_NETWORKS.filter((chain) => agentNetworkReadinessOf(chain).available);
}

/**
 * Готова ли сеть сигнала. Принимает и chainIndex OKX, и ключ сети:
 * неизвестное значение — не готова, без догадок.
 */
export function isAgentNetworkReady(chain: unknown): boolean {
  const network = normalizeAgentNetwork(chain);
  return network != null && agentNetworkReadinessOf(network).available;
}
