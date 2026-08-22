import crypto from 'node:crypto';
import { Prisma as P, PaymentState, PlanCode, SubscriptionStatus } from '@prisma/client';
import {
  buildPartnerUserRef,
  catalogEntryFor,
  isPaidPlan,
  canTransition,
  fromCoinbaseEvent,
  PAYMENT_STATE,
  type PaidPlanCode,
} from '@memex/core';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { serverNow } from '../../lib/clock.js';
import { env } from '../../lib/env.js';
import { getCoinbase, treasuryAddress } from './index.js';
import { verifySettlement, type SettlementMismatch } from './coinbase-settlement.js';
import { grantForPayment } from './grant.js';
import type { OnrampTransaction } from './coinbase.js';

/**
 * Оплата подписки через размещённую страницу Coinbase.
 *
 * Отдельный файл от Bridge, а не ветка внутри него: пути расходятся
 * почти во всём. У Bridge человек получает банковские реквизиты
 * и переводит деньги сам; у Coinbase он уходит на чужую страницу
 * и возвращается неизвестно с каким результатом. Общего между ними
 * ровно две вещи — каталог и выдача подписки, и обе вынесены.
 *
 * Правило, вокруг которого построен весь файл: **возвращение
 * браузера не значит ничего.** Человек возвращается по кнопке
 * «назад», по закрытой вкладке, по подставленному адресу. Доступ
 * открывается только после подписанного события и перечитывания
 * транзакции у провайдера.
 */

export const COINBASE_ERROR = {
  unavailable: 'PAYMENTS_UNAVAILABLE',
  emailNotVerified: 'EMAIL_NOT_VERIFIED',
  unknownPlan: 'UNKNOWN_PLAN',
  planChangePolicy: 'PLAN_CHANGE_POLICY_REQUIRED',
  checkoutInProgress: 'CHECKOUT_IN_PROGRESS',
  providerFailed: 'PROVIDER_FAILED',
  treasuryMissing: 'TREASURY_NOT_CONFIGURED',
} as const;

export type CoinbaseError = (typeof COINBASE_ERROR)[keyof typeof COINBASE_ERROR];

const OPEN_STATES: PaymentState[] = [
  PaymentState.CREATED,
  PaymentState.AWAITING_FUNDS,
  PaymentState.IN_REVIEW,
  PaymentState.FUNDS_RECEIVED,
  PaymentState.PAYMENT_SUBMITTED,
];

export interface HostedCheckout {
  paymentId: string;
  plan: PlanCode;
  hostedUrl: string;
  expiresAt: string;
  priceAmount: string;
  priceCurrency: string;
  termDays: number;
}

export type CoinbaseCheckoutResult =
  | { ok: true; checkout: HostedCheckout }
  | { ok: false; error: CoinbaseError; detail?: string; paymentId?: string };

/**
 * Адрес человека для провайдера.
 *
 * Провайдер определяет по нему страну и доступные способы оплаты.
 * Сервер работает с `trustProxy`, то есть `req.ip` берётся
 * из `X-Forwarded-For`, и в развёртывании без доверенного посредника
 * этот заголовок пишет клиент.
 *
 * Подменённый адрес меняет ровно одно: какие способы оплаты покажет
 * провайдер и пустит ли он человека вообще. Это его граница
 * соответствия, и обходят её во вред себе. На нашу сторону это
 * не влияет: доступ выдаётся по сверке суммы, актива, сети и адреса
 * получателя, а не по стране покупателя.
 *
 * В песочнице деньги не двигаются, и документация разрешает
 * тестовый адрес.
 */
export function resolveClientIp(reqIp: string | undefined): string {
  if (env.COINBASE_ONRAMP_MODE === 'sandbox') return env.COINBASE_SANDBOX_CLIENT_IP;

  return reqIp && reqIp.length > 0 ? reqIp : env.COINBASE_SANDBOX_CLIENT_IP;
}

/**
 * Создание оплаты.
 *
 * Порядок: сначала локальная запись со ссылкой, потом токен сессии.
 * Наоборот было бы хуже — токен живёт пять минут, и если запись
 * не удалась, он просто пропал бы, а человек увидел бы ошибку после
 * того, как у провайдера уже началась сессия.
 *
 * Если провайдер не ответил, платёж не остаётся «созданным»: он
 * помечается неудачным, и повторить можно сразу. Висящий платёж
 * в состоянии `CREATED` заблокировал бы новую попытку правилом
 * «один незавершённый на план».
 */
export async function createCoinbaseCheckout(
  userId: string,
  planRaw: string,
  clientIp: string,
): Promise<CoinbaseCheckoutResult> {
  const provider = getCoinbase();
  if (!provider) return { ok: false, error: COINBASE_ERROR.unavailable };

  if (!isPaidPlan(planRaw)) return { ok: false, error: COINBASE_ERROR.unknownPlan };
  const plan = planRaw as PaidPlanCode;
  const entry = catalogEntryFor(plan);

  const treasury = treasuryAddress();
  if (!treasury) return { ok: false, error: COINBASE_ERROR.treasuryMissing };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });

  if (!user?.emailVerifiedAt) return { ok: false, error: COINBASE_ERROR.emailNotVerified };

  const now = serverNow();

  // Другой действующий платный план блокирует покупку. Правило общее
  // с Bridge и повторено здесь намеренно: пропустить его в одном
  // из двух путей значит продать второй план через тот, где забыли.
  const active = await prisma.subscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      plan: { not: PlanCode.TRIAL },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  if (active && active.plan !== plan) {
    return { ok: false, error: COINBASE_ERROR.planChangePolicy };
  }

  const open = await prisma.subscriptionPayment.findFirst({
    where: { userId, plan, state: { in: OPEN_STATES } },
  });

  if (open) {
    return { ok: false, error: COINBASE_ERROR.checkoutInProgress, paymentId: open.id };
  }

  const partnerUserRef = buildPartnerUserRef(crypto.randomBytes(18).toString('hex'));
  const clientReference = `cb-${partnerUserRef}`;

  const payment = await prisma.subscriptionPayment.create({
    data: {
      userId,
      plan: plan as PlanCode,
      priceAmount: new P.Decimal(entry.price.amount),
      priceCurrency: entry.price.currency,
      termDays: entry.termDays,
      sourceCurrency: entry.sourceCurrency,
      sourceAmount: new P.Decimal(entry.sourceAmount),
      destinationCurrency: entry.price.currency,
      destinationChain: entry.settlementChain,
      destinationAddress: treasury,
      provider: 'COINBASE',
      partnerUserRef,
      clientReference,
      state: PaymentState.CREATED,
    },
  });

  const token = await provider.createSessionToken({ clientIp, nowMs: now.getTime() });

  if (!token.ok) {
    await prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: { state: PaymentState.FAILED, reviewReason: `provider:${token.failure}` },
    });

    logger.error({ userId, plan, failure: token.failure }, 'Coinbase не выдал токен сессии');
    return { ok: false, error: COINBASE_ERROR.providerFailed, detail: token.failure };
  }

  // Токен в базу не попадает: он одноразовый, живёт пять минут,
  // и хранить его — значит держать чужую страницу оплаты, привязанную
  // к нашему адресу казначейства.
  const hostedUrl = provider.hostedUrl({
    token: token.value.token,
    partnerUserRef,
    fiatAmount: entry.sourceAmount,
  });

  await prisma.subscriptionPayment.update({
    where: { id: payment.id },
    data: { state: PaymentState.AWAITING_FUNDS, checkoutExpiresAt: token.value.expiresAt },
  });

  logger.info(
    { userId, plan, paymentId: payment.id, mode: provider.mode },
    'создана сессия оплаты Coinbase',
  );

  return {
    ok: true,
    checkout: {
      paymentId: payment.id,
      plan: plan as PlanCode,
      hostedUrl,
      expiresAt: token.value.expiresAt.toISOString(),
      priceAmount: entry.price.amount,
      priceCurrency: entry.price.currency,
      termDays: entry.termDays,
    },
  };
}

/**
 * Применение состояния транзакции к платежу.
 *
 * Единственное место, где Coinbase может привести к выдаче подписки.
 * Успех проходит через полную сверку; расхождение уводит платёж
 * в ручной разбор, не теряя ни денег, ни данных.
 */
export async function applyCoinbaseTransaction(
  paymentId: string,
  tx: OnrampTransaction,
): Promise<PaymentState> {
  const payment = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });

  // Транзакция, уже привязанная к другому платежу, не должна
  // оплатить вторую подписку.
  const taken = await prisma.subscriptionPayment.findFirst({
    where: {
      provider: 'COINBASE',
      providerTransferId: tx.transactionId,
      id: { not: paymentId },
    },
    select: { id: true },
  });

  let mismatch: SettlementMismatch | null = null;

  if (tx.state === PAYMENT_STATE.paid) {
    const verdict = verifySettlement(
      tx,
      {
        partnerUserRef: payment.partnerUserRef ?? '',
        purchaseAmount: payment.priceAmount.toString(),
        purchaseCurrency: payment.destinationCurrency,
        purchaseNetwork: payment.destinationChain,
        treasuryAddress: payment.destinationAddress,
        fiatCurrency: payment.sourceCurrency,
      },
      taken ? { transactionId: tx.transactionId, paymentId: taken.id } : null,
    );

    if (!verdict.ok) mismatch = verdict.mismatch;
  }

  const next = mismatch ? PAYMENT_STATE.manualReview : tx.state;

  // Фактические поля сохраняются всегда, даже когда состояние
  // не двигается: они нужны для разбора, и потерять их значит
  // разбираться вслепую.
  const facts = {
    providerTransferId: tx.transactionId,
    purchaseAmount: tx.purchaseAmount ? new P.Decimal(tx.purchaseAmount) : null,
    purchaseCurrency: tx.purchaseCurrency,
    purchaseNetwork: tx.purchaseNetwork,
    paymentSubtotal: tx.paymentSubtotal ? new P.Decimal(tx.paymentSubtotal) : null,
    paymentTotal: tx.paymentTotal ? new P.Decimal(tx.paymentTotal) : null,
    paymentCurrency: tx.paymentCurrency,
    providerFee: tx.coinbaseFee ? new P.Decimal(tx.coinbaseFee) : null,
    networkFee: tx.networkFee ? new P.Decimal(tx.networkFee) : null,
    deliveredToAddress: tx.walletAddress,
    destinationTxHash: tx.txHash,
    providerTxType: tx.type,
  };

  if (!canTransition(payment.state as never, next as never)) {
    await prisma.subscriptionPayment.update({ where: { id: paymentId }, data: facts });
    return payment.state;
  }

  const updated = await prisma.subscriptionPayment.update({
    where: { id: paymentId },
    data: {
      ...facts,
      state: next as PaymentState,
      ...(mismatch ? { reviewReason: mismatch } : {}),
      ...(next === PAYMENT_STATE.paid ? { paidAt: serverNow(), deliveredAmount: facts.purchaseAmount } : {}),
    },
  });

  if (mismatch) {
    logger.error(
      { paymentId, reason: mismatch, rawStatus: tx.rawStatus },
      'платёж Coinbase отправлен на разбор: транзакция не совпала',
    );
  }

  if (updated.state === PaymentState.PAID) await grantForPayment(paymentId);

  return updated.state;
}

/**
 * Обработка проверенного события.
 *
 * Событие `success` намеренно не двигает состояние само: оно только
 * повод перечитать транзакцию. Всё остальное проходит по общему
 * пути и тоже перечитывается — доверять телу события, когда рядом
 * есть источник истины, незачем.
 */
export async function handleCoinbaseEvent(
  eventType: string,
  body: Record<string, unknown>,
): Promise<{ outcome: string; paymentId: string | null }> {
  const ref = typeof body.partnerUserRef === 'string' ? body.partnerUserRef : null;
  if (!ref) return { outcome: 'NO_PARTNER_REF', paymentId: null };

  const payment = await prisma.subscriptionPayment.findFirst({
    where: { provider: 'COINBASE', partnerUserRef: ref },
  });

  if (!payment) return { outcome: 'UNKNOWN_REF', paymentId: null };

  const provider = getCoinbase();
  if (!provider) return { outcome: 'PROVIDER_DISABLED', paymentId: payment.id };

  const fresh = await provider.successfulTransaction(ref);

  if (!fresh.ok) {
    // Не перечитали — состояние не меняем. Событие записано,
    // провайдер повторит, опрос по расписанию тоже дойдёт.
    logger.warn({ paymentId: payment.id, failure: fresh.failure }, 'не удалось перечитать транзакцию');
    return { outcome: `REFETCH_FAILED:${fresh.failure}`, paymentId: payment.id };
  }

  if (!fresh.value) {
    // Транзакции ещё нет — обычное дело для `created`.
    const hinted = fromCoinbaseEvent(eventType);

    if (hinted && canTransition(payment.state as never, hinted as never)) {
      await prisma.subscriptionPayment.update({
        where: { id: payment.id },
        data: { state: hinted as PaymentState },
      });
    }

    return { outcome: `NO_TRANSACTION:${eventType}`, paymentId: payment.id };
  }

  const state = await applyCoinbaseTransaction(payment.id, fresh.value);
  return { outcome: `APPLIED:${state}`, paymentId: payment.id };
}

/**
 * Перечитывание по запросу от интерфейса.
 *
 * Нужно после возвращения браузера: событие могло ещё не дойти,
 * а человек уже смотрит на экран. Выдачу подписки это не ускоряет
 * в обход правил — путь тот же, со сверкой.
 */
export async function refreshCoinbasePayment(paymentId: string): Promise<PaymentState | null> {
  const payment = await prisma.subscriptionPayment.findUnique({ where: { id: paymentId } });
  if (!payment?.partnerUserRef || payment.provider !== 'COINBASE') return null;

  const provider = getCoinbase();
  if (!provider) return payment.state;

  const fresh = await provider.successfulTransaction(payment.partnerUserRef);
  if (!fresh.ok || !fresh.value) return payment.state;

  return applyCoinbaseTransaction(payment.id, fresh.value);
}
