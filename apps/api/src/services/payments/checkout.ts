import crypto from 'node:crypto';
import { Prisma as P, PlanCode, PaymentState, KycState, SubscriptionStatus, SubscriptionSource } from '@prisma/client';
import {
  catalogEntryFor,
  isPaidPlan,
  sameMoney,
  canTransition,
  grantsAccess,
  kycAllowsPayment,
  renewalPeriodEnd,
  PAYMENT_STATE,
  type PaidPlanCode,
} from '@memex/core';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { serverNow } from '../../lib/clock.js';
import { getPaymentProvider, treasuryAddress } from './index.js';
import { grantForPayment } from './grant.js';
import type { ProviderTransfer } from './provider.js';

/**
 * Оркестрация оплаты подписки.
 *
 * Здесь встречаются три источника правды, и порядок между ними
 * определён жёстко.
 *
 * **Каталог** решает, сколько стоит план, на сколько суток он
 * покупается и в какой сети приходит оплата. Клиент присылает только
 * код плана; всё остальное сервер берёт сам.
 *
 * **Наша запись платежа** хранит снимок каталога на момент покупки.
 * Если завтра тариф подорожает, начатый платёж завершится по старой
 * цене — человек видел одну сумму, а платит другую только в обмане.
 *
 * **Провайдер** сообщает, что произошло с деньгами. Ему верят
 * в одном: в факте доставки. Всё, что он говорит про план, срок
 * и цену, сверяется с нашей записью, а не принимается.
 *
 * И главное правило: доступ выдаёт ровно одно состояние —
 * подтверждённая доставка на наш адрес нужной суммы в нужной валюте.
 * Ни полученные провайдером деньги, ни отправленный перевод, ни
 * возвращение браузера на страницу успеха доступа не открывают.
 */

export const CHECKOUT_ERROR = {
  paymentsUnavailable: 'PAYMENTS_UNAVAILABLE',
  emailNotVerified: 'EMAIL_NOT_VERIFIED',
  kycRequired: 'KYC_REQUIRED',
  unknownPlan: 'UNKNOWN_PLAN',
  planChangePolicy: 'PLAN_CHANGE_POLICY_REQUIRED',
  checkoutInProgress: 'CHECKOUT_IN_PROGRESS',
  providerFailed: 'PROVIDER_FAILED',
  treasuryMissing: 'TREASURY_NOT_CONFIGURED',
} as const;

export type CheckoutError = (typeof CHECKOUT_ERROR)[keyof typeof CHECKOUT_ERROR];

/** Состояния платежа, которые ещё не закончились. */
const OPEN_STATES: PaymentState[] = [
  PaymentState.CREATED,
  PaymentState.KYC_REQUIRED,
  PaymentState.AWAITING_FUNDS,
  PaymentState.IN_REVIEW,
  PaymentState.FUNDS_RECEIVED,
  PaymentState.PAYMENT_SUBMITTED,
];

// ─────────────────────────── Проверка личности ──────────────────────────────

export type OnboardingResult =
  | { ok: true; kycUrl: string; tosUrl: string; kycState: KycState; tosAccepted: boolean }
  | { ok: false; error: CheckoutError; detail?: string };

/**
 * Создание или получение размещённой проверки личности.
 *
 * Почта берётся из записи пользователя. Из тела запроса адрес
 * не читается: иначе проверку можно было бы пройти на чужой адрес
 * и привязать чужого клиента провайдера к своему аккаунту.
 *
 * Имя спрашивается у человека явно и приходит параметром. Вывести
 * его из почты нельзя — «i.petrov@» не является именем, а провайдер
 * сверяет имя с документом.
 */
export async function startOnboarding(
  userId: string,
  fullName: string,
): Promise<OnboardingResult> {
  const provider = getPaymentProvider();
  if (!provider.enabled) return { ok: false, error: CHECKOUT_ERROR.paymentsUnavailable };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerifiedAt: true },
  });

  if (!user) return { ok: false, error: CHECKOUT_ERROR.emailNotVerified };
  if (!user.emailVerifiedAt) return { ok: false, error: CHECKOUT_ERROR.emailNotVerified };

  const existing = await prisma.paymentCustomer.findUnique({
    where: { userId_provider: { userId, provider: 'BRIDGE' } },
  });

  // Повторный вызов возвращает ту же проверку. Создавать вторую
  // значит запутать человека двумя ссылками и провайдера — двумя
  // заявками на одного клиента.
  if (existing?.externalKycLinkId && existing.kycUrl && existing.tosUrl) {
    const fresh = await refreshOnboarding(userId);
    if (fresh.ok) return fresh;

    return {
      ok: true,
      kycUrl: existing.kycUrl,
      tosUrl: existing.tosUrl,
      kycState: existing.kycState,
      tosAccepted: existing.tosAccepted,
    };
  }

  const res = await provider.createKycLink({
    fullName,
    email: user.email,
    // Ключ устойчив: повтор запроса не создаёт вторую заявку
    // ни у нас, ни у провайдера.
    idempotencyKey: `kyc-${userId}`,
  });

  if (!res.ok) {
    logger.error({ userId, failure: res.failure }, 'провайдер не выдал ссылку на проверку');
    return { ok: false, error: CHECKOUT_ERROR.providerFailed, detail: res.failure };
  }

  const link = res.value;

  await prisma.paymentCustomer.upsert({
    where: { userId_provider: { userId, provider: 'BRIDGE' } },
    create: {
      userId,
      provider: 'BRIDGE',
      externalKycLinkId: link.externalKycLinkId,
      externalCustomerId: link.externalCustomerId,
      kycState: link.kycState,
      tosAccepted: link.tosAccepted,
      kycUrl: link.kycUrl,
      tosUrl: link.tosUrl,
    },
    update: {
      externalKycLinkId: link.externalKycLinkId,
      externalCustomerId: link.externalCustomerId,
      kycState: link.kycState,
      tosAccepted: link.tosAccepted,
      kycUrl: link.kycUrl,
      tosUrl: link.tosUrl,
    },
  });

  return {
    ok: true,
    kycUrl: link.kycUrl,
    tosUrl: link.tosUrl,
    kycState: link.kycState,
    tosAccepted: link.tosAccepted,
  };
}

/**
 * Перечитывание состояния проверки у провайдера.
 *
 * Возвращение браузера с его страницы состоянием не является:
 * браузер возвращается и по кнопке «назад», и по закрытой вкладке.
 * Состояние меняет только ответ провайдера или подписанное событие.
 */
export async function refreshOnboarding(userId: string): Promise<OnboardingResult> {
  const provider = getPaymentProvider();
  if (!provider.enabled) return { ok: false, error: CHECKOUT_ERROR.paymentsUnavailable };

  const row = await prisma.paymentCustomer.findUnique({
    where: { userId_provider: { userId, provider: 'BRIDGE' } },
  });

  if (!row?.externalKycLinkId) return { ok: false, error: CHECKOUT_ERROR.kycRequired };

  const res = await provider.getKycLink(row.externalKycLinkId);
  if (!res.ok) return { ok: false, error: CHECKOUT_ERROR.providerFailed, detail: res.failure };

  const link = res.value;

  await prisma.paymentCustomer.update({
    where: { id: row.id },
    data: {
      kycState: link.kycState,
      tosAccepted: link.tosAccepted,
      externalCustomerId: link.externalCustomerId ?? row.externalCustomerId,
      kycUrl: link.kycUrl,
      tosUrl: link.tosUrl,
    },
  });

  return {
    ok: true,
    kycUrl: link.kycUrl,
    tosUrl: link.tosUrl,
    kycState: link.kycState,
    tosAccepted: link.tosAccepted,
  };
}

// ────────────────────────────── Создание оплаты ─────────────────────────────

export interface CheckoutView {
  paymentId: string;
  provider: string;
  plan: PlanCode;
  state: PaymentState;
  priceAmount: string;
  priceCurrency: string;
  termDays: number;
  sourceCurrency: string;
  sourceAmount: string;
  destinationCurrency: string;
  destinationChain: string;
  instructions: {
    depositMessage: string | null;
    bankName: string | null;
    accountNumber: string | null;
    routingNumber: string | null;
  } | null;
  destinationTxHash: string | null;
  receiptUrl: string | null;
  deliveredAmount: string | null;
  createdAt: string;
  paidAt: string | null;
}

export type CheckoutResult =
  | { ok: true; checkout: CheckoutView }
  | { ok: false; error: CheckoutError; detail?: string };

/**
 * Создание оплаты.
 *
 * Единственное, что берётся от клиента, — код плана. Сумма, срок,
 * валюта, сеть и адрес приходят из каталога и настроек.
 */
export async function createCheckout(
  userId: string,
  planRaw: string,
): Promise<CheckoutResult> {
  const provider = getPaymentProvider();
  if (!provider.enabled) return { ok: false, error: CHECKOUT_ERROR.paymentsUnavailable };

  if (!isPaidPlan(planRaw)) return { ok: false, error: CHECKOUT_ERROR.unknownPlan };
  const plan = planRaw as PaidPlanCode;
  const entry = catalogEntryFor(plan);

  const treasury = treasuryAddress();
  if (!treasury) return { ok: false, error: CHECKOUT_ERROR.treasuryMissing };

  const customer = await prisma.paymentCustomer.findUnique({
    where: { userId_provider: { userId, provider: 'BRIDGE' } },
  });

  if (!customer?.externalCustomerId || !kycAllowsPayment(customer.kycState, customer.tosAccepted)) {
    return { ok: false, error: CHECKOUT_ERROR.kycRequired };
  }

  const now = serverNow();

  // Другой действующий платный план блокирует покупку. Правила
  // перехода между планами — пропорциональный пересчёт, возврат
  // остатка — это бизнес-решение, которого нет; молча продать второй
  // план значит взять деньги, не зная, что за них отдать.
  const active = await prisma.subscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      plan: { not: PlanCode.TRIAL },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
  });

  if (active && active.plan !== plan) {
    return { ok: false, error: CHECKOUT_ERROR.planChangePolicy };
  }

  // Один незавершённый платёж на пару «пользователь и план».
  // Иначе человек создаёт три счёта, платит по одному и ждёт,
  // что закроются все.
  const open = await prisma.subscriptionPayment.findFirst({
    where: { userId, plan, state: { in: OPEN_STATES } },
  });

  if (open) {
    return { ok: false, error: CHECKOUT_ERROR.checkoutInProgress, detail: open.id };
  }

  // Ключ идемпотентности устойчив в пределах одной покупки и разный
  // между покупками: продление того же плана — это новый платёж.
  const clientReference = `sub-${userId}-${plan}-${crypto.randomUUID()}`;

  const payment = await prisma.subscriptionPayment.create({
    data: {
      userId,
      customerId: customer.id,
      plan: plan as PlanCode,
      priceAmount: new P.Decimal(entry.price.amount),
      priceCurrency: entry.price.currency,
      termDays: entry.termDays,
      sourceCurrency: entry.sourceCurrency,
      sourceAmount: new P.Decimal(entry.sourceAmount),
      destinationCurrency: entry.price.currency,
      destinationChain: entry.settlementChain,
      destinationAddress: treasury,
      clientReference,
      state: PaymentState.CREATED,
    },
  });

  const res = await provider.createTransfer({
    externalCustomerId: customer.externalCustomerId,
    sourceAmount: entry.sourceAmount,
    destinationAddress: treasury,
    idempotencyKey: clientReference,
  });

  if (!res.ok) {
    await prisma.subscriptionPayment.update({
      where: { id: payment.id },
      data: { state: PaymentState.FAILED, reviewReason: `provider:${res.failure}` },
    });

    logger.error({ userId, plan, failure: res.failure }, 'провайдер не создал перевод');
    return { ok: false, error: CHECKOUT_ERROR.providerFailed, detail: res.failure };
  }

  const transfer = res.value;
  const updated = await applyTransfer(payment.id, transfer, 'checkout');

  return { ok: true, checkout: toView(updated) };
}

// ──────────────────────── Применение состояния перевода ─────────────────────

/**
 * Запись состояния перевода в наш платёж.
 *
 * Переход проверяется автоматом: назад платёж не двигается. Выдача
 * подписки происходит только отсюда и только после сверки.
 */
async function applyTransfer(
  paymentId: string,
  transfer: ProviderTransfer,
  source: 'checkout' | 'webhook' | 'poll',
): Promise<Awaited<ReturnType<typeof prisma.subscriptionPayment.findUniqueOrThrow>>> {
  const current = await prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });

  const mismatch = matchTransfer(current, transfer);
  const next = mismatch ? PAYMENT_STATE.manualReview : transfer.state;

  if (!canTransition(current.state as never, next as never)) {
    // Не ошибка: повтор и переставленный порядок событий — обычное
    // дело. Просто ничего не меняем.
    return current;
  }

  const paid = grantsAccess(next as never);

  const updated = await prisma.subscriptionPayment.update({
    where: { id: paymentId },
    data: {
      state: next as PaymentState,
      providerTransferId: transfer.externalTransferId,
      ...(transfer.instructions
        ? {
            depositMessage: transfer.instructions.depositMessage,
            depositBankName: transfer.instructions.bankName,
            depositAccountNumber: transfer.instructions.accountNumber,
            depositRoutingNumber: transfer.instructions.routingNumber,
          }
        : {}),
      ...(transfer.deliveredAmount ? { deliveredAmount: new P.Decimal(transfer.deliveredAmount) } : {}),
      ...(transfer.providerFee ? { providerFee: new P.Decimal(transfer.providerFee) } : {}),
      ...(transfer.exchangeFee ? { exchangeFee: new P.Decimal(transfer.exchangeFee) } : {}),
      ...(transfer.destinationTxHash ? { destinationTxHash: transfer.destinationTxHash } : {}),
      ...(transfer.receiptUrl ? { receiptUrl: transfer.receiptUrl } : {}),
      ...(mismatch ? { reviewReason: mismatch } : {}),
      ...(paid ? { paidAt: serverNow() } : {}),
    },
  });

  if (mismatch) {
    logger.error(
      { paymentId, source, reason: mismatch, rawState: transfer.rawState },
      'платёж отправлен на разбор: данные перевода не совпали',
    );
  }

  if (paid) await grantForPayment(updated.id);

  return prisma.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });
}

/**
 * Сверка перевода с нашей записью.
 *
 * Возвращает причину расхождения или `null`, если всё сошлось.
 * Проверяется каждое поле, влияющее на деньги: заплатить сто
 * долларов и получить план за двести нельзя, как и получить доступ
 * за перевод, ушедший на чужой адрес.
 */
export function matchTransfer(
  payment: {
    providerTransferId: string | null;
    sourceCurrency: string;
    sourceAmount: P.Decimal;
    destinationCurrency: string;
    destinationChain: string;
    destinationAddress: string;
    customerId: string | null;
  },
  transfer: ProviderTransfer,
  expectedExternalCustomerId?: string | null,
): string | null {
  if (payment.providerTransferId && payment.providerTransferId !== transfer.externalTransferId) {
    return 'transfer_id_mismatch';
  }

  if ((transfer.sourceCurrency ?? '').toLowerCase() !== payment.sourceCurrency.toLowerCase()) {
    return 'source_currency_mismatch';
  }

  if (!transfer.sourceAmount || !sameMoney(transfer.sourceAmount, payment.sourceAmount.toString())) {
    return 'source_amount_mismatch';
  }

  if (
    (transfer.destinationCurrency ?? '').toLowerCase() !==
    payment.destinationCurrency.toLowerCase()
  ) {
    return 'destination_currency_mismatch';
  }

  if ((transfer.destinationRail ?? '').toLowerCase() !== payment.destinationChain.toLowerCase()) {
    return 'destination_chain_mismatch';
  }

  // Адрес Solana сравнивается побайтово: регистр там значим,
  // и приведение сделало бы адрес другим.
  if (transfer.destinationAddress !== payment.destinationAddress) {
    return 'destination_address_mismatch';
  }

  if (
    expectedExternalCustomerId &&
    transfer.externalCustomerId &&
    transfer.externalCustomerId !== expectedExternalCustomerId
  ) {
    return 'customer_mismatch';
  }

  return null;
}

// ───────────────────────────── Выдача подписки ──────────────────────────────

/** Внутренний вызов для вебхука: применить перевод к платежу. */
export async function applyTransferToPayment(
  paymentId: string,
  transfer: ProviderTransfer,
): Promise<PaymentState> {
  const updated = await applyTransfer(paymentId, transfer, 'webhook');
  return updated.state;
}

// ──────────────────────────────── Чтение ────────────────────────────────────

function toView(p: {
  id: string;
  provider: string;
  plan: PlanCode;
  state: PaymentState;
  priceAmount: P.Decimal;
  priceCurrency: string;
  termDays: number;
  sourceCurrency: string;
  sourceAmount: P.Decimal;
  destinationCurrency: string;
  destinationChain: string;
  depositMessage: string | null;
  depositBankName: string | null;
  depositAccountNumber: string | null;
  depositRoutingNumber: string | null;
  destinationTxHash: string | null;
  receiptUrl: string | null;
  deliveredAmount: P.Decimal | null;
  createdAt: Date;
  paidAt: Date | null;
}): CheckoutView {
  return {
    paymentId: p.id,
    provider: p.provider,
    plan: p.plan,
    state: p.state,
    priceAmount: p.priceAmount.toString(),
    priceCurrency: p.priceCurrency,
    termDays: p.termDays,
    sourceCurrency: p.sourceCurrency,
    sourceAmount: p.sourceAmount.toString(),
    destinationCurrency: p.destinationCurrency,
    destinationChain: p.destinationChain,
    // Банковские реквизиты отдаются только владельцу платежа
    // и только пока они нужны.
    instructions: p.depositMessage
      ? {
          depositMessage: p.depositMessage,
          bankName: p.depositBankName,
          accountNumber: p.depositAccountNumber,
          routingNumber: p.depositRoutingNumber,
        }
      : null,
    destinationTxHash: p.destinationTxHash,
    receiptUrl: p.receiptUrl,
    deliveredAmount: p.deliveredAmount?.toString() ?? null,
    createdAt: p.createdAt.toISOString(),
    paidAt: p.paidAt?.toISOString() ?? null,
  };
}

/** Свой платёж по идентификатору. Чужой не отдаётся. */
export async function paymentForUser(
  userId: string,
  paymentId: string,
): Promise<CheckoutView | null> {
  const row = await prisma.subscriptionPayment.findFirst({ where: { id: paymentId, userId } });
  return row ? toView(row) : null;
}

/** Список своих платежей. */
export async function paymentsForUser(userId: string, take = 50): Promise<CheckoutView[]> {
  const rows = await prisma.subscriptionPayment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take,
  });

  return rows.map(toView);
}
