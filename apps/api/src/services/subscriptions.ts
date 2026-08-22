import { Prisma as P, PlanCode, SubscriptionStatus, SubscriptionSource } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Переходы между планами.
 *
 * Модуль отвечает на один вопрос: как меняется договор и что при этом
 * остаётся записанным. Прав он не выдаёт — этим занимается
 * entitlement.ts, и разделение здесь не косметическое. Здесь пишут,
 * там читают; смешать значило бы получить место, где проверка доступа
 * может незаметно изменить подписку.
 *
 * Три правила, из которых следует всё остальное.
 *
 * Изменение договора и запись в журнал происходят одной транзакцией.
 * Порознь они дают подписку, которую никто не может объяснить: план
 * поменялся, а кто и почему — неизвестно. Именно этот вопрос задают
 * при споре о списании, и «не знаю» на него не годится.
 *
 * Действующий договор ровно один, и следит за этим база. Частичный
 * уникальный индекс `Subscription_one_active_per_user` отвергает
 * вторую активную строку независимо от того, сколько проверок было
 * в коде и в каком порядке пришли два одновременных платежа.
 *
 * Прошлое не переписывается. Понижение не правит строку с прежним
 * планом, а закрывает её и открывает новую. История планов — то,
 * чем отвечают на претензию, и редактируемая история ничего
 * не доказывает.
 */

/** Причина перехода. Строка, а не перечисление: причин больше, чем типов. */
export type TransitionReason =
  | 'PAYMENT_RECEIVED'
  | 'PLAN_UPGRADED'
  | 'PLAN_DOWNGRADED'
  | 'CANCELLED_BY_USER'
  | 'CANCELLED_BY_PROVIDER'
  | 'EXPIRED'
  | 'GRANTED_BY_ADMIN'
  | 'GRANT_REVOKED';

/**
 * Планы, которые можно выдать оплатой или вручную.
 *
 * `TRIAL` сюда не входит: пробный период выдаётся только через
 * trial.ts, где стоит проверка подтверждённой почты и где база
 * следит за правилом «один раз за всё время». Выдай его отсюда —
 * и оба ограничения обойдены разом.
 *
 * `EXPIRED` тоже не входит. Это не план, а его отсутствие; создавать
 * договор на отсутствие прав незачем, а строка со статусом ACTIVE
 * и планом EXPIRED заняла бы место действующего договора.
 */
export type GrantablePlan = Exclude<PlanCode, 'TRIAL' | 'EXPIRED'>;

const GRANTABLE: readonly PlanCode[] = [PlanCode.PRO, PlanCode.SEMI_AUTO, PlanCode.FULL_AUTO];

export function isGrantable(plan: PlanCode): plan is GrantablePlan {
  return GRANTABLE.includes(plan);
}

export interface ActivateInput {
  userId: string;
  plan: GrantablePlan;
  source: SubscriptionSource;
  reason: TransitionReason;
  /** Когда права заканчиваются. null — бессрочно. */
  expiresAt?: Date | null;
  /** Номер операции у платёжного провайдера. */
  externalReference?: string | null;
  /** Кто выдал, если выдали вручную. */
  actorUserId?: string | null;
  startsAt?: Date;
  metadata?: P.InputJsonValue;
}

/**
 * Порядок планов.
 *
 * Нужен, чтобы отличить повышение от понижения — и только для этого.
 * Правами он не распоряжается: их выдаёт entitlements.ts по коду
 * плана, а не по месту в списке.
 */
const PLAN_RANK: Record<PlanCode, number> = {
  EXPIRED: 0,
  TRIAL: 1,
  PRO: 2,
  SEMI_AUTO: 3,
  FULL_AUTO: 4,
};

/** Повышение это или понижение. */
export function transitionKind(from: PlanCode, to: PlanCode): 'upgrade' | 'downgrade' | 'same' {
  const a = PLAN_RANK[from];
  const b = PLAN_RANK[to];

  if (b > a) return 'upgrade';
  if (b < a) return 'downgrade';
  return 'same';
}

/**
 * Действующий договор пользователя.
 *
 * Только чтение и только по идентификатору пользователя с сервера.
 * Истечение проверяется здесь же: строка со статусом ACTIVE
 * и прошедшим сроком — не действующий договор, а недоубранный.
 * Фоновая задача рано или поздно переведёт её в EXPIRED, но
 * дожидаться этого нельзя: между истечением и уборкой проходят
 * минуты, и всё это время человек пользовался бы неоплаченным.
 */
export async function activeSubscription(
  userId: string,
  now = new Date(),
): Promise<{ plan: PlanCode; expiresAt: Date | null; startsAt: Date; id: string } | null> {
  const row = await prisma.subscription.findFirst({
    where: {
      userId,
      status: SubscriptionStatus.ACTIVE,
      // Пробный период сюда не попадает намеренно: им занимается
      // trial.ts, и смешивать оплаченный договор с бесплатным
      // значит однажды продлить один вместо другого.
      plan: { not: PlanCode.TRIAL },
      startsAt: { lte: now },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    orderBy: { startsAt: 'desc' },
    select: { id: true, plan: true, expiresAt: true, startsAt: true },
  });

  return row;
}

/**
 * Включение плана.
 *
 * Закрывает прежний договор и открывает новый в одной транзакции
 * вместе с записью в журнал. Если что-то из этого не удалось,
 * не происходит ничего: половина перехода хуже, чем его отсутствие,
 * потому что чинить приходится вслепую.
 */
export async function activatePlan(input: ActivateInput): Promise<{ subscriptionId: string }> {
  // Проверка во время выполнения, а не только в типах: план приходит
  // из вебхука платёжной системы, то есть из строки, и типы там
  // ничего не гарантируют.
  if (!isGrantable(input.plan)) {
    throw new Error(
      `activatePlan: план ${input.plan} так не выдаётся. ` +
        'Пробный период — только через activateTrial, EXPIRED — это отсутствие договора.',
    );
  }

  const startsAt = input.startsAt ?? new Date();

  return prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { userId: input.userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { startsAt: 'desc' },
    });

    const previousPlan = current?.plan ?? PlanCode.EXPIRED;

    // Прежний договор закрывается, а не переписывается. Строка
    // с прежним планом остаётся такой, какой была: это единственный
    // след того, что человек покупал и на каких условиях.
    if (current) {
      await tx.subscription.update({
        where: { id: current.id },
        data: {
          // И повышение, и понижение закрывают прежний договор
          // одинаково. Различать их статусом было бы соблазнительно,
          // но статус отвечает на вопрос «действует ли», а не
          // «почему закончился». Второй ответ лежит в журнале,
          // где ему и место: причин больше трёх, и множить ради них
          // значения перечисления пришлось бы бесконечно.
          status: SubscriptionStatus.CANCELLED,
          cancelledAt: startsAt,
        },
      });
    }

    const created = await tx.subscription.create({
      data: {
        userId: input.userId,
        plan: input.plan,
        status: SubscriptionStatus.ACTIVE,
        startsAt,
        expiresAt: input.expiresAt ?? null,
        source: input.source,
        externalReference: input.externalReference ?? null,
        createdByUserId: input.actorUserId ?? null,
      },
    });

    await tx.entitlementAudit.create({
      data: {
        userId: input.userId,
        subscriptionId: created.id,
        previousPlan,
        nextPlan: input.plan,
        reason: input.reason,
        source: input.source,
        actorUserId: input.actorUserId ?? null,
        metadata: input.metadata ?? P.DbNull,
        occurredAt: startsAt,
      },
    });

    return { subscriptionId: created.id };
  });
}

/**
 * Отмена договора.
 *
 * Права заканчиваются немедленно. Состояния «отменена, но ещё
 * действует до конца оплаченного периода» здесь нет намеренно:
 * оно превратилось бы в лазейку, а срок, за который заплачено,
 * возвращается деньгами, а не доступом.
 */
export async function cancelPlan(input: {
  userId: string;
  reason: Extract<TransitionReason, 'CANCELLED_BY_USER' | 'CANCELLED_BY_PROVIDER' | 'GRANT_REVOKED'>;
  actorUserId?: string | null;
  at?: Date;
  metadata?: P.InputJsonValue;
}): Promise<{ cancelled: boolean }> {
  const at = input.at ?? new Date();

  return prisma.$transaction(async (tx) => {
    const current = await tx.subscription.findFirst({
      where: { userId: input.userId, status: SubscriptionStatus.ACTIVE },
      orderBy: { startsAt: 'desc' },
    });

    if (!current) return { cancelled: false };

    await tx.subscription.update({
      where: { id: current.id },
      data: { status: SubscriptionStatus.CANCELLED, cancelledAt: at },
    });

    await tx.entitlementAudit.create({
      data: {
        userId: input.userId,
        subscriptionId: current.id,
        previousPlan: current.plan,
        nextPlan: PlanCode.EXPIRED,
        reason: input.reason,
        source: current.source,
        actorUserId: input.actorUserId ?? null,
        metadata: input.metadata ?? P.DbNull,
        occurredAt: at,
      },
    });

    return { cancelled: true };
  });
}

/**
 * Уборка истёкших договоров.
 *
 * Ничего не решает — только приводит записи в соответствие с тем,
 * что уже произошло. Права истёкшей подписки заканчиваются
 * в момент истечения, а не в момент запуска этой задачи:
 * `activeSubscription` проверяет срок сама, и если бы задача
 * не запускалась неделю, доступ всё равно бы закончился вовремя.
 *
 * Каждая запись переводится отдельной транзакцией вместе со своей
 * строкой журнала. Одна общая транзакция на тысячу подписок держала
 * бы блокировку слишком долго.
 */
export async function expireDuePlans(now = new Date(), limit = 500): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: {
      status: SubscriptionStatus.ACTIVE,
      expiresAt: { not: null, lte: now },
    },
    take: limit,
    orderBy: { expiresAt: 'asc' },
  });

  let done = 0;

  for (const sub of due) {
    await prisma.$transaction(async (tx) => {
      // Условие в updateMany повторяет статус намеренно: между
      // выборкой и записью подписку могли отменить вручную,
      // и переписывать чужое решение мы не должны.
      const res = await tx.subscription.updateMany({
        where: { id: sub.id, status: SubscriptionStatus.ACTIVE },
        data: { status: SubscriptionStatus.EXPIRED },
      });

      if (res.count === 0) return;

      await tx.entitlementAudit.create({
        data: {
          userId: sub.userId,
          subscriptionId: sub.id,
          previousPlan: sub.plan,
          nextPlan: PlanCode.EXPIRED,
          reason: 'EXPIRED',
          source: sub.source,
          // Действие выполнило время, а не человек.
          actorUserId: null,
          occurredAt: sub.expiresAt ?? now,
        },
      });

      done++;
    });
  }

  if (done > 0) logger.info({ expired: done }, 'подписки переведены в истёкшие');

  return done;
}

/** История планов пользователя. Для разбирательств и для него самого. */
export async function planHistory(userId: string, take = 50) {
  return prisma.entitlementAudit.findMany({
    where: { userId },
    orderBy: { occurredAt: 'desc' },
    take,
    select: {
      previousPlan: true,
      nextPlan: true,
      reason: true,
      source: true,
      occurredAt: true,
    },
  });
}
