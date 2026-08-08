import { D, type Numeric } from './money.js';

export interface TokenSignals {
  liquidityUsd?: Numeric | null;
  volume24hUsd?: Numeric | null;
  holders?: number | null;
  /** Доля предложения у топ-10 держателей, %. */
  topHolderPct?: Numeric | null;
  /** Доля сожжённой/залоченной ликвидности, %. */
  lpBurnedPct?: Numeric | null;
  ageHours?: number | null;
  mintAuthorityActive?: boolean;
  freezeAuthorityActive?: boolean;
  isHoneypot?: boolean;
  sellTaxBps?: number | null;
}

export interface RiskAssessment {
  /** 0 — безопасно, 100 — почти наверняка скам. */
  score: number;
  flags: string[];
  tradeable: boolean;
}

/**
 * Скоринг мем-коина перед публикацией колла и перед копированием.
 * Это не защита от убытков — это защита от очевидных ловушек:
 * ханипоты, незалоченная ликвидность, живой mint authority.
 */
export function assessToken(s: TokenSignals): RiskAssessment {
  const flags: string[] = [];
  let score = 0;

  if (s.isHoneypot) {
    return { score: 100, flags: ['ханипот: продажа заблокирована'], tradeable: false };
  }
  if (s.freezeAuthorityActive) {
    score += 30;
    flags.push('активен freeze authority — токен можно заморозить у держателей');
  }
  if (s.mintAuthorityActive) {
    score += 25;
    flags.push('активен mint authority — эмиссию можно допечатать');
  }

  const liq = D(s.liquidityUsd ?? 0);
  if (liq.lt(10_000)) {
    score += 25;
    flags.push(`ликвидность ${liq.toFixed(0)} USD — выход из позиции будет дорогим`);
  } else if (liq.lt(50_000)) {
    score += 10;
    flags.push('тонкая ликвидность');
  }

  const lpBurned = D(s.lpBurnedPct ?? 0);
  if (lpBurned.lt(50)) {
    score += 20;
    flags.push(`залочено только ${lpBurned.toFixed(0)}% LP — возможен rug pull`);
  }

  const top = D(s.topHolderPct ?? 0);
  if (top.gt(50)) {
    score += 20;
    flags.push(`топ-держатели контролируют ${top.toFixed(0)}% предложения`);
  } else if (top.gt(30)) {
    score += 8;
    flags.push('заметная концентрация у крупных держателей');
  }

  if ((s.holders ?? 0) < 200) {
    score += 10;
    flags.push('мало держателей');
  }
  if ((s.ageHours ?? 0) < 24) {
    score += 10;
    flags.push('токену меньше суток');
  }
  if ((s.sellTaxBps ?? 0) > 1000) {
    score += 15;
    flags.push(`налог на продажу ${((s.sellTaxBps ?? 0) / 100).toFixed(1)}%`);
  }

  const capped = Math.min(100, score);
  return { score: capped, flags, tradeable: capped < 85 };
}
