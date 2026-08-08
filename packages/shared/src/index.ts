/**
 * Общий контракт между API и фронтендом: справочник сетей.
 *
 * Раньше метаданные сетей дублировались в apps/web (подписи для UI) и
 * apps/api (chainId, нативный символ). Дубликат такого рода расходится
 * ровно в тот момент, когда добавляется новая сеть.
 *
 * Пакет подключается как type-only: сборки не требует, импортируется
 * напрямую из исходников (main указывает на .ts).
 */

export type Chain = 'SOLANA' | 'BNB' | 'ROBINHOOD' | 'ETHEREUM' | 'BASE';

export interface ChainMeta {
  /** Человекочитаемое имя для интерфейса. */
  label: string;
  /** Нативная валюта сети. */
  nativeSymbol: string;
  /** EVM chainId. Для Solana не применимо. */
  chainId: number | null;
  /** Стандартное число знаков для нативного токена. */
  nativeDecimals: number;
  /** Ссылка на обозреватель: подставляется сигнатура транзакции. */
  explorerTx: (sig: string) => string;
}

export const CHAINS: Record<Chain, ChainMeta> = {
  SOLANA: {
    label: 'Solana',
    nativeSymbol: 'SOL',
    chainId: null,
    nativeDecimals: 9,
    explorerTx: (s) => `https://solscan.io/tx/${s}`,
  },
  BNB: {
    label: 'BNB Chain',
    nativeSymbol: 'BNB',
    chainId: 56,
    nativeDecimals: 18,
    explorerTx: (s) => `https://bscscan.com/tx/${s}`,
  },
  ROBINHOOD: {
    // Arbitrum Orbit L2, mainnet с 1 июля 2026.
    label: 'Robinhood Chain',
    nativeSymbol: 'ETH',
    chainId: null, // задаётся через RHC_CHAIN_ID — сеть молодая, значение уточняется
    nativeDecimals: 18,
    explorerTx: (s) => `https://explorer.robinhood.com/tx/${s}`,
  },
  ETHEREUM: {
    label: 'Ethereum',
    nativeSymbol: 'ETH',
    chainId: 1,
    nativeDecimals: 18,
    explorerTx: (s) => `https://etherscan.io/tx/${s}`,
  },
  BASE: {
    label: 'Base',
    nativeSymbol: 'ETH',
    chainId: 8453,
    nativeDecimals: 18,
    explorerTx: (s) => `https://basescan.org/tx/${s}`,
  },
};

export const CHAIN_LIST = Object.keys(CHAINS) as Chain[];

export function chainLabel(chain: string): string {
  return CHAINS[chain as Chain]?.label ?? chain;
}

/** Ставка комиссии за успех по умолчанию, в базисных пунктах. 1000 = 10%. */
export const DEFAULT_PERFORMANCE_FEE_BPS = 1000;
