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
const FAILURE_RETRY_MS = 15_000;
const MAX_FAILURE_RETRY_MS = 60_000;
const results = new Map<AgentNetwork, EvmProbeResult>();
const retries = new Map<AgentNetwork, { failures: number; nextAt: number }>();
const inFlight = new Map<AgentNetwork, Promise<EvmProbeResult>>();

function rpcUrlOf(network: AgentNetwork): string | null {
  if (network === 'BNB') return env.BNB_RPC_URL || null;
  if (network === 'ROBINHOOD') return env.RHC_RPC_URL && env.RHC_CHAIN_ID ? env.RHC_RPC_URL : null;
  return null;
}

function chainIdOf(payload: unknown): number | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const response = payload as Record<string, unknown>;
  // An error never proves the network, even if an upstream also sends result.
  if ('error' in response) return null;
  const value = response.result;
  // Ethereum Quantity: validate the entire value before converting it.
  // parseInt alone accepts a matching prefix of malformed data ("0x38junk").
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) return null;
  const chainId = Number(value);
  return Number.isSafeInteger(chainId) ? chainId : null;
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
export function probeEvmChain(network: AgentNetwork, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<EvmProbeResult> {
  const pending = inFlight.get(network);
  if (pending) return pending;
  const request = performProbe(network, fetchImpl, now).finally(() => { inFlight.delete(network); });
  inFlight.set(network, request);
  return request;
}

async function performProbe(network: AgentNetwork, fetchImpl: typeof fetch, now: number): Promise<EvmProbeResult> {
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
    const json: unknown = res.ok ? await res.json().catch(() => null) : null;
    const chainId = chainIdOf(json);
    result = chainId == null
      ? { state: 'FAILED', chainId: null, checkedAt: now }
      : chainId === expected
        ? { state: 'VERIFIED', chainId, checkedAt: now }
        : { state: 'MISMATCH', chainId, checkedAt: now };
  } catch {
    result = { state: 'FAILED', chainId: null, checkedAt: now };
  }
  results.set(network, result);
  if (result.state === 'VERIFIED') {
    retries.delete(network);
  } else {
    const failures = Math.min(3, (retries.get(network)?.failures ?? 0) + 1);
    retries.set(network, { failures, nextAt: now + Math.min(MAX_FAILURE_RETRY_MS, FAILURE_RETRY_MS * 2 ** (failures - 1)) });
  }
  if (result.state !== 'VERIFIED') logger.warn({ network, state: result.state, chainId: result.chainId }, 'узел EVM-сети не подтверждён');
  return result;
}

/** Проверить, если давно не проверяли. Вызывается из фонового цикла. */
export async function refreshEvmProbes(now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<void> {
  await Promise.all((['BNB', 'ROBINHOOD'] as const).map(async network => {
    const current = evmProbeState(network, now);
    if (current.state === 'NOT_CONFIGURED' || current.state === 'NOT_APPLICABLE') return;
    // Ten minutes apply only to a successful confirmation. A failed request
    // must not disable a network for the whole success TTL.
    if (current.state === 'VERIFIED') return;
    if (now < (retries.get(network)?.nextAt ?? 0)) return;
    await probeEvmChain(network, fetchImpl, now);
  }));
}

export function resetEvmProbesForTests(): void {
  results.clear();
  retries.clear();
  inFlight.clear();
}
