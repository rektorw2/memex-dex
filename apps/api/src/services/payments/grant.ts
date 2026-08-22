import { PlanCode, PaymentState, SubscriptionStatus, SubscriptionSource } from '@prisma/client';
import { renewalPeriodEnd } from '@memex/core';
import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { serverNow } from '../../lib/clock.js';

/**
 * Выдача подписки по оплаченному платежу.
 *
 * Один сервис на всех провайдеров. Bridge и Coinbase приходят сюда
 * разными путями, но решение о доступе принимается в одном месте:
 * два экземпляра этих правил разъехались бы при первой же правке,
 * и разъехались бы молча — один провайдер начал бы давать тридцать
 * суток, другой тридцать один.
 *
 * Здесь же живёт идемпотентность выдачи. Связь платежа с подпиской
 * стоит под уникальным ограничением, и повторное событие находит
 * её заполненной.
 */

/**
 * Выдача подписки по оплаченному платежу.
 *
 * Идемпотентна по построению: платёж связывается с подпиской полем
 * `grantedSubscriptionId` под уникальным ограничением. Повторное
 * событие находит связь заполненной и не добавляет тридцать суток
 * второй раз.
 *
 * Продление того же плана прибавляет срок к концу действующего
 * периода, а не к «сейчас»: оплаченное время не сгорает.
 */
export async function grantForPayment(paymentId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.subscriptionPayment.findUniqueOrThrow({ where: { id: paymentId } });

    if (payment.grantedSubscriptionId) return;
    if (payment.state !== PaymentState.PAID) return;

    const now = serverNow();

    const active = await tx.subscription.findFirst({
      where: {
        userId: payment.userId,
        status: SubscriptionStatus.ACTIVE,
        plan: { not: PlanCode.TRIAL },
      },
      orderBy: { startsAt: 'desc' },
    });

    // Гонка: пока платёж шёл, у человека появился другой платный
    // план. Деньги не теряем, доступ не подменяем — на разбор.
    if (active && active.plan !== payment.plan) {
      await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: {
          state: PaymentState.MANUAL_REVIEW_REQUIRED,
          reviewReason: 'active_plan_conflict',
        },
      });
      return;
    }

    const startsAt = now;
    const expiresAt = new Date(
      renewalPeriodEnd(now.getTime(), active?.expiresAt?.getTime() ?? null, payment.termDays),
    );

    let subscriptionId: string;

    if (active) {
      // Продление: срок действующего договора двигается вперёд.
      await tx.subscription.update({
        where: { id: active.id },
        data: { expiresAt },
      });
      subscriptionId = active.id;
    } else {
      const created = await tx.subscription.create({
        data: {
          userId: payment.userId,
          plan: payment.plan,
          status: SubscriptionStatus.ACTIVE,
          startsAt,
          expiresAt,
          source: SubscriptionSource.PAYMENT,
          externalReference: payment.providerTransferId,
        },
      });
      subscriptionId = created.id;
    }

    await tx.entitlementAudit.create({
      data: {
        userId: payment.userId,
        subscriptionId,
        previousPlan: active ? active.plan : PlanCode.EXPIRED,
        nextPlan: payment.plan,
        reason: active ? 'SUBSCRIPTION_RENEWED' : 'PAYMENT_RECEIVED',
        source: SubscriptionSource.PAYMENT,
        actorUserId: null,
        occurredAt: startsAt,
        metadata: {
          paymentId: payment.id,
          termDays: payment.termDays,
          expiresAt: expiresAt.toISOString(),
        },
      },
    });

    // Связь ставится последней и под уникальным ограничением.
    // Второе событие с тем же платежом сюда уже не дойдёт.
    await tx.subscriptionPayment.update({
      where: { id: paymentId },
      data: { grantedSubscriptionId: subscriptionId },
    });

    logger.info(
      { userId: payment.userId, plan: payment.plan, termDays: payment.termDays },
      'подписка выдана по подтверждённой оплате',
    );
  });
}
