import type { Chain } from '@prisma/client';
import { logger } from '../lib/logger.js';

/**
 * Сбор проверяемых фактов о токене из бесплатных открытых источников.
 *
 * Здесь нет никаких суждений — только то, что можно перепроверить:
 * права эмитента, налоги на сделки, концентрация у держателей, ссылки
 * на официальные каналы проекта. Трактовкой занимается отдельный модуль.
 *
 * Источники и почему именно они:
 *  • GoPlus Security — бесплатный API без ключа, покрывает EVM и Solana,
 *    отвечает на главные вопросы: можно ли продать, можно ли допечатать,
 *    можно ли заморозить.
 *  • GeckoTerminal — уже используется для цен, заодно отдаёт описание
 *    проекта и ссылки на соцсети.
 */

const GOPLUS = 'https://api.gopluslabs.io/api/v1';
const GECKO = 'https://api.geckoterminal.com/api/v2';

/** Идентификаторы сетей в GoPlus. Solana обслуживается отдельным маршрутом. */
const GOPLUS_CHAIN: Record<Chain, string | null> = {
  ETHEREUM: '1',
  BNB: '56',
  BASE: '8453',
  SOLANA: 'solana',
  ROBINHOOD: null,
};

const GECKO_NETWORK: Record<Chain, string | null> = {
  SOLANA: 'solana',
  BNB: 'bsc',
  BASE: 'base',
  ETHEREUM: 'eth',
  ROBINHOOD: null,
};

async function getJson<T>(url: string, timeoutMs = 10_000): Promise<T | null> {
  try {
    const res = await fetch(url, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (e: any) {
    logger.debug({ url, err: e?.message }, 'источник фактов недоступен');
    return null;
  }
}

// ────────────────────────────── Безопасность ────────────────────────────────

export interface SecurityFacts {
  /** Продажа заблокирована — деньги войдут и не выйдут. */
  isHoneypot: boolean | null;
  /** Эмиссию можно допечатать. */
  mintable: boolean | null;
  /** Токен можно заморозить у держателя. */
  freezable: boolean | null;
  /** Владелец может менять правила контракта. */
  ownerCanModify: boolean | null;
  buyTaxPct: number | null;
  sellTaxPct: number | null;
  /** Доля предложения у создателя, %. */
  creatorPct: number | null;
  /** Доля у крупнейшего держателя, %. */
  topHolderPct: number | null;
  /** Доля у топ-10 держателей, %. */
  top10Pct: number | null;
  holderCount: number | null;
  /** Ликвидность сожжена или залочена. */
  lpLocked: boolean | null;
  source: string | null;
}

const emptySecurity = (): SecurityFacts => ({
  isHoneypot: null, mintable: null, freezable: null, ownerCanModify: null,
  buyTaxPct: null, sellTaxPct: null, creatorPct: null, topHolderPct: null,
  top10Pct: null, holderCount: null, lpLocked: null, source: null,
});

const pctOf = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n * 100 : null;
};
const boolOf = (v: unknown): boolean | null => {
  if (v === '1' || v === 1 || v === true) return true;
  if (v === '0' || v === 0 || v === false) return false;
  return null;
};

export async function fetchSecurityFacts(
  chain: Chain,
  address: string,
): Promise<SecurityFacts> {
  const id = GOPLUS_CHAIN[chain];
  if (!id) return emptySecurity();

  if (chain === 'SOLANA') {
    const data = await getJson<any>(
      `${GOPLUS}/solana/token_security?contract_addresses=${address}`,
    );
    const r = data?.result?.[address];
    if (!r) return emptySecurity();

    const holders: any[] = Array.isArray(r.holders) ? r.holders : [];
    const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0);

    return {
      // У Solana honeypot напрямую не определяется; косвенный признак —
      // возможность заморозки, при ней продажу можно оборвать в любой момент.
      isHoneypot: null,
      mintable: boolOf(r.mintable?.status),
      freezable: boolOf(r.freezable?.status),
      ownerCanModify: boolOf(r.metadata_mutable?.status),
      buyTaxPct: null,
      sellTaxPct: null,
      creatorPct: pctOf(r.creator_percent),
      topHolderPct: holders[0] ? (Number(holders[0].percent) || 0) * 100 : null,
      top10Pct: top10 * 100,
      holderCount: Number(r.holder_count) || null,
      lpLocked: null,
      source: 'goplus/solana',
    };
  }

  const data = await getJson<any>(
    `${GOPLUS}/token_security/${id}?contract_addresses=${address.toLowerCase()}`,
  );
  const r = data?.result?.[address.toLowerCase()];
  if (!r) return emptySecurity();

  const holders: any[] = Array.isArray(r.holders) ? r.holders : [];
  const top10 = holders.slice(0, 10).reduce((s, h) => s + (Number(h.percent) || 0), 0);
  const lp: any[] = Array.isArray(r.lp_holders) ? r.lp_holders : [];
  const lpLocked = lp.some((h) => h.is_locked === 1 || h.tag === 'null address');

  return {
    isHoneypot: boolOf(r.is_honeypot),
    mintable: boolOf(r.is_mintable),
    freezable: boolOf(r.transfer_pausable),
    ownerCanModify: boolOf(r.can_take_back_ownership) ?? boolOf(r.hidden_owner),
    buyTaxPct: pctOf(r.buy_tax),
    sellTaxPct: pctOf(r.sell_tax),
    creatorPct: pctOf(r.creator_percent),
    topHolderPct: holders[0] ? (Number(holders[0].percent) || 0) * 100 : null,
    top10Pct: top10 * 100,
    holderCount: Number(r.holder_count) || null,
    lpLocked: lp.length > 0 ? lpLocked : null,
    source: 'goplus',
  };
}

// ──────────────────────────── Каналы проекта ────────────────────────────────

export interface SocialFacts {
  websites: string[];
  twitter: string | null;
  telegram: string | null;
  discord: string | null;
  description: string | null;
  source: string | null;
}

export async function fetchSocialFacts(
  chain: Chain,
  address: string,
): Promise<SocialFacts> {
  const empty: SocialFacts = {
    websites: [], twitter: null, telegram: null, discord: null,
    description: null, source: null,
  };

  const network = GECKO_NETWORK[chain];
  if (!network) return empty;

  const data = await getJson<any>(`${GECKO}/networks/${network}/tokens/${address}/info`);
  const a = data?.data?.attributes;
  if (!a) return empty;

  const handle = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v.trim()) return null;
    return v.trim().replace(/^@/, '');
  };

  return {
    websites: Array.isArray(a.websites) ? a.websites.filter(Boolean).slice(0, 3) : [],
    twitter: handle(a.twitter_handle),
    telegram: handle(a.telegram_handle),
    discord: typeof a.discord_url === 'string' ? a.discord_url : null,
    description: typeof a.description === 'string' ? a.description.slice(0, 2000) : null,
    source: 'geckoterminal',
  };
}

// ─────────────────────────── Сводка по фактам ───────────────────────────────

export interface CollectedFacts {
  security: SecurityFacts;
  socials: SocialFacts;
  /** Источники, которые реально ответили. */
  sources: Array<{ name: string; at: string }>;
  /** Полнота сбора: часть сетей не покрыта поставщиками данных. */
  complete: boolean;
}

export async function collectFacts(chain: Chain, address: string): Promise<CollectedFacts> {
  // Запросы независимы — выполняем параллельно, отказ одного не мешает другому.
  const [security, socials] = await Promise.all([
    fetchSecurityFacts(chain, address).catch(() => emptySecurity()),
    fetchSocialFacts(chain, address).catch(() => ({
      websites: [], twitter: null, telegram: null, discord: null,
      description: null, source: null,
    })),
  ]);

  const at = new Date().toISOString();
  const sources: Array<{ name: string; at: string }> = [];
  if (security.source) sources.push({ name: security.source, at });
  if (socials.source) sources.push({ name: socials.source, at });

  return { security, socials, sources, complete: sources.length === 2 };
}

/**
 * Человекочитаемые предупреждения из фактов — без участия модели.
 * Работают всегда, даже когда AI отключён или недоступен.
 */
export function factWarnings(f: SecurityFacts): string[] {
  const w: string[] = [];

  if (f.isHoneypot === true) w.push('Ханипот: продажа токена заблокирована контрактом');
  if (f.mintable === true) w.push('Активны права на выпуск: эмиссию можно допечатать в любой момент');
  if (f.freezable === true) w.push('Токен можно заморозить у держателя — продажу оборвут на полпути');
  if (f.ownerCanModify === true) w.push('Владелец может менять правила контракта после запуска');
  if ((f.sellTaxPct ?? 0) > 10) w.push(`Налог на продажу ${f.sellTaxPct!.toFixed(1)}%`);
  if ((f.buyTaxPct ?? 0) > 10) w.push(`Налог на покупку ${f.buyTaxPct!.toFixed(1)}%`);
  if ((f.creatorPct ?? 0) > 15) {
    w.push(`У создателя ${f.creatorPct!.toFixed(1)}% предложения — он может выйти в любой момент`);
  }
  if ((f.top10Pct ?? 0) > 50) {
    w.push(`Топ-10 держателей контролируют ${f.top10Pct!.toFixed(0)}% предложения`);
  }
  if (f.lpLocked === false) w.push('Ликвидность не залочена и не сожжена — возможен вывод пула');
  if ((f.holderCount ?? 0) > 0 && f.holderCount! < 300) {
    w.push(`Всего ${f.holderCount} держателей`);
  }

  return w;
}
