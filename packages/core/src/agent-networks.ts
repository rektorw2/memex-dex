/**
 * Сети агента и их готовность.
 *
 * Сеть считается доступной агенту не потому, что до её узла удалось
 * достучаться, а потому, что подтверждено всё, без чего агент не
 * может ни принять решение, ни посчитать результат: сигналы OKX по
 * этой сети, источник цены, модель комиссий и учёт. Любое «нет» —
 * конкретная причина словами, а не серый бейдж.
 *
 * LIVE-готовность сюда не входит намеренно: она решается отдельной
 * лестницей (подпись, сверка, devnet), и сеть с рабочими сигналами
 * остаётся PAPER-сетью, пока та лестница не пройдена.
 */
import type { ChainKey } from './token-registry.js';
import { OKX_CHAIN_INDEX } from './okx-model.js';

/** Сети, которые агент ведёт. Порядок — порядок в интерфейсе. */
export type AgentNetwork = Extract<ChainKey, 'SOLANA' | 'BNB' | 'ROBINHOOD'>;

export const AGENT_NETWORKS: readonly AgentNetwork[] = ['SOLANA', 'BNB', 'ROBINHOOD'];

export function isAgentNetwork(value: unknown): value is AgentNetwork {
  return (AGENT_NETWORKS as readonly unknown[]).includes(value);
}

/**
 * Сеть из того, как её назвал источник.
 *
 * OKX присылает chainIndex; свои модели — ключ. Неизвестное значение
 * не угадывается: лучше пропустить сигнал, чем повести его не в той сети.
 */
export function normalizeAgentNetwork(value: unknown): AgentNetwork | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim().toUpperCase().replace(/[\s-]+/g, '_');
  const byAlias: Record<string, AgentNetwork> = {
    SOLANA: 'SOLANA', SOLANA_MAINNET: 'SOLANA', SOLANA_MAINNET_BETA: 'SOLANA', '501': 'SOLANA',
    BNB: 'BNB', BSC: 'BNB', BNB_CHAIN: 'BNB', BINANCE_SMART_CHAIN: 'BNB', '56': 'BNB',
    ROBINHOOD: 'ROBINHOOD', ROBINHOOD_CHAIN: 'ROBINHOOD', RHC: 'ROBINHOOD', '4663': 'ROBINHOOD',
  };
  return byAlias[normalized] ?? null;
}

export interface AgentNetworkInfo {
  chain: AgentNetwork;
  label: string;
  /** Нативный актив — им платятся комиссии и он учитывается отдельно от токенов. */
  nativeSymbol: string;
  /** Идентификатор EVM-сети; у Solana его нет. */
  chainId: number | null;
  okxChainIndex: string | null;
  /**
   * Сеть названа в документации OKX Signal API. Пока живой список не
   * получен, такой сети верится по документации; сети без этого
   * признака (Robinhood Chain) ждут подтверждения.
   */
  documentedByOkx: boolean;
  explorer: string;
}

export const AGENT_NETWORK_INFO: Record<AgentNetwork, AgentNetworkInfo> = {
  SOLANA: { chain: 'SOLANA', label: 'Solana', nativeSymbol: 'SOL', chainId: null, okxChainIndex: OKX_CHAIN_INDEX.SOLANA, documentedByOkx: true, explorer: 'https://solscan.io' },
  BNB: { chain: 'BNB', label: 'BNB Chain', nativeSymbol: 'BNB', chainId: 56, okxChainIndex: OKX_CHAIN_INDEX.BNB, documentedByOkx: true, explorer: 'https://bscscan.com' },
  /*
   * Robinhood Chain: Arbitrum L2, mainnet, chain ID 4663, газ — ETH
   * (docs.robinhood.com/chain/connecting, support-статья «Robinhood
   * Chain mainnet»). chainIndex OKX для неё в документации Signal API
   * не назван; поддержка подтверждается только живым ответом
   * `signal/supported/chain`.
   */
  ROBINHOOD: { chain: 'ROBINHOOD', label: 'Robinhood Chain', nativeSymbol: 'ETH', chainId: 4663, okxChainIndex: OKX_CHAIN_INDEX.ROBINHOOD, documentedByOkx: false, explorer: 'https://robinhoodchain.blockscout.com' },
};

/**
 * Модель расходов PAPER-сделки по сети. Консервативная: комиссия DEX
 * и проскальзывание одинаковы, сетевой сбор — типичный для сети.
 * Ключ версионирован: смена цифр — новый ключ, а не переписанная история.
 */
export interface PaperCostModel {
  costModelKey: string;
  tradeFeeBps: number;
  entrySlippageBps: number;
  exitSlippageBps: number;
  networkFeeUsdPerSide: number;
}

export const PAPER_COST_MODELS: Record<AgentNetwork, PaperCostModel> = {
  SOLANA: { costModelKey: 'solana-conservative-v1', tradeFeeBps: 30, entrySlippageBps: 100, exitSlippageBps: 100, networkFeeUsdPerSide: 0.02 },
  BNB: { costModelKey: 'bnb-conservative-v1', tradeFeeBps: 30, entrySlippageBps: 100, exitSlippageBps: 100, networkFeeUsdPerSide: 0.15 },
  ROBINHOOD: { costModelKey: 'robinhood-conservative-v1', tradeFeeBps: 30, entrySlippageBps: 100, exitSlippageBps: 100, networkFeeUsdPerSide: 0.03 },
};

/** Итог проверки узла EVM-сети: `eth_chainId` должен совпасть с ожидаемым. */
export type RpcProbeState = 'NOT_APPLICABLE' | 'NOT_CONFIGURED' | 'NOT_VERIFIED' | 'VERIFIED' | 'MISMATCH' | 'FAILED';

export interface AgentNetworkFacts {
  chain: AgentNetwork;
  /** Список сетей из `signal/supported/chain`; `null` — ещё не получен. */
  okxSignalChainIndexes: readonly string[] | null;
  /**
   * Список сетей OKX Market API (цены) — отдельный от сигналов:
   * поддержка сигналов не означает работающих цен. `null` — не получен.
   */
  okxMarketChainIndexes: readonly string[] | null;
  /** Проверка узла: настроенный адрес — не проверенная сеть. */
  rpc: RpcProbeState;
}

export type AgentNetworkReasonCode =
  | 'OKX_CHAIN_INDEX_UNKNOWN'
  | 'OKX_SIGNAL_UNSUPPORTED'
  | 'OKX_SIGNAL_UNCONFIRMED'
  | 'OKX_MARKET_UNSUPPORTED'
  | 'OKX_MARKET_UNCONFIRMED'
  | 'RPC_NOT_CONFIGURED'
  | 'RPC_NOT_VERIFIED'
  | 'RPC_CHAIN_MISMATCH'
  | 'RPC_FAILED';

export interface AgentNetworkReadiness {
  chain: AgentNetwork;
  label: string;
  nativeSymbol: string;
  available: boolean;
  /** Сигналы подтверждены живым списком OKX (не догадка по документации). */
  signalsConfirmed: boolean;
  /** На чём держится допуск: живой список, документация или ничего. */
  signalBasis: 'live' | 'docs' | 'none';
  reasons: Array<{ code: AgentNetworkReasonCode; message: string }>;
  costModelKey: string;
}

export function agentNetworkReadiness(facts: AgentNetworkFacts): AgentNetworkReadiness {
  const info = AGENT_NETWORK_INFO[facts.chain];
  const reasons: AgentNetworkReadiness['reasons'] = [];
  let signalBasis: AgentNetworkReadiness['signalBasis'] = 'none';
  if (info.okxChainIndex == null) {
    reasons.push({ code: 'OKX_CHAIN_INDEX_UNKNOWN', message: `OKX Signal API не индексирует ${info.label}: у сети нет chainIndex — сигналов быть не может` });
  } else if (facts.okxSignalChainIndexes == null) {
    // Живого списка нет. Документированной сети верим по документации —
    // иначе агент стоял бы до первого ответа OKX и после каждого рестарта.
    if (info.documentedByOkx) signalBasis = 'docs';
    else reasons.push({ code: 'OKX_SIGNAL_UNCONFIRMED', message: `OKX ещё не подтвердил сигналы по ${info.label}: список сетей Signal API не получен` });
  } else if (!facts.okxSignalChainIndexes.includes(info.okxChainIndex)) {
    reasons.push({ code: 'OKX_SIGNAL_UNSUPPORTED', message: `OKX Signal API не отдаёт сигналы по ${info.label} (chainIndex ${info.okxChainIndex} отсутствует в списке)` });
  } else {
    signalBasis = 'live';
  }
  const signalsConfirmed = signalBasis === 'live';

  // Цены — отдельный список OKX Market API; документированной сети верим по документации до ответа.
  if (info.okxChainIndex != null) {
    if (facts.okxMarketChainIndexes == null) {
      if (!info.documentedByOkx) reasons.push({ code: 'OKX_MARKET_UNCONFIRMED', message: `OKX Market API ещё не подтвердил цены по ${info.label}: список сетей не получен` });
    } else if (!facts.okxMarketChainIndexes.includes(info.okxChainIndex)) {
      reasons.push({ code: 'OKX_MARKET_UNSUPPORTED', message: `OKX Market API не отдаёт цены по ${info.label} (chainIndex ${info.okxChainIndex} отсутствует в списке)` });
    }
  }

  // Узел: для EVM нужен проверенный chainId, а не строка в настройках.
  if (info.chainId != null) {
    if (facts.rpc === 'NOT_CONFIGURED') reasons.push({ code: 'RPC_NOT_CONFIGURED', message: `Узел ${info.label} не настроен` });
    else if (facts.rpc === 'NOT_VERIFIED') reasons.push({ code: 'RPC_NOT_VERIFIED', message: `Узел ${info.label} ещё не проверен (ожидается eth_chainId = ${info.chainId})` });
    else if (facts.rpc === 'MISMATCH') reasons.push({ code: 'RPC_CHAIN_MISMATCH', message: `Узел ${info.label} отвечает другим chainId — это не ${info.label} (ожидается ${info.chainId})` });
    else if (facts.rpc === 'FAILED') reasons.push({ code: 'RPC_FAILED', message: `Узел ${info.label} не отвечает` });
  }
  return {
    chain: facts.chain,
    label: info.label,
    nativeSymbol: info.nativeSymbol,
    available: reasons.length === 0,
    signalsConfirmed,
    signalBasis,
    reasons,
    costModelKey: PAPER_COST_MODELS[facts.chain].costModelKey,
  };
}
