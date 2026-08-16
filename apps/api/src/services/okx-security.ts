/**
 * Расширенные сведения о токене от OKX и их перевод в причины риска.
 *
 * advanced-info — самый дорогой из запросов: он идёт по одному токену
 * и не поддерживает пакетную форму. Поэтому он не вызывается при
 * каждом обновлении списка. Список показывает то, что пришло вместе
 * с hot-token; подробности подгружаются, когда они действительно
 * нужны: при открытии токена, для первых видимых строк и при плановой
 * проверке.
 *
 * Отдельно о том, что здесь считается доказательством. Теги вроде
 * dexScreenerPaid и число упоминаний в соцсетях говорят о бюджете
 * на продвижение, а не о свойствах контракта. Скам с деньгами покупает
 * и оплаченное размещение, и упоминания, в первый же день. Поэтому
 * такие признаки собираются и показываются человеку, но в оценку
 * риска не входят — ни в плюс, ни в минус.
 *
 * История создателя, наоборот, входит. Разработчик, за которым числятся
 * брошенные токены, — самый предсказуемый из известных признаков:
 * человек, сделавший это трижды, сделает и в четвёртый раз.
 */

import {
  OKX_CHAIN_INDEX,
  okxNum,
  okxInt,
  okxStr,
  okxTime,
  okxBool,
  normalizePct,
  isOkxHardBlock,
  okxRiskBand,
  type ChainKey,
  type OkxRiskBand,
} from '@memex/core';
import { logger } from '../lib/logger.js';
import { cached } from '../lib/cache.js';

const TTL_MS = 15 * 60_000;

export interface AdvancedInfo {
  chain: ChainKey;
  address: string;

  /** Метки OKX: honeypot, communityRecognized, smartMoneyBuy и прочие. */
  tags: string[];
  /** Уровень риска по мнению OKX, 0–5. */
  riskControlLevel: number | null;

  lpBurnedPct: number | null;
  top10HoldPct: number | null;
  devHoldingPct: number | null;
  bundleHoldingPct: number | null;
  suspiciousHoldingPct: number | null;
  sniperHoldingPct: number | null;

  creatorAddress: string | null;
  /** Сколько токенов создателя закончились брошенным пулом. */
  devRugPullTokenCount: number | null;
  devCreateTokenCount: number | null;

  createdAt: Date | null;
  /** Профиль бумаги, если токен объявлен токенизированным активом. */
  stockProfile: Record<string, unknown> | null;
}

/**
 * Подробности по одному токену.
 *
 * Вызывается выборочно — см. описание модуля. Функция сама по себе
 * дешёвая только благодаря кешу; без него список из шестидесяти
 * токенов означал бы шестьдесят запросов на каждое обновление.
 */
export async function fetchAdvancedInfo(
  chain: ChainKey,
  address: string,
  call: <T>(method: 'GET' | 'POST', path: string, body?: unknown) => Promise<T | null>,
): Promise<AdvancedInfo | null> {
  const chainIndex = OKX_CHAIN_INDEX[chain];
  if (!chainIndex) return null;

  const path =
    `/api/v6/dex/market/token/advanced-info?chainIndex=${chainIndex}` +
    `&tokenContractAddress=${encodeURIComponent(address)}`;

  const hit = await cached(
    `okx:adv:${chain}:${address}`,
    async () => {
      const data = await call<unknown>('GET', path);
      return parseAdvancedInfo(data, chain, address);
    },
    { ttlMs: TTL_MS, staleMs: 60 * 60_000 },
  ).catch(() => null);

  return hit?.value ?? null;
}

export function parseAdvancedInfo(
  data: unknown,
  chain: ChainKey,
  address: string,
): AdvancedInfo | null {
  // Ответ приходит то объектом, то массивом из одного элемента.
  const raw = Array.isArray(data) ? data[0] : data;
  if (raw == null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const tags = Array.isArray(r.tokenTags)
    ? r.tokenTags.filter((t): t is string => typeof t === 'string')
    : [];

  return {
    chain,
    address,
    tags,
    riskControlLevel: okxInt(r.riskControlLevel ?? r.riskLevelControl),

    lpBurnedPct: normalizePct(okxNum(r.lpBurnedPercent)),
    top10HoldPct: normalizePct(okxNum(r.top10HoldPercent)),
    devHoldingPct: normalizePct(okxNum(r.devHoldingPercent)),
    bundleHoldingPct: normalizePct(okxNum(r.bundleHoldingPercent)),
    suspiciousHoldingPct: normalizePct(okxNum(r.suspiciousHoldingPercent)),
    sniperHoldingPct: normalizePct(okxNum(r.sniperHoldingPercent)),

    creatorAddress: okxStr(r.creatorAddress, 128),
    devRugPullTokenCount: okxInt(r.devRugPullTokenCount),
    devCreateTokenCount: okxInt(r.devCreateTokenCount),

    createdAt: okxTime(r.createTime),
    stockProfile:
      r.stockProfile && typeof r.stockProfile === 'object'
        ? (r.stockProfile as Record<string, unknown>)
        : null,
  };
}

// ──────────────────────────── Толкование тегов ──────────────────────────────

export interface TagReading {
  /** Контракт объявлен ловушкой. */
  isHoneypot: boolean;
  /** Ликвидности недостаточно по мнению OKX. */
  isLowLiquidity: boolean;
  /** Признан сообществом. Учитывается, но проверок не отменяет. */
  communityRecognized: boolean;
  /** Разработчик продал часть своей доли. */
  devSold: boolean;
  /** Разработчик вышел полностью. */
  devSoldAll: boolean;
  /** Претендует на статус токенизированного актива. */
  claimsRwa: boolean;
  /**
   * Признаки внимания рынка: покупки умных денег, оплаченное
   * продвижение, перехват сообществом. Показываются человеку,
   * но в оценку риска не входят — ни один из них не является
   * свидетельством о свойствах контракта.
   */
  attention: string[];
}

const RWA_HINTS = ['rwa', 'xstock', 'ondo', 'tokenizedstock', 'equity'];

export function readTags(tags: string[]): TagReading {
  const has = (name: string) => tags.some((t) => t.toLowerCase() === name.toLowerCase());

  return {
    isHoneypot: has('honeypot'),
    isLowLiquidity: has('lowLiquidity'),
    communityRecognized: has('communityRecognized'),
    devSold: has('devHoldingStatusSell'),
    devSoldAll: has('devHoldingStatusSellAll'),
    claimsRwa: tags.some((t) => RWA_HINTS.some((h) => t.toLowerCase().includes(h))),
    attention: tags.filter((t) =>
      ['smartMoneyBuy', 'dexScreenerPaid', 'dexBoost', 'dexScreenerTokenCommunityTakeOver'].some(
        (a) => a.toLowerCase() === t.toLowerCase(),
      ),
    ),
  };
}

// ──────────────────── Перевод в уровень риска OKX ───────────────────────────

export interface OkxRiskReading {
  band: OkxRiskBand;
  hardBlock: boolean;
  level: number | null;
  explanation: string;
}

/**
 * Что говорит OKX и насколько этому верить.
 *
 * Ноль здесь читается как «не проверяли», а не «чисто». Разница
 * существенна: ноль стоит по умолчанию, в том числе у токена,
 * до которого проверка не дошла, и принять его за одобрение значит
 * пропустить непроверенное под видом безопасного.
 */
export function readOkxRisk(level: number | null): OkxRiskReading {
  const band = okxRiskBand(level);

  const explanation =
    band === 'danger'
      ? `OKX присвоил уровень риска ${level} из 5`
      : band === 'caution'
        ? 'OKX отметил токен как требующий внимания'
        : band === 'clean'
          ? 'OKX не нашёл нарушений'
          : 'OKX уровень риска не выставил — это не то же самое, что «чисто»';

  return { band, hardBlock: isOkxHardBlock(level), level, explanation };
}
