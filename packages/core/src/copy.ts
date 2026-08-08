import { D, ZERO, Decimal, type Numeric } from './money.js';

export type Chain = 'SOLANA' | 'BNB' | 'ROBINHOOD' | 'ETHEREUM' | 'BASE';
export type CopySizing = 'FIXED_USD' | 'PCT_EQUITY' | 'PROPORTIONAL';

export interface SubscriptionConfig {
  sizing: CopySizing;
  fixedUsd?: Numeric | null;
  pctEquity?: Numeric | null;
  maxPerTradeUsd?: Numeric | null;
  maxOpenPositions: number;
  dailyLossLimitUsd?: Numeric | null;
  allowedChains: Chain[];
  minLiquidityUsd?: Numeric | null;
  maxRiskScore?: number | null;
}

export interface FollowerState {
  equityUsd: Numeric;
  freeQuoteUsd: Numeric;
  openPositions: number;
  realizedPnlTodayUsd: Numeric;
  isFrozen: boolean;
  kycApproved: boolean;
}

export interface LeaderTrade {
  chain: Chain;
  tokenAddress: string;
  side: 'BUY' | 'SELL';
  valueUsd: Numeric;
  /** Доля капитала лидера, вложенная в эту сделку (0..1) — для PROPORTIONAL. */
  leaderPortfolioShare?: Numeric;
  tokenLiquidityUsd?: Numeric;
  tokenRiskScore?: number;
}

export type CopyDecision =
  | { copy: true; amountUsd: Decimal; notes: string[] }
  | { copy: false; reason: string };

/** Минимальный размер сделки — ниже него газ съедает смысл. */
const MIN_TRADE_USD = 5;

/**
 * Решение о копировании одной сделки лидера конкретным подписчиком.
 *
 * Порядок проверок важен: сначала блокирующие (заморозка, KYC), затем
 * фильтры риска, затем расчёт размера, затем лимиты капитала.
 * Каждый отказ возвращает человекочитаемую причину — она пишется в лог
 * подписчика, иначе поддержка утонет в вопросах «почему меня не скопировало».
 */
export function decideCopy(
  cfg: SubscriptionConfig,
  follower: FollowerState,
  trade: LeaderTrade,
): CopyDecision {
  if (follower.isFrozen) return { copy: false, reason: 'аккаунт заморожен' };
  if (!follower.kycApproved) return { copy: false, reason: 'KYC не пройден' };
  if (!cfg.allowedChains.includes(trade.chain)) {
    return { copy: false, reason: `сеть ${trade.chain} отключена в настройках подписки` };
  }

  if (cfg.minLiquidityUsd != null && trade.tokenLiquidityUsd != null) {
    if (D(trade.tokenLiquidityUsd).lt(D(cfg.minLiquidityUsd))) {
      return { copy: false, reason: 'ликвидность токена ниже порога подписки' };
    }
  }
  if (cfg.maxRiskScore != null && trade.tokenRiskScore != null) {
    if (trade.tokenRiskScore > cfg.maxRiskScore) {
      return { copy: false, reason: `риск-скор ${trade.tokenRiskScore} выше допустимого ${cfg.maxRiskScore}` };
    }
  }

  // Продажи копируются всегда: выход из позиции не должен блокироваться
  // лимитами на вход, иначе подписчик застрянет в падающем токене.
  if (trade.side === 'SELL') {
    return { copy: true, amountUsd: ZERO, notes: ['выход копируется пропорционально позиции подписчика'] };
  }

  if (cfg.dailyLossLimitUsd != null) {
    const lossToday = D(follower.realizedPnlTodayUsd);
    if (lossToday.lt(0) && lossToday.abs().gte(D(cfg.dailyLossLimitUsd))) {
      return { copy: false, reason: 'достигнут дневной лимит убытка' };
    }
  }
  if (follower.openPositions >= cfg.maxOpenPositions) {
    return { copy: false, reason: 'достигнут лимит открытых позиций' };
  }

  const notes: string[] = [];
  const equity = D(follower.equityUsd);
  let amount: Decimal;

  switch (cfg.sizing) {
    case 'FIXED_USD':
      amount = D(cfg.fixedUsd ?? 0);
      break;
    case 'PCT_EQUITY':
      amount = equity.mul(D(cfg.pctEquity ?? 0)).div(100);
      break;
    case 'PROPORTIONAL': {
      const share = D(trade.leaderPortfolioShare ?? 0).clamp(0, 1);
      amount = equity.mul(share);
      break;
    }
  }

  if (cfg.maxPerTradeUsd != null) {
    const cap = D(cfg.maxPerTradeUsd);
    if (amount.gt(cap)) {
      amount = cap;
      notes.push(`размер урезан до лимита ${cap.toFixed(2)} USD на сделку`);
    }
  }

  const free = D(follower.freeQuoteUsd);
  if (amount.gt(free)) {
    if (free.lt(MIN_TRADE_USD)) {
      return { copy: false, reason: 'недостаточно свободных средств' };
    }
    amount = free;
    notes.push('размер урезан до свободного остатка');
  }

  if (amount.lt(MIN_TRADE_USD)) {
    return { copy: false, reason: `расчётный размер ${amount.toFixed(2)} USD ниже минимума ${MIN_TRADE_USD} USD` };
  }

  return { copy: true, amountUsd: amount.toDecimalPlaces(2, Decimal.ROUND_DOWN), notes };
}

/** Доля позиции подписчика, которую надо продать вслед за лидером. */
export function copyExitFraction(params: {
  leaderQtyBefore: Numeric;
  leaderQtySold: Numeric;
}): Decimal {
  const before = D(params.leaderQtyBefore);
  if (before.lte(0)) return ZERO;
  return D(params.leaderQtySold).div(before).clamp(0, 1);
}
