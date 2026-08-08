import { Prisma as P, type Chain } from '@prisma/client';
import { assessToken } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { fetchTopPools, isMarketDataSupported } from '../services/market-data.js';
import { supportedChains } from '../chains/index.js';

/**
 * Автоматическое наполнение витрины токенами.
 *
 * Раз в час берёт топ пулов по объёму в каждой поддерживаемой сети
 * и добавляет токены, прошедшие фильтр ликвидности.
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
}

export async function importTokens(): Promise<ImportStats[]> {
  const stats: ImportStats[] = [];
  const minLiquidity = env.MIN_LIQUIDITY_USD;

  for (const chain of supportedChains()) {
    if (!isMarketDataSupported(chain)) {
      logger.debug({ chain }, 'сеть не поддерживается поставщиком данных, пропускаем');
      continue;
    }

    const pools = await fetchTopPools(chain, PAGES_PER_CHAIN);
    const s: ImportStats = { chain, fetched: pools.length, created: 0, updated: 0, skipped: 0 };

    for (const pool of pools) {
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
        priceUsd: pool.priceUsd != null ? new P.Decimal(pool.priceUsd) : null,
        liquidityUsd: pool.liquidityUsd != null ? new P.Decimal(pool.liquidityUsd) : null,
        volume24hUsd: pool.volume24hUsd != null ? new P.Decimal(pool.volume24hUsd) : null,
        priceChange24h: pool.priceChange24h != null ? new P.Decimal(pool.priceChange24h) : null,
        fdvUsd: pool.fdvUsd != null ? new P.Decimal(pool.fdvUsd) : null,
        riskScore: risk.score,
        metricsUpdated: new Date(),
      };

      try {
        const existing = await prisma.token.findUnique({
          where: { chain_address: { chain, address: pool.address } },
        });

        if (existing) {
          await prisma.token.update({
            where: { id: existing.id },
            // symbol/name у существующего токена не перезаписываем: админ
            // мог поправить их вручную, и автоимпорт не должен это откатывать.
            data: { ...data, symbol: existing.symbol, name: existing.name },
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
      { chain, fetched: s.fetched, created: s.created, updated: s.updated, skipped: s.skipped },
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
