import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';
import { env } from '../lib/env.js';

/**
 * Настройки автоматики.
 *
 * Разделены по правам, а не по удобству. Полуавтомат и полный автомат
 * отличаются одним: кто нажимает кнопку продажи. В полуавтомате вход
 * может произойти по сигналу, но выход остаётся за человеком;
 * в полном автомате машина закрывает позицию сама.
 *
 * Граница проходит именно здесь, потому что именно здесь решается
 * судьба денег. Ошибиться со входом — потерять на одной сделке;
 * ошибиться с выходом — не выйти вовсе.
 *
 * Ни один маршрут этого модуля ничего не исполняет. Живая торговля
 * остаётся выключенной: `EXECUTION_MODE` по умолчанию `paper`,
 * и настройки, сохранённые здесь, до включения режима — намерение,
 * а не действие.
 */
export const automationRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Состояние полуавтомата.
   *
   * Требует `SEMI_AUTO_TRADE`. Пробный период его не даёт: показать
   * автоматическую торговлю бесплатно значит дать машине распоряжаться
   * деньгами до того, как человек решил, доверяет ли он ей.
   */
  app.get('/automation/semi-auto', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'SEMI_AUTO_TRADE', reply)) return reply;

    return {
      capability: 'SEMI_AUTO_TRADE',
      executionMode: env.EXECUTION_MODE,
      /** Вход по сигналу разрешён, выход остаётся ручным. */
      autoEntry: true,
      autoExit: false,
      activeRules: 0,
    };
  });

  /**
   * Настройки автоматических выходов.
   *
   * Требует `AUTO_EXIT` — то есть полного автомата.
   */
  app.get('/automation/auto-exit', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'AUTO_EXIT', reply)) return reply;

    return {
      capability: 'AUTO_EXIT',
      executionMode: env.EXECUTION_MODE,
      autoEntry: true,
      autoExit: true,
    };
  });

  /**
   * Изменение стратегии.
   *
   * Требует `STRATEGY_AUTOMATION`. Проверка стоит до разбора тела:
   * человеку без права незачем узнавать, какие поля мы принимаем.
   */
  app.put('/automation/strategy', { preHandler: [app.authenticate] }, async (req, reply) => {
    const ent = await entitlementOfRequest(req);
    if (denyIfMissing(ent, 'STRATEGY_AUTOMATION', reply)) return reply;

    const body = z
      .object({
        maxPositions: z.coerce.number().int().min(1).max(50),
        dailyLossLimitUsd: z.coerce.number().min(0),
      })
      .parse(req.body);

    return { capability: 'STRATEGY_AUTOMATION', accepted: body, executionMode: env.EXECUTION_MODE };
  });
};
