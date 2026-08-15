import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import {
  requireApiKey,
  assertOrderWithinKeyLimit,
  hashToken,
  ALL_SCOPES,
  SCOPE_LABELS,
} from '../lib/api-key.js';

/**
 * Программный доступ по ключу: радар и торговля.
 *
 * Всё, что здесь есть, доступно и через обычную сессию в браузере.
 * Разница в том, что ключ живёт долго и не требует человека у экрана —
 * поэтому у него ограниченная область прав и предел на сумму сделки.
 *
 * Вывода средств тут нет и не будет: см. комментарий в lib/api-key.ts.
 */
export const ingestRoutes: FastifyPluginAsync = async (app) => {
  // ─── Радар ────────────────────────────────────────────────────────────

  /**
   * Добавление находок.
   *
   * Тело — произвольный текст: адреса, ссылки, вперемешку. Отдельный
   * формат для каждого источника не нужен; разбор один и тот же, что
   * при вставке руками.
   */
  app.post('/ingest/tokens', async (req, reply) => {
    const key = await requireApiKey(req, 'radar:ingest');

    const body = z
      .object({
        text: z.string().min(1).max(20_000),
        source: z.string().max(40).optional(),
      })
      .parse(req.body);

    const { addWatched } = await import('../workers/radar-scanner.js');
    const result = await addWatched(body.text);

    logger.info({ key: key.prefix, source: body.source ?? 'unknown', ...result }, 'приём находок');
    return reply.send(result);
  });

  // ─── Торговля ─────────────────────────────────────────────────────────

  /**
   * Постановка ордера скриптом.
   *
   * Ровно те же проверки, что и в обычном /orders: движок один, отдельной
   * «быстрой ветки для ботов» нет. Иначе рано или поздно появилась бы
   * проверка, которую добавили в одном месте и забыли в другом.
   */
  app.post('/ingest/orders', async (req, reply) => {
    const key = await requireApiKey(req, 'trade:write');

    const body = z
      .object({
        chain: z.enum(['SOLANA', 'BNB', 'ROBINHOOD', 'ETHEREUM', 'BASE']),
        tokenInId: z.string(),
        tokenOutId: z.string(),
        side: z.enum(['BUY', 'SELL']),
        type: z.enum(['MARKET', 'LIMIT', 'STOP_LOSS', 'TAKE_PROFIT']).default('MARKET'),
        amountIn: z.string(),
        limitPrice: z.string().optional(),
        triggerPrice: z.string().optional(),
        slippageBps: z.number().int().min(1).max(5000).default(100),
        expiresAt: z.coerce.date().optional(),
        /** Ключ идемпотентности. Настоятельно рекомендуется скриптам. */
        idempotencyKey: z.string().max(120).optional(),
      })
      .parse(req.body);

    // Оценка суммы в долларах для предела ключа.
    const tokenIn = await prisma.token.findUnique({
      where: { id: body.tokenInId },
      select: { priceUsd: true, symbol: true },
    });
    if (!tokenIn) return reply.code(400).send({ error: 'Токен не найден' });

    const valueUsd = Number(body.amountIn) * Number(tokenIn.priceUsd ?? 0);
    assertOrderWithinKeyLimit(key, valueUsd);

    // Идемпотентность: повторный запуск скрипта после сбоя сети не должен
    // создавать вторую сделку. У скриптов это происходит гораздо чаще,
    // чем у людей, — cron перезапустится молча.
    if (body.idempotencyKey) {
      const existing = await prisma.idempotencyKey.findUnique({
        where: { key: body.idempotencyKey },
      });
      if (existing) return reply.send(existing.response);
    }

    const { placeOrderForUser } = await import('../services/order-intake.js');

    const result = await placeOrderForUser(key.userId, {
      chain: body.chain,
      tokenInId: body.tokenInId,
      tokenOutId: body.tokenOutId,
      side: body.side,
      type: body.type,
      amountIn: body.amountIn,
      limitPrice: body.limitPrice ?? null,
      triggerPrice: body.triggerPrice ?? null,
      slippageBps: body.slippageBps,
      expiresAt: body.expiresAt ?? null,
      source: 'API',
    });

    if (body.idempotencyKey) {
      await prisma.idempotencyKey
        .create({
          data: { key: body.idempotencyKey, userId: key.userId, response: result as never },
        })
        .catch(() => undefined);
    }

    logger.info(
      { key: key.prefix, orderId: result.order.id, side: body.side, type: body.type },
      'ордер поставлен по ключу',
    );

    return reply.code(201).send(result);
  });

  /** Отмена ордера скриптом. */
  app.delete('/ingest/orders/:id', async (req, reply) => {
    const key = await requireApiKey(req, 'trade:write');
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const { cancelOrderForUser } = await import('../services/order-intake.js');
    const r = await cancelOrderForUser(key.userId, id);

    if (!r.ok) return reply.code(r.status).send({ error: r.error });
    return reply.send({ ok: true, order: r.order });
  });

  /** Позиции и открытые ордера. */
  app.get('/ingest/portfolio', async (req) => {
    const key = await requireApiKey(req, 'trade:read');

    const [positions, orders, balances] = await Promise.all([
      prisma.position.findMany({
        where: { userId: key.userId, quantity: { gt: 0 } },
        include: { token: { select: { symbol: true, address: true, chain: true, priceUsd: true } } },
      }),
      prisma.order.findMany({
        where: { userId: key.userId, status: { in: ['OPEN', 'PENDING', 'PARTIALLY_FILLED'] } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
      prisma.balance.findMany({
        where: { userId: key.userId },
        include: { token: { select: { symbol: true } } },
      }),
    ]);

    return {
      positions: positions.map((p) => ({
        tokenId: p.tokenId,
        symbol: p.token.symbol,
        chain: p.token.chain,
        address: p.token.address,
        quantity: p.quantity.toString(),
        avgCostUsd: p.avgCostUsd.toString(),
        // Доля позиции, набранная копированием: с неё берётся
        // комиссия на выходе, и скрипту это нужно знать.
        copiedQuantity: p.copiedQuantity.toString(),
        priceUsd: p.token.priceUsd?.toString() ?? null,
      })),
      orders: orders.map((o) => ({
        id: o.id,
        side: o.side,
        type: o.type,
        status: o.status,
        amountIn: o.amountIn.toString(),
        filledIn: o.filledIn.toString(),
        limitPrice: o.limitPrice?.toString() ?? null,
        createdAt: o.createdAt,
      })),
      balances: balances.map((b) => ({
        symbol: b.token.symbol,
        available: b.available.toString(),
        locked: b.locked.toString(),
      })),
    };
  });

  /** Проверка ключа без побочных эффектов. */
  app.get('/ingest/ping', async (req) => {
    // Для проверки достаточно любой области; берём чтение как самую
    // безобидную. Ключ только на ingest получит понятный отказ
    // с указанием, чего не хватает.
    const key = await requireApiKey(req, 'trade:read').catch(() =>
      requireApiKey(req, 'radar:ingest'),
    );
    return { ok: true, name: key.name, scopes: key.scopes, maxOrderUsd: key.maxOrderUsd };
  });

  // ─── Управление ключами ───────────────────────────────────────────────

  app.get('/api-keys', { preHandler: [app.authenticate] }, async (req) => {
    const keys = await prisma.apiKey.findMany({
      where: { userId: req.user.sub },
      orderBy: { createdAt: 'desc' },
    });

    return {
      availableScopes: ALL_SCOPES.map((s) => ({ scope: s, label: SCOPE_LABELS[s] })),
      keys: keys.map((k) => ({
        id: k.id,
        name: k.name,
        // Сам ключ не хранится и показать его нельзя — только префикс.
        prefix: k.prefix,
        scopes: k.scopes,
        isActive: k.isActive,
        maxPerHour: k.maxPerHour,
        maxOrderUsd: k.maxOrderUsd?.toString() ?? null,
        usedCount: k.usedCount,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
      })),
    };
  });

  app.post('/api-keys', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = z
      .object({
        name: z.string().min(1).max(60),
        scopes: z.array(z.enum(ALL_SCOPES)).min(1),
        maxPerHour: z.number().int().min(1).max(600).default(60),
        maxOrderUsd: z.number().positive().optional(),
      })
      .parse(req.body);

    // Ключ на запись без предела суммы разрешён, но это осознанный выбор,
    // а не умолчание: скрипт с ошибкой в разряде иначе тратит весь депозит.
    if (body.scopes.includes('trade:write') && body.maxOrderUsd == null) {
      return reply.code(400).send({
        error:
          'Для ключа с правом ставить ордера укажите предел суммы сделки. ' +
          'Ошибка в скрипте с лишним нулём иначе стоит всего депозита.',
      });
    }

    const raw = `mdx_${randomBytes(24).toString('base64url')}`;

    const key = await prisma.apiKey.create({
      data: {
        userId: req.user.sub,
        name: body.name,
        tokenHash: hashToken(raw),
        prefix: raw.slice(0, 12),
        scopes: body.scopes,
        maxPerHour: body.maxPerHour,
        maxOrderUsd: body.maxOrderUsd != null ? body.maxOrderUsd.toString() : null,
      },
      select: { id: true, name: true, prefix: true, scopes: true },
    });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'api_key.create',
        entity: 'ApiKey',
        entityId: key.id,
        after: { name: key.name, prefix: key.prefix, scopes: key.scopes } as never,
      },
    });

    return {
      ...key,
      // Единственный момент, когда ключ существует в открытом виде:
      // в базе только SHA-256, восстановить исходный нельзя.
      token: raw,
      warning: 'Ключ показывается один раз. Сохраните его сейчас — восстановить нельзя.',
    };
  });

  app.delete('/api-keys/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);

    const key = await prisma.apiKey.findUnique({ where: { id }, select: { userId: true } });
    if (!key || key.userId !== req.user.sub) {
      return reply.code(404).send({ error: 'Ключ не найден' });
    }

    // Деактивация, а не удаление: журнал действий ссылается на префикс,
    // и стирать историю вместе с ключом незачем.
    await prisma.apiKey.update({ where: { id }, data: { isActive: false } });

    await prisma.auditLog.create({
      data: {
        actorId: req.user.sub,
        action: 'api_key.revoke',
        entity: 'ApiKey',
        entityId: id,
      },
    });

    return { ok: true };
  });
};
