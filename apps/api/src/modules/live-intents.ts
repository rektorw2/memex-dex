import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  APPROVAL_WARNING,
  forbiddenClientFields,
  intentStage,
  type TransactionIntentState,
} from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { env } from '../lib/env.js';
import { entitlementOfRequest, denyIfMissing } from '../services/entitlement.js';
import {
  createDevnetFixtureIntent,
  decideProposal,
  presentProposal,
  proposalFingerprint,
} from '../services/intent-source.js';
import { createBlockhashSource } from '../services/signer-factory.js';
import {
  discoverSigningIdentity,
  readRegisteredIdentity,
  registerSigningIdentity,
  revokeSigningIdentity,
  IdentityRegistryError,
} from '../services/signing-identity-registry.js';

/**
 * Предложения агента и намерения: чтение и решение человека.
 *
 * Создание намерения маршрута не имеет. Оно происходит внутри
 * подтверждения предложения, потому что денежная запись не должна
 * появляться по команде браузера — от человека приходит согласие,
 * а не транзакция.
 *
 * Чужое и несуществующее отвечают одинаково. Разные коды на
 * «не ваше» и «нет такого» превращают перебор идентификаторов в
 * способ выяснить, есть ли у соседа предложение на такую-то сумму.
 */

/**
 * Схема решения.
 *
 * `.strict()` обязателен: лишнее поле отвергается, а не игнорируется.
 * Молчаливое игнорирование хуже отказа — отправитель считает, что
 * его учли, а через месяц кто-нибудь добавит чтение «раз уж
 * присылают», и денежное поле приедет из браузера.
 */
const decideSchema = z
  .object({
    decision: z.enum(['CONFIRM', 'REJECT']),
    /** Эхо отпечатка, показанного человеку. */
    shownFingerprint: z.string().min(8).max(64),
  })
  .strict();

const listSchema = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();

/** Единый безопасный ответ. Существование чужой записи не выдаётся. */
const NOT_FOUND = { error: 'Не найдено', code: 'NOT_FOUND' } as const;

export const liveIntentRoutes: FastifyPluginAsync = async (app) => {
  /** Свои предложения. Чужие не видны и не перечисляются. */
  app.get(
    '/live/proposals',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 60, timeWindow: '1m' } },
    },
    async (req) => {
      const query = listSchema.parse(req.query);
      const rows = await prisma.liveAgentProposal.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
      });

      return {
        // Предупреждение идёт вместе со списком, а не только на
        // экране подтверждения: клиент мог отрисовать свой.
        warning: APPROVAL_WARNING,
        liveBlocked: !env.LIVE_AGENT_ENABLED,
        proposals: rows.map((row) => ({
          id: row.id,
          status: row.status,
          fingerprint: proposalFingerprint(row),
          presentation: presentProposal(row),
        })),
      };
    },
  );

  app.get(
    '/live/proposals/:id',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 120, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(req.params);
      const row = await prisma.liveAgentProposal.findUnique({ where: { id } });

      // Владелец проверяется тем же ответом, что и отсутствие.
      if (!row || row.userId !== req.user.sub) return reply.code(404).send(NOT_FOUND);

      return {
        id: row.id,
        status: row.status,
        fingerprint: proposalFingerprint(row),
        presentation: presentProposal(row),
        warning: APPROVAL_WARNING,
        liveBlocked: !env.LIVE_AGENT_ENABLED,
      };
    },
  );

  /**
   * Решение человека.
   *
   * Идемпотентность по существующему механизму: повтор с тем же
   * ключом возвращает сохранённый ответ, а не принимает второе
   * решение. Тот же ключ с другим телом — отказ: это уже другой
   * запрос, и отдавать ему чужой ответ нельзя.
   */
  app.post(
    '/live/proposals/:id/decide',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 20, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(req.params);

      /*
       * Запрещённые поля проверяются до разбора схемы.
       *
       * `.strict()` тоже отвергнет их, но сообщение будет про
       * «unrecognized key». Отдельная проверка называет причину:
       * денежные величины сервер определяет сам.
       */
      const forbidden = forbiddenClientFields((req.body ?? {}) as Record<string, unknown>);
      if (forbidden.length > 0) {
        return reply.code(400).send({
          error: 'Эти поля определяет сервер',
          code: 'FORBIDDEN_FIELDS',
          fields: forbidden,
        });
      }

      const body = decideSchema.parse(req.body);
      const userId = req.user.sub;

      const idemKey = req.headers['idempotency-key'] as string | undefined;
      if (idemKey) {
        const existing = await prisma.idempotencyKey.findUnique({ where: { key: idemKey } });
        if (existing) {
          const saved = existing.response as { requestHash?: string } | null;
          const hash = requestHash(id, body);
          // Тот же ключ с другим телом — другой запрос. Отдать ему
          // чужой ответ значит подтвердить не то, что просили.
          if (existing.userId !== userId || saved?.requestHash !== hash) {
            return reply.code(409).send({
              error: 'Ключ идемпотентности уже использован',
              code: 'IDEMPOTENCY_KEY_REUSED',
            });
          }
          return saved;
        }
      }

      const ent = await entitlementOfRequest(req);
      if (denyIfMissing(ent, 'MANUAL_TRADE', reply)) return reply;

      const result = await decideProposal({
        proposalId: id,
        actorId: userId,
        decision: body.decision,
        shownFingerprint: body.shownFingerprint,
        hasEntitlement: true,
        // LIVE заблокирован — подтверждение принимается, но остаётся
        // подготовкой. Отправлять нечем, и это не настройка.
        liveAllowed: true,
        /*
         * Blockhash берёт сервер.
         *
         * В теле запроса его нет и быть не может: схема `.strict()`,
         * а поле в неё не входит. Значение из браузера — это подпись
         * под транзакцией, которую собрал не сервер.
         */
        blockhashSource: createBlockhashSource(),
      });

      if (result.status === 'refused') {
        const code = result.refusal ?? 'NOT_FOUND';
        return reply
          .code(code === 'NOT_FOUND' ? 404 : 409)
          .send(code === 'NOT_FOUND' ? NOT_FOUND : { error: 'Отказано', code });
      }

      const response = {
        status: result.status,
        intentId: result.intentId ?? null,
        warning: APPROVAL_WARNING,
        submitted: false,
        requestHash: requestHash(id, body),
      };

      if (idemKey) {
        await prisma.idempotencyKey
          .create({ data: { key: idemKey, userId, response: response as never } })
          .catch(() => {});
      }
      return response;
    },
  );

  /** Свои намерения. */
  app.get(
    '/live/intents',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 60, timeWindow: '1m' } },
    },
    async (req) => {
      const query = listSchema.parse(req.query);
      const rows = await prisma.transactionIntent.findMany({
        where: { userId: req.user.sub },
        orderBy: { createdAt: 'desc' },
        take: query.limit,
        select: {
          id: true, state: true, network: true, purpose: true,
          createdAt: true, expiresAt: true, signedAt: true, failureCode: true,
        },
      });

      return {
        submitted: false,
        intents: rows.map((row) => ({
          id: row.id,
          // Наружу идёт стадия, а не внутреннее состояние.
          stage: intentStage(row.state as TransactionIntentState),
          network: row.network,
          purpose: row.purpose,
          createdAt: row.createdAt,
          expiresAt: row.expiresAt,
          signedAt: row.signedAt,
          failureCode: row.failureCode,
        })),
      };
    },
  );

  app.get(
    '/live/intents/:id',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 120, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const { id } = z.object({ id: z.string().min(1).max(64) }).strict().parse(req.params);
      const row = await prisma.transactionIntent.findUnique({
        where: { id },
        select: {
          id: true, userId: true, state: true, network: true, purpose: true,
          createdAt: true, expiresAt: true, signedAt: true, failureCode: true,
          keyFingerprint: true, keyVersion: true,
        },
      });
      if (!row || row.userId !== req.user.sub) return reply.code(404).send(NOT_FOUND);

      return {
        id: row.id,
        stage: intentStage(row.state as TransactionIntentState),
        network: row.network,
        purpose: row.purpose,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        signedAt: row.signedAt,
        failureCode: row.failureCode,
        /*
         * Отпечаток и версия — да, подпись и сообщение — нет.
         * Подпись публична, но полная транзакция в ответе API
         * означает содержимое перевода там, где его не ждут.
         */
        keyFingerprint: row.keyFingerprint,
        keyVersion: row.keyVersion,
        submitted: false,
      };
    },
  );

  /**
   * Шаг первый регистрации ключа: посмотреть.
   *
   * Ничего не записывает и ни к чему не привязывает. Возвращает то,
   * что администратор сверит глазами. Идентификатора ресурса в
   * ответе нет: имя ключа рассказывает об аккаунте и регионе
   * больше, чем нужно даже администратору интерфейса.
   */
  app.get(
    '/admin/live/signing-key',
    {
      preHandler: [app.requireAdmin],
      config: { rateLimit: { max: 20, timeWindow: '1m' } },
    },
    async (req, reply) => {
      try {
        const found = await discoverSigningIdentity({
          actorId: req.user.sub,
          provider: env.SOLANA_SIGNER_PROVIDER,
          network: env.SOLANA_NETWORK,
        });
        const registered = await readRegisteredIdentity();
        return {
          provider: env.SOLANA_SIGNER_PROVIDER,
          network: env.SOLANA_NETWORK,
          fingerprint: found.facts.fingerprint,
          solanaAddress: found.facts.solanaAddress,
          algorithm: found.facts.algorithm,
          keyVersion: found.facts.keyVersion,
          matchesExpected: found.matchesExpected,
          registered,
          submitted: false,
        };
      } catch (error: unknown) {
        const code = error instanceof IdentityRegistryError ? error.code : 'SIGNER_UNAVAILABLE';
        return reply.code(409).send({ error: 'Ключ недоступен', code });
      }
    },
  );

  /**
   * Шаг второй: подтверждение человеком.
   *
   * Отпечаток присылается эхом с экрана. Автоматической привязки
   * нет — это единственная проверка во всём контуре, которую сервер
   * не может сделать за человека.
   */
  app.post(
    '/admin/live/signing-key',
    {
      preHandler: [app.requireAdmin],
      config: { rateLimit: { max: 5, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const body = z
        .object({ confirmedFingerprint: z.string().min(8).max(64) })
        .strict()
        .parse(req.body);

      try {
        const identity = await registerSigningIdentity({
          actorId: req.user.sub,
          provider: env.SOLANA_SIGNER_PROVIDER,
          network: env.SOLANA_NETWORK,
          confirmedFingerprint: body.confirmedFingerprint,
        });
        return reply.code(201).send({ identity, submitted: false });
      } catch (error: unknown) {
        const code = error instanceof IdentityRegistryError ? error.code : 'SIGNER_UNAVAILABLE';
        return reply.code(409).send({ error: 'Отказано', code });
      }
    },
  );

  /** Отзыв привязки. Смена ключа проходит через явный отзыв. */
  app.delete(
    '/admin/live/signing-key',
    {
      preHandler: [app.requireAdmin],
      config: { rateLimit: { max: 5, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const body = z
        .object({ reasonCode: z.string().min(2).max(64).regex(/^[A-Z0-9_]+$/) })
        .strict()
        .parse(req.body);

      const revoked = await revokeSigningIdentity({
        actorId: req.user.sub,
        network: env.SOLANA_NETWORK,
        reasonCode: body.reasonCode,
      });
      if (!revoked) return reply.code(409).send({ error: 'Отказано', code: 'NOT_REGISTERED' });
      return { revoked: true, submitted: false };
    },
  );

  /**
   * Служебная проверочная запись.
   *
   * Только ADMIN, только вне production, только devnet, только
   * перевод самому себе. Транзакцию не отправляет.
   */
  app.post(
    '/admin/live/fixture-intent',
    {
      preHandler: [app.requireAdmin],
      config: { rateLimit: { max: 10, timeWindow: '1m' } },
    },
    async (req, reply) => {
      const body = z.object({ userId: z.string().min(1).max(64) }).strict().parse(req.body);

      const result = await createDevnetFixtureIntent({
        actorId: req.user.sub,
        userId: body.userId,
        nodeEnv: env.NODE_ENV,
        network: env.SOLANA_NETWORK,
        blockhashSource: createBlockhashSource(),
      });

      if ('refusal' in result) {
        return reply.code(409).send({ error: 'Отказано', code: result.refusal });
      }
      return reply.code(201).send({ intentId: result.intentId, submitted: false });
    },
  );
};

/**
 * Отпечаток запроса для ключа идемпотентности.
 *
 * Ключ отвечает за «тот же самый запрос», а не за «запрос от того же
 * человека». Без отпечатка тела повтор с другим решением получил бы
 * ответ от первого.
 */
function requestHash(proposalId: string, body: z.infer<typeof decideSchema>): string {
  return `${proposalId}:${body.decision}:${body.shownFingerprint}`;
}
