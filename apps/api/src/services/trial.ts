import { Prisma as P, PlanCode, SubscriptionSource } from '@prisma/client';
import { TRIAL_DURATION_MS, trialExpiresAt } from '@memex/core';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

/**
 * Пробный период: пять суток, один раз за всё время.
 *
 * Ключевое слово — «за всё время», а не «одновременно». Разница
 * стоит денег: ограничение «один активный пробный период» обходится
 * ожиданием пяти суток и повторной активацией, и обходится
 * бесконечно. Поэтому запись о пробном периоде не удаляется никогда,
 * а уникальность в базе построена на `userId` без всяких условий.
 *
 * Период начинается не при регистрации, а после явного нажатия.
 * Иначе человек, зарегистрировавшийся «посмотреть» и вернувшийся
 * через неделю, обнаружит, что бесплатный доступ кончился, пока он
 * им не пользовался.
 *
 * Время — только серверное, в UTC. Часы браузера сюда не попадают:
 * перевести время на своём компьютере — самый простой способ
 * получить бесплатный доступ второй раз.
 */

export interface TrialRecord {
  id: string;
  startsAt: Date;
  expiresAt: Date;
}

/**
 * Запись о пробном периоде пользователя, если она есть.
 *
 * Ищется без учёта срока: истёкший период — тоже факт, и именно он
 * запрещает начать второй.
 */
export async function trialOf(userId: string): Promise<TrialRecord | null> {
  const row = await prisma.subscription.findFirst({
    where: { userId, plan: PlanCode.TRIAL },
    orderBy: { startsAt: 'asc' },
    select: { id: true, startsAt: true, expiresAt: true },
  });

  if (!row || row.expiresAt == null) return null;

  return { id: row.id, startsAt: row.startsAt, expiresAt: row.expiresAt };
}

export type ActivateResult =
  | { ok: true; trial: TrialRecord; created: boolean }
  | { ok: false; reason: 'EMAIL_NOT_VERIFIED' | 'ALREADY_USED' };

/**
 * Включение пробного периода.
 *
 * Идемпотентно по своей сути, а не по договорённости: повторный
 * запрос находит существующую запись и возвращает её, не двигая
 * ни начала, ни конца. Продлить период повторным нажатием, выходом
 * и новым входом нельзя.
 *
 * Гонку двух одновременных запросов разбирает база: уникальность
 * по паре «пользователь и пробный план» отвергает вторую вставку,
 * и мы просто перечитываем то, что записал победитель. Проверка
 * «а нет ли уже записи» перед вставкой от гонки не спасает — между
 * проверкой и вставкой помещается второй запрос.
 */
export async function activateTrial(
  userId: string,
  now = new Date(),
): Promise<ActivateResult> {
  const existing = await trialOf(userId);
  if (existing) return { ok: true, trial: existing, created: false };

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { emailVerifiedAt: true },
  });

  // Без подтверждённой почты бесплатный период не выдаётся: иначе
  // «один раз на пользователя» превращается в «один раз на адрес,
  // который не надо подтверждать», то есть ни во что.
  if (!user?.emailVerifiedAt) return { ok: false, reason: 'EMAIL_NOT_VERIFIED' };

  const startsAt = now;
  const expiresAt = new Date(trialExpiresAt(now.getTime()));

  try {
    const created = await prisma.$transaction(async (tx) => {
      const sub = await tx.subscription.create({
        data: {
          userId,
          plan: PlanCode.TRIAL,
          startsAt,
          expiresAt,
          source: SubscriptionSource.TRIAL,
        },
      });

      await tx.entitlementAudit.create({
        data: {
          userId,
          subscriptionId: sub.id,
          previousPlan: PlanCode.EXPIRED,
          nextPlan: PlanCode.TRIAL,
          reason: 'TRIAL_ACTIVATED',
          source: SubscriptionSource.TRIAL,
          actorUserId: userId,
          occurredAt: startsAt,
        },
      });

      return sub;
    });

    logger.info({ userId, expiresAt }, 'пробный период включён');

    return {
      ok: true,
      trial: { id: created.id, startsAt: created.startsAt, expiresAt },
      created: true,
    };
  } catch (e) {
    // P2002 — нарушение уникальности: пока мы работали, пробный
    // период создал другой запрос. Это не ошибка, а нормальный исход
    // гонки; возвращаем то, что уже есть.
    if (e instanceof P.PrismaClientKnownRequestError && e.code === 'P2002') {
      const again = await trialOf(userId);
      if (again) return { ok: true, trial: again, created: false };
    }

    throw e;
  }
}

/**
 * Перевод истёкших пробных периодов в состояние «истёк».
 *
 * Ничего не решает: права заканчиваются в момент истечения, а не
 * в момент запуска этой задачи. `effectivePlan` проверяет срок сам,
 * и если бы задача не запускалась неделю, доступ всё равно
 * закончился бы вовремя. Задача нужна только чтобы состояние в базе
 * не расходилось с действительностью и чтобы в журнале осталась
 * запись о переходе.
 */
export async function expireDueTrials(now = new Date(), limit = 500): Promise<number> {
  const due = await prisma.subscription.findMany({
    where: {
      plan: PlanCode.TRIAL,
      status: 'ACTIVE',
      expiresAt: { not: null, lte: now },
    },
    take: limit,
    orderBy: { expiresAt: 'asc' },
  });

  let done = 0;

  for (const sub of due) {
    await prisma.$transaction(async (tx) => {
      const res = await tx.subscription.updateMany({
        where: { id: sub.id, status: 'ACTIVE' },
        data: { status: 'EXPIRED' },
      });

      if (res.count === 0) return;

      await tx.entitlementAudit.create({
        data: {
          userId: sub.userId,
          subscriptionId: sub.id,
          previousPlan: PlanCode.TRIAL,
          nextPlan: PlanCode.EXPIRED,
          reason: 'TRIAL_EXPIRED',
          source: SubscriptionSource.TRIAL,
          // Действие выполнило время, а не человек.
          actorUserId: null,
          occurredAt: sub.expiresAt ?? now,
        },
      });

      done++;
    });
  }

  if (done > 0) logger.info({ expired: done }, 'пробные периоды переведены в истёкшие');

  return done;
}

/** Длительность в часах — для интерфейса и для сообщений. */
export const TRIAL_HOURS = TRIAL_DURATION_MS / 3_600_000;
