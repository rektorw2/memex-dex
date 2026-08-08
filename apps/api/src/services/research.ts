import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { collectFacts, factWarnings } from './token-intel.js';
import { researchToken, isAiConfigured } from './ai-research.js';

/**
 * Полный разбор токена: факты плюс трактовка.
 *
 * Разбор устроен так, чтобы всегда возвращать хоть что-то полезное.
 * Недоступен сканер безопасности — останутся соцсети. Нет ключа AI —
 * останутся факты и предупреждения по ним. Пустой экран вместо данных
 * о безопасности контракта хуже, чем неполные данные.
 */

/** Разбор считается свежим сутки: состав держателей меняется медленно. */
const FRESH_MS = 24 * 60 * 60 * 1000;

export async function runResearch(tokenId: string, opts: { force?: boolean } = {}) {
  const token = await prisma.token.findUnique({
    where: { id: tokenId },
    include: { research: true },
  });
  if (!token) throw new Error('Токен не найден');

  const existing = token.research;
  if (!opts.force && existing && Date.now() - existing.updatedAt.getTime() < FRESH_MS) {
    return { research: existing, cached: true };
  }

  const facts = await collectFacts(token.chain, token.address);

  const marketSummary = [
    token.priceUsd ? `цена $${token.priceUsd.toString()}` : null,
    token.liquidityUsd ? `ликвидность $${token.liquidityUsd.toFixed(0)}` : null,
    token.volume24hUsd ? `объём за сутки $${token.volume24hUsd.toFixed(0)}` : null,
    token.fdvUsd ? `FDV $${token.fdvUsd.toFixed(0)}` : null,
    token.priceChange24h ? `изменение за сутки ${token.priceChange24h.toFixed(2)}%` : null,
  ]
    .filter(Boolean)
    .join(', ') || 'рыночные данные отсутствуют';

  const verdict = isAiConfigured()
    ? await researchToken({
        symbol: token.symbol,
        name: token.name,
        chain: token.chain,
        address: token.address,
        facts,
        marketSummary,
      })
    : null;

  // Статус честно отражает полноту: пользователь должен понимать,
  // что часть источников промолчала, а не считать пустоту за «чисто».
  const status = !facts.complete && !verdict ? 'partial' : verdict ? 'ok' : 'partial';

  const data = {
    securityFlags: { ...facts.security, warnings: factWarnings(facts.security) } as P.InputJsonValue,
    socials: facts.socials as unknown as P.InputJsonValue,
    holderStats: {
      holderCount: facts.security.holderCount,
      topHolderPct: facts.security.topHolderPct,
      top10Pct: facts.security.top10Pct,
      creatorPct: facts.security.creatorPct,
    } as P.InputJsonValue,
    factSources: facts.sources as unknown as P.InputJsonValue,

    aiSummary: verdict?.summary ?? null,
    aiRiskScore: verdict?.riskScore ?? null,
    aiRiskFactors: (verdict?.riskFactors ?? []) as unknown as P.InputJsonValue,
    aiSentiment: verdict?.sentiment ?? null,
    aiSources: (verdict?.sources ?? []) as unknown as P.InputJsonValue,
    aiModel: verdict?.model ?? null,

    status,
    error: verdict === null && isAiConfigured() ? 'Модель не вернула разбор' : null,
  };

  const research = await prisma.tokenResearch.upsert({
    where: { tokenId },
    create: { tokenId, ...data },
    update: data,
  });

  // Найденные соцсети сохраняем и в самом токене: они нужны в карточке,
  // и незачем ради ссылки на X ходить в таблицу разбора.
  if (facts.socials.websites.length > 0 && !token.logoUrl) {
    await prisma.token
      .update({ where: { id: tokenId }, data: { metricsUpdated: new Date() } })
      .catch(() => {});
  }

  logger.info(
    { symbol: token.symbol, status, ai: Boolean(verdict), sources: facts.sources.length },
    'разбор токена завершён',
  );

  return { research, cached: false };
}

/** Сериализация разбора для интерфейса. */
export function serializeResearch(r: {
  securityFlags: unknown; socials: unknown; holderStats: unknown; factSources: unknown;
  aiSummary: string | null; aiRiskScore: number | null; aiRiskFactors: unknown;
  aiSentiment: string | null; aiSources: unknown; aiModel: string | null;
  status: string; error: string | null; updatedAt: Date;
}) {
  return {
    security: r.securityFlags,
    socials: r.socials,
    holders: r.holderStats,
    factSources: r.factSources,
    ai: r.aiSummary
      ? {
          summary: r.aiSummary,
          riskScore: r.aiRiskScore,
          riskFactors: r.aiRiskFactors,
          sentiment: r.aiSentiment,
          sources: r.aiSources,
          model: r.aiModel,
        }
      : null,
    status: r.status,
    error: r.error,
    updatedAt: r.updatedAt,
  };
}
