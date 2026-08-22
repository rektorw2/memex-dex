import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import {
  capabilityList,
  entitlementFor,
  subscriptionPriceFor,
  TRIAL_DURATION_HOURS,
  VERIFY_RESULT,
} from '@memex/core';
import {
  entitlementOfRequest,
  accessView,
  applyCacheHeaders,
} from '../services/entitlement.js';
import { activateTrial } from '../services/trial.js';
import { issueCode, verifyCode } from '../services/email-verify.js';
import { logger } from '../lib/logger.js';
import { serverNow } from '../lib/clock.js';

/**
 * Что пользователю доступно и как включить пробный период.
 *
 * Два маршрута, и оба отвечают только про того, кто спрашивает.
 * Чужих данных, номеров платежей и внутренних записей журнала здесь
 * нет: интерфейсу они не нужны, а в логах браузера и в истории
 * запросов оседают надолго.
 */
export const accessRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Текущее состояние доступа.
   *
   * Отдаёт и то, что разрешено, и то, что можно получить: остаток
   * пробного периода, возможность его начать, необходимость купить
   * подписку. Интерфейс собирается из этого ответа целиком и своих
   * догадок о планах не строит.
   */
  app.get('/access/me', { preHandler: [app.authenticate] }, async (req, reply) => {
    applyCacheHeaders(reply);

    const ent = await entitlementOfRequest(req, serverNow());
    return accessView(ent);
  });

  /**
   * Включение пробного периода.
   *
   * Начинается по нажатию, а не при регистрации: иначе человек,
   * зарегистрировавшийся «посмотреть» и вернувшийся через неделю,
   * обнаружит, что бесплатный доступ кончился, пока он им
   * не пользовался.
   *
   * Повторный запрос возвращает уже существующий период, не двигая
   * ни начала, ни конца. Продлить его вторым нажатием, выходом
   * и новым входом нельзя.
   *
   * Ни `startsAt`, ни `expiresAt`, ни `plan` из тела запроса
   * не читаются — их здесь не существует. Сроки считает сервер
   * по своим часам в UTC.
   */
  app.post('/access/trial/activate', { preHandler: [app.authenticate] }, async (req, reply) => {
    applyCacheHeaders(reply);

    const userId = req.user.sub;
    const now = serverNow();

    const res = await activateTrial(userId, now);

    if (!res.ok) {
      if (res.reason === 'EMAIL_NOT_VERIFIED') {
        return reply.code(403).send({
          error: 'Подтвердите адрес почты, чтобы включить бесплатный период',
          code: 'EMAIL_NOT_VERIFIED',
        });
      }

      return reply.code(409).send({
        error: 'Бесплатный период уже использован',
        code: 'TRIAL_ALREADY_USED',
      });
    }

    if (res.created) {
      logger.info({ userId, hours: TRIAL_DURATION_HOURS }, 'пробный период выдан');
    }

    // Права считаются заново, а не собираются из того, что мы только
    // что записали. Так ответ показывает то же самое, что покажет
    // следующий запрос: если у человека уже есть оплаченный план,
    // он и останется действующим, а пробный период просто отмечен
    // как использованный.
    const ent = await entitlementOfRequest(req, now);

    return reply.code(res.created ? 201 : 200).send({
      plan: ent.plan,
      status: res.created ? 'started' : 'already_active',
      startsAt: res.trial.startsAt.toISOString(),
      expiresAt: res.trial.expiresAt.toISOString(),
      serverTime: now.toISOString(),
      capabilities: capabilityList(ent),
    });
  });

  /**
   * Запрос кода подтверждения почты.
   *
   * Без подтверждённого адреса пробный период не выдаётся, поэтому
   * маршрут существует не сам по себе, а как обязательный шаг перед
   * ним. Пауза между письмами обязательна: без неё форма
   * превращается в рассыльщик на чужой адрес, причём отправляем их
   * мы и своей репутацией отправителя.
   *
   * Ограничение частоты стоит и на уровне маршрута: пауза защищает
   * один адрес, а лимит — сервер.
   */
  app.post(
    '/access/email/code',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 5, timeWindow: '15m' } },
    },
    async (req, reply) => {
      applyCacheHeaders(reply);

      // Адрес получателя берётся из записи пользователя по
      // идентификатору из токена. Тело запроса здесь не читается
      // вовсе: подставить чужой адрес нечем.
      const res = await issueCode(req.user.sub, serverNow());

      if (!res.ok) {
        if (res.reason === 'ALREADY_VERIFIED') {
          return reply.code(409).send({ error: 'Адрес уже подтверждён', code: 'ALREADY_VERIFIED' });
        }

        if (res.reason === 'NO_USER') {
          return reply.code(401).send({ error: 'Требуется авторизация', code: 'NO_USER' });
        }

        if (res.reason === 'EMAIL_DELIVERY_UNAVAILABLE') {
          // Честный отказ вместо мнимого успеха. Интерфейс покажет,
          // что дело не в пользователе, и не станет предлагать ввести
          // код, которого не будет.
          return reply.code(503).send({
            error: 'Отправка писем не настроена. Обратитесь в поддержку.',
            code: 'EMAIL_DELIVERY_UNAVAILABLE',
            retryAfterSeconds: 0,
          });
        }

        if (res.reason === 'EMAIL_DELIVERY_FAILED') {
          // Паузы нет: письма не было, и ждать не за что.
          return reply.code(502).send({
            error: 'Почтовый сервис не принял письмо. Попробуйте ещё раз.',
            code: 'EMAIL_DELIVERY_FAILED',
            retryAfterSeconds: 0,
          });
        }

        return reply.code(429).send({
          error: 'Письмо уже отправлено, подождите',
          code: 'TOO_SOON',
          retryAfterSeconds: res.retryAfterSeconds ?? 0,
        });
      }

      return {
        sent: true,
        expiresAt: res.expiresAt.toISOString(),
        // Код возвращается только там, где письма всё равно
        // не уходят, — на транспорте разработки. В production
        // этого поля не существует.
        ...(res.devCode ? { devCode: res.devCode } : {}),
      };
    },
  );

  /**
   * Проверка кода.
   *
   * Ответ различает причины: истёкший код, неверный и исчерпанные
   * попытки требуют от человека разного. Подсказки чужому здесь нет —
   * письмо приходило не ему.
   */
  app.post(
    '/access/email/verify',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: '15m' } },
    },
    async (req, reply) => {
      applyCacheHeaders(reply);

      const body = z.object({ code: z.string().min(1).max(16) }).parse(req.body);
      const { result, verifiedAt } = await verifyCode(req.user.sub, body.code, serverNow());

      if (result === VERIFY_RESULT.ok || result === VERIFY_RESULT.alreadyVerified) {
        return {
          verified: true,
          verifiedAt: verifiedAt?.toISOString() ?? null,
          // Подтверждение почты — единственное, что стояло между
          // человеком и бесплатным периодом. Сообщаем об этом сразу,
          // чтобы интерфейсу не пришлось догадываться.
          canStartTrial: (await entitlementOfRequest(req, serverNow())).canStartTrial,
        };
      }

      const codes: Record<string, number> = {
        [VERIFY_RESULT.expired]: 410,
        [VERIFY_RESULT.tooManyAttempts]: 429,
        [VERIFY_RESULT.noCode]: 409,
        [VERIFY_RESULT.wrong]: 400,
      };

      return reply.code(codes[result] ?? 400).send({ error: 'Код не принят', code: result });
    },
  );

  /**
   * Что даёт каждый план.
   *
   * Открыто всем, включая анонимов: это витрина тарифов, а не данные
   * пользователя. Собирается из той же таблицы, по которой работают
   * проверки, — страница сравнения планов не может разойтись с тем,
   * что происходит на самом деле.
   */
  app.get('/access/plans', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');

    return {
      trialHours: TRIAL_DURATION_HOURS,
      plans: (['TRIAL', 'PRO', 'SEMI_AUTO', 'FULL_AUTO'] as const).map((plan) => ({
        plan,
        price: plan === 'TRIAL' ? null : subscriptionPriceFor(plan),
        capabilities: capabilityList(entitlementFor(plan)),
      })),
    };
  });
};
