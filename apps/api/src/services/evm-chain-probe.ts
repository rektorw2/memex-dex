/**
 * Проверка узла EVM-сети: `eth_chainId` должен совпасть с ожидаемым.
 *
 * Адрес узла в настройках ничего не доказывает: за ним может быть
 * другая сеть, тестовая сеть или ничего. Сеть считается проверенной
 * только после ответа с нужным chainId, и проверка повторяется —
 * узел могли подменить. Результат кэшируется: спрашивать узел на
 * каждый запрос снимка незачем.
 */
import { AGENT_NETWORK_INFO, type AgentNetwork, type RpcProbeState } from '@memex/core';
import { env } from '../lib/env.js';
import { logger } from '../lib/logger.js';

export interface EvmProbeResult {
  state: RpcProbeState;
  chainId: number | null;
  checkedAt: number | null;
}

const PROBE_TTL_MS = 10 * 60_000;
const results = new Map<AgentNetwork, EvmProbeResult>();

function rpcUrlOf(network: AgentNetwork): string | null {
  if (network === 'BNB') return env.BNB_RPC_URL || null;
  if (network === 'ROBINHOOD') return env.RHC_RPC_URL && env.RHC_CHAIN_ID ? env.RHC_RPC_URL : null;
  return null;
}

export function evmProbeState(network: AgentNetwork, now = Date.now()): EvmProbeResult {
  if (AGENT_NETWORK_INFO[network].chainId == null) return { state: 'NOT_APPLICABLE', chainId: null, checkedAt: null };
  if (!rpcUrlOf(network)) return { state: 'NOT_CONFIGURED', chainId: null, checkedAt: null };
  const result = results.get(network);
  if (result?.state === 'VERIFIED' && result.checkedAt != null && now - result.checkedAt >= PROBE_TTL_MS) {
    return { ...result, state: 'NOT_VERIFIED' };
  }
  return result ?? { state: 'NOT_VERIFIED', chainId: null, checkedAt: null };
}

/** Один запрос `eth_chainId`; ответ — состояние, никаких исключений наружу. */
export async function probeEvmChain(network: AgentNetwork, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<EvmProbeResult> {
  const expected = AGENT_NETWORK_INFO[network].chainId;
  if (expected == null) return { state: 'NOT_APPLICABLE', chainId: null, checkedAt: null };
  const url = rpcUrlOf(network);
  if (!url) return { state: 'NOT_CONFIGURED', chainId: null, checkedAt: null };
  let result: EvmProbeResult;
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(8_000),
    });
    const json: any = res.ok ? await res.json().catch(() => null) : null;
    const chainId = typeof json?.result === 'string' ? Number.parseInt(json.result, 16) : null;
    result = chainId == null || !Number.isFinite(chainId)
      ? { state: 'FAILED', chainId: null, checkedAt: now }
      : chainId === expected
        ? { state: 'VERIFIED', chainId, checkedAt: now }
        : { state: 'MISMATCH', chainId, checkedAt: now };
  } catch {
    result = { state: 'FAILED', chainId: null, checkedAt: now };
  }
  results.set(network, result);
  if (result.state !== 'VERIFIED') logger.warn({ network, state: result.state, chainId: result.chainId }, 'узел EVM-сети не подтверждён');
  return result;
}

/** Проверить, если давно не проверяли. Вызывается из фонового цикла. */
export async function refreshEvmProbes(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<void> {
  for (const network of ['BNB', 'ROBINHOOD'] as const) {
    const current = evmProbeState(network, now);
    if (current.state === 'NOT_CONFIGURED' || current.state === 'NOT_APPLICABLE') continue;
    if (current.checkedAt != null && now - current.checkedAt < PROBE_TTL_MS) continue;
    await probeEvmChain(network, fetchImpl, now);
  }
}

export function resetEvmProbesForTests(): void {
  results.clear();
}
