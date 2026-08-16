export interface Token {
  id: string;
  symbol: string;
  name: string;
  chain: string;
  address: string;
  priceUsd: string | null;
  priceChange24h: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  fdvUsd: string | null;
  riskScore: number | null;
  logoUrl: string | null;
  riskLevel?: 'verified' | 'low' | 'medium' | 'high' | 'blocked' | 'pending' | null;
  riskCodes?: string[];
  isRegistered?: boolean;
  scamVerdict?: string | null;
  scamReasons?: {
    level?: string;
    score?: number;
    reasons?: Array<{ code: string; message: string }>;
    sources?: Record<string, unknown>;
    blockers?: string[];
    warnings?: string[];
  } | null;
  scamCheckedAt?: string | null;
  buys24h?: number | null;
  sells24h?: number | null;
  isVerified: boolean;
  hasChart: boolean;
  isQuote: boolean;
}

export const CHAIN_LABEL: Record<string, string> = {
  SOLANA: 'Solana',
  BNB: 'BNB Chain',
  ROBINHOOD: 'Robinhood Chain',
  ETHEREUM: 'Ethereum',
  BASE: 'Base',
};

/**
 * Сортировки списка.
 *
 * «Растущие» и «Падающие» вынесены в быстрые фильтры отдельно от
 * выпадающего списка: ими пользуются постоянно, и прятать их за два
 * нажатия значит замедлять самое частое действие.
 */
export const SORT_OPTIONS = [
  ['volume', 'По объёму'],
  ['liquidity', 'По ликвидности'],
  ['new', 'Новые'],
] as const;

export const QUICK_FILTERS = [
  ['gainers', 'Растущие'],
  ['losers', 'Падающие'],
  ['new', 'Новые'],
] as const;

/** Таймфреймы графика. */
export const INTERVALS = [
  ['5m', '5м'],
  ['15m', '15м'],
  ['1h', '1ч'],
  ['4h', '4ч'],
  ['1d', '1д'],
] as const;
