import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { catalogList, TRIAL_DURATION_HOURS } from '@memex/core';
import { env } from '../lib/env.js';
import {
  startOnboarding,
  refreshOnboarding,
  createCheckout,
  paymentForUser,
  paymentsForUser,
  CHECKOUT_ERROR,
  type CheckoutError,
} from '../services/payments/checkout.js';
import {
  createCoinbaseCheckout,
  refreshCoinbasePayment,
  resolveClientIp,
} from '../services/payments/coinbase-checkout.js';
import {
  getPaymentProvider,
  getCoinbase,
  activeProvider,
  paymentsEnabled,
} from '../services/payments/index.js';
import { providerProfile, PROVIDER_CAPABILITY } from '@memex/core';

/**
 * Оплата подписок.
 *
 * Все маршруты требуют авторизации и отдают только собственные данные
 * обратившегося. Банковские реквизиты, идентификаторы у провайдера
 * и состояние проверки личности — сведения о конкретном человеке,
 * и увидеть их может только он.
 *
 * Ответы не кешируются: между двумя запросами меняется и состояние
 * платежа, и то, кто спрашивает.
 */

/** Соответствие наших причин и кодов HTTP. */
const STATUS: Record<CheckoutError | 'KYC_NOT_APPLICABLE', number> = {
  KYC_NOT_APPLICABLE: 409,
  PAYMENTS_UNAVAILABLE: 503,
  EMAIL_NOT_VERIFIED: 403,
  KYC_REQUIRED: 403,
  UNKNOWN_PLAN: 400,
  PLAN_CHANGE_POLICY_REQUIRED: 409,
  CHECKOUT_IN_PROGRESS: 409,
  PROVIDER_FAILED: 502,
  TREASURY_NOT_CONFIGURED: 503,
};

const MESSAGE: Record<CheckoutError | 'KYC_NOT_APPLICABLE', string> = {
  KYC_NOT_APPLICABLE: 'Действующий провайдер проверяет личность внутри оплаты',
  PAYMENTS_UNAVAILABLE: 'Оплата подписок сейчас недоступна',
  EMAIL_NOT_VERIFIED: 'Сначала подтвердите адрес почты',
  KYC_REQUIRED: 'Нужно пройти проверку личности и принять условия',
  UNKNOWN_PLAN: 'Такого плана нет',
  PLAN_CHANGE_POLICY_REQUIRED: 'У вас действует другой платный план. Смена плана обсуждается с поддержкой',
  CHECKOUT_IN_PROGRESS: 'Незавершённая оплата этого плана уже создана',
  PROVIDER_FAILED: 'Платёжный сервис не ответил. Попробуйте позже',
  TREASURY_NOT_CONFIGURED: 'Оплата подписок сейчас недоступна',
};

export const paymentRoutes: FastifyPluginAsync = async (app) => {
  const noStore = (reply: { header: (k: string, v: string) => unknown }) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('Vary', 'Authorization');
  };

  /**
   * Каталог тарифов.
   *
   * Открыт всем: это витрина. Цены, срок и валюты приходят отсюда,
   * и интерфейс своей таблицы планов не держит — иначе она разойдётся
   * с той, по которой считают деньги.
   *
   * Признак `paymentsEnabled` честно говорит, работает ли оплата.
   * Показать активную кнопку, за которой ничего нет, — худшее, что
   * можно сделать на странице с ценами.
   */
  app.get('/payments/catalog', async (_req, reply) => {
    reply.header('Cache-Control', 'public, max-age=300');

    return {
      trialHours: TRIAL_DURATION_HOURS,
      paymentsEnabled: paymentsEnabled(),
      plans: catalogList().map((e) => ({
        plan: e.plan,
        price: e.price,
        termDays: e.termDays,
        sourceCurrency: e.sourceCurrency,
        sourceAmount: e.sourceAmount,
        settlementChain: e.settlementChain,
      })),
    };
  });

  /**
   * Начало проверки личности.
   *
   * Имя спрашивается явно: вывести его из адреса почты нельзя,
   * а провайдер сверяет имя с документом. Адрес берётся из записи
   * пользователя — из тела запроса он не читается.
   */
  app.post(
    '/payments/onboarding',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 5, timeWindow: '15m' } },
    },
    async (req, reply) => {
      noStore(reply);

      if (activeProvider() !== 'bridge') {
        // У Coinbase проверка личности происходит внутри его же
        // страницы оплаты. Отдельного шага нет, и делать вид, что он
        // есть, значит отправить человека в тупик.
        return reply
          .code(STATUS.KYC_NOT_APPLICABLE)
          .send({ error: MESSAGE.KYC_NOT_APPLICABLE, code: 'KYC_NOT_APPLICABLE' });
      }

      const body = z
        .object({ fullName: z.string().trim().min(2).max(120) })
        .parse(req.body);

      const res = await startOnboarding(req.user.sub, body.fullName);

      if (!res.ok) {
        return reply
          .code(STATUS[res.error])
          .send({ error: MESSAGE[res.error], code: res.error });
      }

      return {
        kycUrl: res.kycUrl,
        tosUrl: res.tosUrl,
        kycState: res.kycState,
        tosAccepted: res.tosAccepted,
      };
    },
  );

  /**
   * Состояние проверки.
   *
   * Перечитывается у провайдера. Возвращение браузера с его страницы
   * состоянием не является — браузер возвращается и по кнопке «назад».
   */
  app.get('/payments/onboarding', { preHandler: [app.authenticate] }, async (req, reply) => {
    noStore(reply);

    if (activeProvider() !== 'bridge') {
      return { kycState: 'NOT_REQUIRED', tosAccepted: true, kycUrl: null, tosUrl: null };
    }

    const res = await refreshOnboarding(req.user.sub);

    if (!res.ok) {
      if (res.error === CHECKOUT_ERROR.kycRequired) {
        return { kycState: 'NOT_STARTED', tosAccepted: false, kycUrl: null, tosUrl: null };
      }

      return reply.code(STATUS[res.error]).send({ error: MESSAGE[res.error], code: res.error });
    }

    return {
      kycUrl: res.kycUrl,
      tosUrl: res.tosUrl,
      kycState: res.kycState,
      tosAccepted: res.tosAccepted,
    };
  });

  /**
   * Создание оплаты.
   *
   * Принимается только код плана. Сумма, срок, валюта, сеть и адрес
   * доставки берутся из каталога и настроек: значение, названное
   * клиентом, — это его пожелание, а не цена.
   */
  app.post(
    '/payments/checkout',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 10, timeWindow: '15m' } },
    },
    async (req, reply) => {
      noStore(reply);

      const body = z.object({ plan: z.string().min(1).max(32) }).parse(req.body);

      // Провайдер выбирается настройкой сервера. Поля `provider`
      // в запросе нет и быть не должно: выбор того, чьи правила
      // применяются к деньгам, клиенту не принадлежит.
      if (activeProvider() === 'coinbase') {
        const ip = resolveClientIp(req.ip);
        const cb = await createCoinbaseCheckout(req.user.sub, body.plan, ip);

        if (!cb.ok) {
          return reply.code(STATUS[cb.error]).send({
            error: MESSAGE[cb.error],
            code: cb.error,
            ...(cb.error === CHECKOUT_ERROR.checkoutInProgress && cb.paymentId
              ? { paymentId: cb.paymentId }
              : {}),
          });
        }

        return reply.code(201).send(cb.checkout);
      }

      const res = await createCheckout(req.user.sub, body.plan);

      if (!res.ok) {
        return reply.code(STATUS[res.error]).send({
          error: MESSAGE[res.error],
          code: res.error,
          ...(res.error === CHECKOUT_ERROR.checkoutInProgress && res.detail
            ? { paymentId: res.detail }
            : {}),
        });
      }

      return reply.code(201).send(res.checkout);
    },
  );

  /** Свой платёж. Чужой не отдаётся — ответ такой же, как для несуществующего. */
  app.get('/payments/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    noStore(reply);

    const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);
    const payment = await paymentForUser(req.user.sub, id);

    if (!payment) return reply.code(404).send({ error: 'Платёж не найден' });

    return payment;
  });

  /**
   * Перечитывание платежа у провайдера.
   *
   * Нужно после возврата из размещённой оплаты. Возврат браузера
   * состоянием не является и доступа не даёт — он лишь повод сходить
   * к провайдеру и спросить, что там на самом деле. Решение
   * принимается там же, где и по вебхуку, теми же правилами сверки.
   *
   * Ограничение по частоте здесь строже обычного: это единственный
   * маршрут, который со стороны браузера дёргает внешний API.
   */
  app.post(
    '/payments/:id/refresh',
    {
      preHandler: [app.authenticate],
      config: { rateLimit: { max: 30, timeWindow: '5m' } },
    },
    async (req, reply) => {
      noStore(reply);

      const { id } = z.object({ id: z.string().min(1).max(64) }).parse(req.params);

      // Сначала владение, потом обращение к провайдеру: иначе
      // чужой идентификатор превращал бы наш сервер в средство
      // опроса провайдера по чужим платежам.
      const owned = await paymentForUser(req.user.sub, id);
      if (!owned) return reply.code(404).send({ error: 'Платёж не найден' });

      if (owned.provider === 'COINBASE') await refreshCoinbasePayment(id);

      return (await paymentForUser(req.user.sub, id)) ?? owned;
    },
  );

  /** Свои платежи. */
  app.get('/payments', { preHandler: [app.authenticate] }, async (req, reply) => {
    noStore(reply);

    const q = z.object({ limit: z.coerce.number().min(1).max(100).default(50) }).parse(req.query);

    return { payments: await paymentsForUser(req.user.sub, q.limit) };
  });

  /** Состояние модуля. Нужно интерфейсу, чтобы не рисовать мёртвую кнопку. */
  app.get('/payments/status', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');

    const active = activeProvider();
    const coinbase = active === 'coinbase' ? getCoinbase() : null;

    // Возможности отдаются интерфейсу, чтобы он не держал свою карту
    // провайдеров. Иначе первая же смена провайдера оставила бы
    // на странице шаг, которого больше нет.
    const profile =
      active === 'bridge'
        ? providerProfile('BRIDGE')
        : active === 'coinbase'
          ? providerProfile('COINBASE')
          : null;

    return {
      enabled: paymentsEnabled(),
      provider: active,
      capabilities: profile?.capabilities ?? [],
      kycInsideCheckout: profile?.kycInsideCheckout ?? false,
      needsSeparateKyc:
        profile != null &&
        profile.capabilities.includes(PROVIDER_CAPABILITY.hostedKyc) &&
        !profile.kycInsideCheckout,
      // Песочница называется песочницей. Человек, оказавшийся на ней
      // с настоящей картой, должен это видеть до, а не после.
      sandbox: coinbase?.mode === 'sandbox',
      executionMode: env.EXECUTION_MODE,
    };
  });
};
