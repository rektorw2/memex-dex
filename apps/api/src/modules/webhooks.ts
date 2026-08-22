import type { FastifyPluginAsync } from 'fastify';
import { fromBridgeState } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { env } from '../lib/env.js';
import { serverNow } from '../lib/clock.js';
import { verifyBridgeWebhook } from '../services/payments/bridge-webhook.js';
import { verifyCoinbaseWebhook } from '../services/payments/coinbase-webhook.js';
import { getPaymentProvider } from '../services/payments/index.js';
import { applyTransferToPayment } from '../services/payments/checkout.js';
import { handleCoinbaseEvent } from '../services/payments/coinbase-checkout.js';

/**
 * События платёжного провайдера.
 *
 * Публичный адрес: сюда стучится Bridge, а вместе с ним — все, кто
 * этот адрес узнает. Единственное, что отделяет чужой запрос
 * от выдачи платной подписки, — проверка подписи, и порядок действий
 * здесь подчинён ей.
 *
 * Тело не разбирается до проверки. JSON от неизвестного отправителя
 * — это чужой ввод, и выполнять его раньше, чем доказано авторство,
 * незачем.
 *
 * Ответ отдаётся быстро. Провайдер повторяет доставку по таймауту,
 * и медленный обработчик превращает одно событие в поток одинаковых.
 * Поэтому запись о событии сохраняется сразу, а перечитывание
 * перевода и выдача подписки происходят после ответа.
 *
 * Событию не верят на слово даже после проверки подписи. Состояние
 * перевода перечитывается через API провайдера: подписанное событие
 * доказывает авторство, но не свежесть, а между отправкой события
 * и его доставкой перевод мог измениться.
 */
export const webhookRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Разбор тела в исходных байтах.
   *
   * Fastify по умолчанию разбирает JSON и отдаёт объект. Для подписи
   * нужны байты: `JSON.parse` с последующей пересборкой меняет
   * порядок ключей, пробелы и запись чисел, и подпись перестаёт
   * сходиться.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      if (req.url.startsWith('/api/webhooks/')) {
        done(null, body);
        return;
      }

      try {
        done(null, JSON.parse((body as Buffer).toString('utf8')));
      } catch (e) {
        done(e as Error, undefined);
      }
    },
  );

  app.post(
    '/webhooks/bridge',
    { config: { rateLimit: { max: 300, timeWindow: '1m' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');

      const publicKey = env.BRIDGE_WEBHOOK_PUBLIC_KEY;

      if (!publicKey) {
        // Ключа нет — проверить нечем. Принять событие «на веру»
        // означало бы открыть выдачу подписок любому, кто знает адрес.
        logger.error('получено событие Bridge, но открытый ключ вебхука не настроен');
        return reply.code(503).send({ error: 'webhook not configured' });
      }

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');

      const verified = verifyBridgeWebhook({
        rawBody: raw,
        signatureHeader: req.headers['x-webhook-signature'] as string | undefined,
        publicKeyPem: publicKey,
        nowMs: serverNow().getTime(),
        maxAgeSeconds: env.BRIDGE_WEBHOOK_MAX_AGE_SECONDS,
      });

      if (!verified.ok) {
        // Причина пишется в журнал, но не в ответ: подсказывать
        // отправителю, чем именно его подделка отличается
        // от настоящей, незачем.
        logger.warn({ reason: verified.reason }, 'событие Bridge отклонено');
        return reply.code(400).send({ error: 'invalid signature' });
      }

      const event = verified.event;

      // Запись о событии — ключ идемпотентности. Повторная доставка
      // натыкается на уникальное ограничение и не доходит до выдачи
      // подписки.
      let firstDelivery = true;

      try {
        await prisma.webhookReceipt.create({
          data: {
            provider: 'BRIDGE',
            eventId: event.eventId,
            eventType: event.eventType,
            eventCreatedAt: event.eventCreatedAt,
            outcome: 'ACCEPTED',
          },
        });
      } catch {
        // Единственная ожидаемая ошибка здесь — повтор. Любая другая
        // тоже не повод отвечать провайдеру отказом: он повторит,
        // и мы снова окажемся здесь же.
        firstDelivery = false;
      }

      if (!firstDelivery) {
        logger.info({ eventId: event.eventId }, 'повторная доставка события — пропущена');
        return { received: true, duplicate: true };
      }

      // Долгая часть выполняется после ответа. Провайдер ждёт 200
      // и повторяет доставку по таймауту; событие при этом уже
      // записано и не потеряется.
      void process(event.eventId, event.eventType, event.object).catch((e) =>
        logger.error({ eventId: event.eventId, err: e?.message }, 'обработка события не удалась'),
      );

      return { received: true };
    },
  );

  /**
   * События Coinbase Onramp.
   *
   * Тот же порядок, что у Bridge, и по тем же причинам. Отличается
   * одно: у Coinbase событие не несёт идентификатор транзакции,
   * по которому можно перечитать состояние поштучно, — несёт ссылку
   * на покупателя. Перечитывается по ней список транзакций, и решение
   * принимается по успешной, а не по названию события.
   *
   * Событие `success` доступа не выдаёт. Оно только повод сходить
   * к провайдеру: сумму, актив, сеть и адрес получателя человек
   * на его странице меняет свободно, и «успешно» там означает
   * «покупка состоялась», а не «нам заплатили».
   */
  app.post(
    '/webhooks/coinbase',
    { config: { rateLimit: { max: 300, timeWindow: '1m' } } },
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store');

      const secret = env.COINBASE_WEBHOOK_SECRET;

      if (!secret) {
        logger.error('получено событие Coinbase, но секрет вебхука не настроен');
        return reply.code(503).send({ error: 'webhook not configured' });
      }

      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body ?? ''), 'utf8');

      const verified = verifyCoinbaseWebhook({
        rawBody: raw,
        signatureHeader: req.headers['x-hook0-signature'] as string | undefined,
        headers: req.headers as Record<string, string | string[] | undefined>,
        secret,
        nowMs: serverNow().getTime(),
        maxAgeSeconds: env.COINBASE_WEBHOOK_MAX_AGE_SECONDS,
      });

      if (!verified.ok) {
        logger.warn({ reason: verified.reason }, 'событие Coinbase отклонено');
        return reply.code(400).send({ error: 'invalid signature' });
      }

      const event = verified.event;
      let firstDelivery = true;

      try {
        await prisma.webhookReceipt.create({
          data: {
            provider: 'COINBASE',
            eventId: event.eventId,
            eventType: event.eventType,
            eventCreatedAt: serverNow(),
            outcome: 'ACCEPTED',
          },
        });
      } catch {
        firstDelivery = false;
      }

      if (!firstDelivery) {
        logger.info({ eventId: event.eventId }, 'повторная доставка события Coinbase — пропущена');
        return { received: true, duplicate: true };
      }

      void processCoinbase(event.eventId, event.eventType, event.body).catch((e) =>
        logger.error(
          { eventId: event.eventId, err: e?.message },
          'обработка события Coinbase не удалась',
        ),
      );

      return { received: true };
    },
  );
};

/**
 * Обработка проверенного события Coinbase.
 *
 * Полезная нагрузка приходит либо плоской, либо вложенной в `data`.
 * Разворачивается здесь, чтобы дальше работать с одной формой.
 */
async function processCoinbase(
  eventId: string,
  eventType: string,
  body: Record<string, unknown>,
): Promise<void> {
  const nested =
    body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>) : null;

  const payload = nested ?? body;

  const { outcome, paymentId } = await handleCoinbaseEvent(eventType, payload);

  await prisma.webhookReceipt
    .updateMany({ where: { provider: 'COINBASE', eventId }, data: { outcome, paymentId } })
    .catch(() => undefined);

  logger.info({ eventId, eventType, paymentId, outcome }, 'событие Coinbase обработано');
}

/**
 * Обработка проверенного события.
 *
 * Интересует ровно один вид: изменение перевода. Всё остальное
 * записывается и игнорируется — не потому, что неважно, а потому,
 * что действий по нему у нас нет.
 */
async function process(
  eventId: string,
  eventType: string,
  object: Record<string, unknown>,
): Promise<void> {
  if (!eventType.startsWith('transfer')) {
    await mark(eventId, 'IGNORED_CATEGORY', null);
    return;
  }

  const transferId = typeof object.id === 'string' ? object.id : null;
  if (!transferId) {
    await mark(eventId, 'NO_TRANSFER_ID', null);
    return;
  }

  const payment = await prisma.subscriptionPayment.findFirst({
    where: { provider: 'BRIDGE', providerTransferId: transferId },
  });

  if (!payment) {
    // Перевод не наш или платёж ещё не записан. Событие сохранено,
    // деньги не потеряны — провайдер повторит, и к тому моменту
    // запись появится.
    await mark(eventId, 'UNKNOWN_TRANSFER', null);
    return;
  }

  const provider = getPaymentProvider();

  // Состояние перечитывается у провайдера, а не берётся из события.
  // Подпись доказывает авторство, но не свежесть: между отправкой
  // и доставкой перевод мог измениться, а события приходят
  // не по порядку.
  const fresh = await provider.getTransfer(transferId);

  if (!fresh.ok) {
    // Не смогли перечитать — состояние не меняем. Событие записано,
    // провайдер повторит, опрос по расписанию тоже дойдёт.
    await mark(eventId, `REFETCH_FAILED:${fresh.failure}`, payment.id);
    logger.warn({ eventId, failure: fresh.failure }, 'не удалось перечитать перевод');
    return;
  }

  const state = await applyTransferToPayment(payment.id, fresh.value);

  await mark(eventId, `APPLIED:${state}`, payment.id);

  logger.info(
    {
      eventId,
      paymentId: payment.id,
      rawState: fresh.value.rawState,
      mapped: fromBridgeState(fresh.value.rawState),
    },
    'событие перевода обработано',
  );
}

async function mark(eventId: string, outcome: string, paymentId: string | null): Promise<void> {
  await prisma.webhookReceipt
    .updateMany({
      where: { provider: 'BRIDGE', eventId },
      data: { outcome, paymentId },
    })
    .catch(() => undefined);
}
