import { Prisma as P, type Chain } from '@prisma/client';
import { assessToken, type NormalizedToken, type ChainKey } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { fetchTopPools, isMarketDataSupported } from '../services/market-data.js';
import {
  fetchHotTokens,
  isOkxConfigured,
  isOkxSupported,
  MARKET_DATA_SOURCE,
} from '../services/okx-market.js';
import { supportedChains } from '../chains/index.js';
import { decimalOf, priceChangeOrNull, sharePctOrNull } from '../lib/decimal.js';

/**
 * Автоматическое наполнение витрины токенами.
 *
 * Основной источник — OKX Onchain OS: он отдаёт готовый список
 * торгуемого с рыночными числами и собственной оценкой риска, тогда
 * как GeckoTerminal приходилось спрашивать про пулы и восстанавливать
 * токены из них. Разница не только в удобстве: у пула нет holders,
 * uniqueTraders и распределения владения, а решение о допуске токена
 * без этих величин принимается вслепую.
 *
 * GeckoTerminal остаётся запасным, но только для рыночных чисел —
 * цена, ликвидность, объём. Заменить им проверку безопасности нельзя,
 * и токен, импортированный из запасного источника, не получает
 * никакого уровня риска: он уходит в очередь проверки как непроверенный.
 * Это принципиально. Недоступность OKX не должна превращаться в тихое
 * ослабление требований — иначе именно в момент сбоя витрина
 * наполнится тем, от чего мы защищаемся.
 *
 * Что сознательно НЕ делается:
 *  • Токены не удаляются при выпадении из топа. У пользователя может быть
 *    открытая позиция, и исчезновение токена из списка означало бы, что
 *    её нельзя закрыть. Вместо удаления — флаг isHidden.
 *  • Импортированные токены не получают isVerified. Проверка остаётся
 *    ручным действием админа: автоматический список — это витрина,
 *    а не знак качества.
 */

const IMPORT_INTERVAL_MS = 60 * 60 * 1000; // час
const PAGES_PER_CHAIN = 2; // ~40 пулов на сеть

let running = false;

export interface ImportStats {
  chain: Chain;
  fetched: number;
  created: number;
  updated: number;
  skipped: number;
  /** Откуда взят список: okx или geckoterminal. */
  source: string;
}

/**
 * Кандидат на попадание в витрину — общий вид для обоих источников.
 *
 * Поля, которых у пула нет, остаются null. Именно null, а не ноль:
 * неизвестное число holders и ноль держателей — разные утверждения,
 * и второе блокирует токен.
 */
interface Candidate {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  poolAddress: string | null;
  priceUsd: number | null;
  liquidityUsd: number | null;
  volume24hUsd: number | null;
  priceChange24h: number | null;
  fdvUsd: number | null;
  holders: number | null;
  buys24h: number | null;
  sells24h: number | null;
  topHolderPct: number | null;
  poolCreatedAt: Date | null;
  /** Уровень риска по мнению OKX. У запасного источника его нет. */
  okxRiskLevel: number | null;
}

function fromOkx(t: NormalizedToken): Candidate {
  return {
    address: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals ?? (t.chain === 'SOLANA' ? 9 : 18),
    logoUrl: t.logoUrl,
    poolAddress: null,
    priceUsd: t.priceUsd,
    liquidityUsd: t.liquidityUsd,
    volume24hUsd: t.volume24hUsd,
    priceChange24h: t.priceChange24h,
    fdvUsd: t.marketCapUsd,
    holders: t.holders,
    buys24h: t.buys24h,
    sells24h: t.sells24h,
    topHolderPct: t.top10HoldPct,
    poolCreatedAt: t.firstTradeAt,
    okxRiskLevel: t.okxRiskLevel,
  };
}

export async function importTokens(): Promise<ImportStats[]> {
  const stats: ImportStats[] = [];
  const minLiquidity = env.MIN_LIQUIDITY_USD;

  for (const chain of supportedChains()) {
    // ─── Выбор источника ──────────────────────────────────────────────
    // OKX первый, GeckoTerminal запасной. Порядок жёсткий: подмена
    // основного источника запасным не должна происходить молча,
    // поэтому она попадает в журнал и в статистику.
    let candidates: Candidate[] = [];
    let source = MARKET_DATA_SOURCE;

    if (isOkxConfigured() && isOkxSupported(chain as ChainKey)) {
      const hot = await fetchHotTokens(chain as ChainKey, {
        liquidityMin: minLiquidity,
        limit: 100,
      });
      candidates = hot.map(fromOkx);
    }

    if (candidates.length === 0) {
      if (!isMarketDataSupported(chain)) {
        logger.debug({ chain }, 'сеть не поддерживается ни одним источником, пропускаем');
        continue;
      }

      source = 'GeckoTerminal';
      logger.warn(
        { chain },
        'OKX не дал списка — работаем на запасном источнике, токены пойдут в очередь проверки',
      );

      const pools = await fetchTopPools(chain, PAGES_PER_CHAIN);
      candidates = pools.map((pool) => ({
        address: pool.address,
        symbol: pool.symbol,
        name: pool.name,
        decimals: pool.decimals,
        logoUrl: pool.logoUrl ?? null,
        poolAddress: pool.poolAddress,
        priceUsd: pool.priceUsd,
        liquidityUsd: pool.liquidityUsd,
        volume24hUsd: pool.volume24hUsd,
        priceChange24h: pool.priceChange24h,
        fdvUsd: pool.fdvUsd,
        holders: null,
        buys24h: null,
        sells24h: null,
        topHolderPct: null,
        poolCreatedAt: pool.poolCreatedAt,
        okxRiskLevel: null,
      }));
    }

    const s: ImportStats = {
      chain,
      fetched: candidates.length,
      created: 0,
      updated: 0,
      skipped: 0,
      source,
    };

    for (const pool of candidates) {
      // Порог ликвидности — единственный жёсткий фильтр на входе.
      // Токен с пулом в пару тысяч долларов невозможно продать без
      // катастрофического проскальзывания, и держать его в списке
      // означает предлагать пользователю ловушку.
      if ((pool.liquidityUsd ?? 0) < minLiquidity) {
        s.skipped++;
        continue;
      }

      const ageHours = pool.poolCreatedAt
        ? (Date.now() - pool.poolCreatedAt.getTime()) / 3_600_000
        : null;

      const risk = assessToken({
        liquidityUsd: pool.liquidityUsd,
        volume24hUsd: pool.volume24hUsd,
        ageHours,
      });

      const data = {
        symbol: pool.symbol,
        name: pool.name,
        poolAddress: pool.poolAddress,
        logoUrl: pool.logoUrl ?? null,
        priceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : null,
        liquidityUsd: pool.liquidityUsd != null ? new P.Decimal(pool.liquidityUsd) : null,
        volume24hUsd: pool.volume24hUsd != null ? new P.Decimal(pool.volume24hUsd) : null,
        priceChange24h: decimalOf(priceChangeOrNull(pool.priceChange24h)),
        fdvUsd: pool.fdvUsd != null ? new P.Decimal(pool.fdvUsd) : null,
        riskScore: risk.score,
        metricsUpdated: new Date(),

        // Величины, которых у пула нет, а у hot-token есть. Записываются
        // только когда пришли: перетирать известное число неизвестностью
        // хуже, чем оставить старое.
        ...(pool.holders != null ? { holders: pool.holders } : {}),
        ...(pool.buys24h != null ? { buys24h: pool.buys24h } : {}),
        ...(pool.sells24h != null ? { sells24h: pool.sells24h } : {}),
        // Доля вне диапазона 0-100 — не «очень большая доля»,
        // а признак того, что провайдер прислал базисные пункты.
        // Записывать её нельзя ни в каком виде.
        ...(sharePctOrNull(pool.topHolderPct) != null
          ? { topHolderPct: new P.Decimal(sharePctOrNull(pool.topHolderPct)!) }
          : {}),
      };

      // Уровень риска импортёр не выставляет никогда — ни своим
      // решением, ни чужим. Оценка OKX сохраняется как факт для
      // проверяющего воркера, но допуск в витрину она не даёт:
      // между «OKX не возражает» и «мы проверили» разница в том,
      // кто отвечает за результат.

      try {
        const existing = await prisma.token.findUnique({
          where: { chain_address: { chain, address: pool.address } },
        });

        if (existing) {
          await prisma.token.update({
            where: { id: existing.id },
            // symbol/name/logoUrl у существующего токена не перезаписываем:
            // админ мог поправить их вручную, и автоимпорт не должен это
            // откатывать. Пустой логотип при этом заполняем — потерять
            // тут нечего.
            data: {
              ...data,
              symbol: existing.symbol,
              name: existing.name,
              logoUrl: existing.logoUrl ?? data.logoUrl,
            },
          });
          s.updated++;
        } else {
          await prisma.token.create({
            data: {
              ...data,
              chain,
              address: pool.address,
              decimals: pool.decimals,
              source: 'auto',
              isVerified: false,
            },
          });
          s.created++;
        }
      } catch (e: any) {
        logger.debug({ err: e?.message, symbol: pool.symbol }, 'токен не импортирован');
        s.skipped++;
      }
    }

    stats.push(s);
    logger.info(
      {
        chain,
        source: s.source,
        fetched: s.fetched,
        created: s.created,
        updated: s.updated,
        skipped: s.skipped,
      },
      'импорт токенов завершён',
    );
  }

  return stats;
}

export function startTokenImporter() {
  if (running) return;
  running = true;

  const loop = async () => {
    while (running) {
      await importTokens().catch((e) => logger.error({ err: e?.message }, 'сбой импорта токенов'));
      await new Promise((r) => setTimeout(r, IMPORT_INTERVAL_MS));
    }
  };
  void loop();
  logger.info('импортёр токенов запущен');
}

export function stopTokenImporter() {
  running = false;
}
