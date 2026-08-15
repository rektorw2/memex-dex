import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma as P } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { getRule, runAutoRule } from '../workers/auto-publisher.js';

/**
 * Управление правилом автопубликации.
 *
 * Весь модуль под правами администратора, включая чтение: настройки
 * фильтра — это торговая логика площадки, и публиковать её означает
 * рассказать, при каких условиях сюда приходит поток покупателей.
 */
export const autoRuleRoutes: FastifyPluginAsync = async (app) => {
  app.get('/admin/auto-rule', { preHandler: [app.requireAdmin] }, async () => {
    const rule = await getRule();

    const since = new Date(Date.now() - 864e5);
    const [firedToday, dryRunToday, skippedToday, totalFired] = await Promise.all([
      prisma.autoRuleFire.count({
        where: { ruleId: rule.id, outcome: 'FIRED', createdAt: { gte: since } },
      }),
      prisma.autoRuleFire.count({
        where: { ruleId: rule.id, outcome: 'DRY_RUN', createdAt: { gte: since } },
      }),
      prisma.autoRuleFire.count({
        where: { ruleId: rule.id, outcome: 'SKIPPED', createdAt: { gte: since } },
      }),
      prisma.autoRuleFire.count({ where: { ruleId: rule.id, outcome: 'FIRED' } }),
    ]);

    return {
      rule: serializeRule(rule),
      stats: {
        // В режиме наблюдения смотреть надо на dryRunToday: это и есть
        // ответ на вопрос «сколько бы правило наделало, будь оно включено».
        firedToday,
        dryRunToday,
        skippedToday,
        totalFired,
      },
    };
  });

  app.put('/admin/auto-rule', { preHandler: [app.requireAdmin] }, async (req) => {
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        isEnabled: z.boolean().optional(),
        isDryRun: z.boolean().optional(),
        chains: z.array(z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE'])).optional(),

        minSmartBuyers: z.number().int().min(1).max(50).optional(),
        minSignalStrength: z.number().int().min(0).max(100).optional(),
        minSmartVolumeUsd: z.number().nonnegative().optional(),

        minLiquidityUsd: z.number().nonnegative().optional(),
        minVolume24hUsd: z.number().nonnegative().optional(),
        maxRiskScore: z.number().int().min(0).max(100).optional(),
        maxPoolAgeHours: z.number().int().min(1).max(720).optional(),

        // Верхние границы намеренно жёсткие. Правило, публикующее
        // полсотни коллов в сутки, обесценивает ленту быстрее, чем
        // приносит пользу, и оговорить это лучше в схеме, чем
        // рассчитывать на аккуратность в интерфейсе.
        maxCallsPerDay: z.number().int().min(1).max(20).optional(),
        cooldownMinutes: z.number().int().min(5).max(1440).optional(),

        targetPcts: z.array(z.number().positive().max(10_000)).min(1).max(5).optional(),
        stopLossPct: z.number().int().min(5).max(95).optional(),
        suggestedPct: z.number().positive().max(100).optional(),
        timeHorizon: z.string().max(40).optional(),
        isCopyEnabled: z.boolean().optional(),
      })
      .parse(req.body);

    const current = await getRule();

    const data: P.AutoRuleUpdateInput = {
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.isEnabled !== undefined ? { isEnabled: body.isEnabled } : {}),
      ...(body.isDryRun !== undefined ? { isDryRun: body.isDryRun } : {}),
      ...(body.chains !== undefined ? { chains: body.chains } : {}),
      ...(body.minSmartBuyers !== undefined ? { minSmartBuyers: body.minSmartBuyers } : {}),
      ...(body.minSignalStrength !== undefined ? { minSignalStrength: body.minSignalStrength } : {}),
      ...(body.minSmartVolumeUsd !== undefined
        ? { minSmartVolumeUsd: new P.Decimal(body.minSmartVolumeUsd) }
        : {}),
      ...(body.minLiquidityUsd !== undefined
        ? { minLiquidityUsd: new P.Decimal(body.minLiquidityUsd) }
        : {}),
      ...(body.minVolume24hUsd !== undefined
        ? { minVolume24hUsd: new P.Decimal(body.minVolume24hUsd) }
        : {}),
      ...(body.maxRiskScore !== undefined ? { maxRiskScore: body.maxRiskScore } : {}),
      ...(body.maxPoolAgeHours !== undefined ? { maxPoolAgeHours: body.maxPoolAgeHours } : {}),
      ...(body.maxCallsPerDay !== undefined ? { maxCallsPerDay: body.maxCallsPerDay } : {}),
      ...(body.cooldownMinutes !== undefined ? { cooldownMinutes: body.cooldownMinutes } : {}),
      ...(body.targetPcts !== undefined
        ? { targetPcts: body.targetPcts as unknown as P.InputJsonValue }
        : {}),
      ...(body.stopLossPct !== undefined ? { stopLossPct: body.stopLossPct } : {}),
      ...(body.suggestedPct !== undefined
        ? { suggestedPct: new P.Decimal(body.suggestedPct) }
        : {}),
      ...(body.timeHorizon !== undefined ? { timeHorizon: body.timeHorizon } : {}),
      ...(body.isCopyEnabled !== undefined ? { isCopyEnabled: body.isCopyEnabled } : {}),
    };

    const updated = await prisma.autoRule.update({ where: { id: current.id }, data });

    // Изменение правила публикации от вашего имени — событие, которое
    // должно оставлять след: по журналу коллов иначе не восстановить,
    // при каких настройках был опубликован конкретный колл.
    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'auto_rule.update',
        entity: 'AutoRule',
        entityId: current.id,
        before: serializeRule(current) as never,
        after: serializeRule(updated) as never,
      },
    });

    return { rule: serializeRule(updated) };
  });

  /**
   * Журнал решений.
   *
   * По умолчанию отдаются все исходы, включая отказы. Лента одних
   * срабатываний не отвечает на вопрос, который задают чаще всего:
   * почему правило молчит.
   */
  app.get('/admin/auto-rule/log', { preHandler: [app.requireAdmin] }, async (req) => {
    const q = z
      .object({
        outcome: z.enum(['FIRED', 'DRY_RUN', 'SKIPPED', 'all']).default('all'),
        limit: z.coerce.number().max(200).default(60),
      })
      .parse(req.query);

    const rule = await getRule();

    const rows = await prisma.autoRuleFire.findMany({
      where: {
        ruleId: rule.id,
        ...(q.outcome === 'all' ? {} : { outcome: q.outcome }),
      },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
    });

    return {
      entries: rows.map((r) => ({
        id: r.id,
        chain: r.chain,
        address: r.address,
        symbol: r.symbol,
        outcome: r.outcome,
        reason: r.reason,
        snapshot: r.snapshot,
        callId: r.callId,
        createdAt: r.createdAt,
      })),
    };
  });

  /** Немедленный проход правила. */
  app.post('/admin/auto-rule/run', { preHandler: [app.requireAdmin] }, async () => runAutoRule());
};

function serializeRule(r: Awaited<ReturnType<typeof getRule>>) {
  return {
    id: r.id,
    name: r.name,
    isEnabled: r.isEnabled,
    isDryRun: r.isDryRun,
    chains: r.chains,
    minSmartBuyers: r.minSmartBuyers,
    minSignalStrength: r.minSignalStrength,
    minSmartVolumeUsd: Number(r.minSmartVolumeUsd),
    minLiquidityUsd: Number(r.minLiquidityUsd),
    minVolume24hUsd: Number(r.minVolume24hUsd),
    maxRiskScore: r.maxRiskScore,
    maxPoolAgeHours: r.maxPoolAgeHours,
    maxCallsPerDay: r.maxCallsPerDay,
    cooldownMinutes: r.cooldownMinutes,
    targetPcts: r.targetPcts,
    stopLossPct: r.stopLossPct,
    suggestedPct: Number(r.suggestedPct),
    timeHorizon: r.timeHorizon,
    isCopyEnabled: r.isCopyEnabled,
    lastFiredAt: r.lastFiredAt,
  };
}
