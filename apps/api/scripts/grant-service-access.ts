/**
 * Служебный доступ администратору.
 *
 * Роль сама по себе прав не даёт и давать не должна. Разница
 * не формальная: право по роли не имеет ни срока, ни автора,
 * ни следа в журнале, и на вопрос «почему у этого аккаунта была
 * автоторговля в среду» ответить нечем. Кроме того, роль обычно
 * выдают за обязанности по поддержке, а получают вместе с ней
 * возможность распоряжаться деньгами.
 *
 * Поэтому служебный доступ здесь — обычная подписка с источником
 * ADMIN_GRANT: у неё есть срок, есть запись в журнале прав, её видно
 * в истории наравне с оплаченными и её можно отозвать. Никакого
 * отдельного пути в проверке доступа не появляется, а значит,
 * и обходить в ней нечего.
 *
 * Срок обязателен по умолчанию. Бессрочный служебный доступ выдаётся
 * только явным --forever: доступ, который никто не помнит, никто
 * и не отзывает.
 *
 * Запуск:
 *   npx tsx apps/api/scripts/grant-service-access.ts --email me@example.com
 *   npx tsx apps/api/scripts/grant-service-access.ts --email me@example.com --apply
 *   npx tsx apps/api/scripts/grant-service-access.ts --email me@example.com --apply --days 90
 *   npx tsx apps/api/scripts/grant-service-access.ts --email me@example.com --apply --revoke
 */

import { PlanCode, SubscriptionSource, SubscriptionStatus, UserRole } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { activatePlan, cancelPlan, isGrantable } from '../src/services/subscriptions.js';

const GRANT_REFERENCE = 'service-access';
const DEFAULT_DAYS = 30;
const DEFAULT_PLAN = PlanCode.FULL_AUTO;

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);

  const apply = argv.includes('--apply');
  const revoke = argv.includes('--revoke');
  const forever = argv.includes('--forever');

  const email = arg(argv, 'email')?.trim().toLowerCase();
  if (!email) {
    console.error('Нужен --email того, кому выдаётся доступ.');
    return 2;
  }

  const daysRaw = arg(argv, 'days');
  const days = daysRaw ? Number(daysRaw) : DEFAULT_DAYS;

  if (!forever && (!Number.isFinite(days) || days <= 0 || days > 3650)) {
    console.error(`--days должен быть числом от 1 до 3650, получено: ${daysRaw}`);
    return 2;
  }

  const plan = (arg(argv, 'plan') ?? DEFAULT_PLAN) as PlanCode;
  if (!isGrantable(plan)) {
    console.error(`--plan должен быть PRO, SEMI_AUTO или FULL_AUTO, получено: ${plan}`);
    return 2;
  }

  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, role: true },
  });

  if (!user) {
    // Адрес не печатается: команду запускают в общей консоли,
    // а вывод оседает в истории оболочки.
    console.error('Пользователь с таким адресом не найден.');
    return 4;
  }

  // Роль здесь — не источник прав, а условие выдачи. Служебный доступ
  // выдаётся тому, у кого есть служебные обязанности; сами права
  // приходят подпиской, а не должностью.
  if (user.role !== UserRole.ADMIN) {
    console.error('Служебный доступ выдаётся только аккаунту с ролью ADMIN.');
    return 5;
  }

  const now = new Date();

  if (revoke) {
    const current = await prisma.subscription.findFirst({
      where: {
        userId: user.id,
        status: SubscriptionStatus.ACTIVE,
        externalReference: GRANT_REFERENCE,
      },
      select: { id: true, plan: true, expiresAt: true },
    });

    if (!current) {
      console.log('Действующего служебного доступа нет — отзывать нечего.');
      return 0;
    }

    console.log(`Будет отозван: ${current.plan}, до ${current.expiresAt?.toISOString() ?? 'бессрочно'}`);

    if (!apply) {
      console.log('Сухой прогон. Повторите с --apply.');
      return 0;
    }

    await cancelPlan({
      userId: user.id,
      reason: 'GRANT_REVOKED',
      actorUserId: user.id,
      at: now,
      metadata: { grant: GRANT_REFERENCE },
    });

    console.log('Служебный доступ отозван.');
    return 0;
  }

  const existing = await prisma.subscription.findFirst({
    where: { userId: user.id, status: SubscriptionStatus.ACTIVE },
    select: { plan: true, source: true, expiresAt: true, externalReference: true },
  });

  // Оплаченную подписку служебной выдачей не перезаписываем: она
  // закрыла бы строку, по которой человек платил, и в истории
  // осталась бы дыра.
  if (existing && existing.source === SubscriptionSource.PAYMENT) {
    console.error(
      `У аккаунта действует оплаченный план ${existing.plan}. ` +
        'Служебный доступ поверх оплаченного не выдаётся — сначала разберитесь с оплатой.',
    );
    return 6;
  }

  const expiresAt = forever ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

  console.log('=== Служебный доступ ===');
  console.log(`План:  ${plan}`);
  console.log(`Срок:  ${expiresAt ? `${days} суток, до ${expiresAt.toISOString()}` : 'бессрочно'}`);
  if (existing) console.log(`Заменит действующий: ${existing.plan} (${existing.source})`);

  if (!forever && plan === PlanCode.FULL_AUTO) {
    console.log('');
    console.log('Внимание: FULL_AUTO включает автоматическую торговлю.');
    console.log('Если доступ нужен только чтобы видеть экраны, возьмите --plan PRO.');
  }

  if (!apply) {
    console.log('');
    console.log('Сухой прогон, ничего не записано. Повторите с --apply.');
    return 0;
  }

  await activatePlan({
    userId: user.id,
    plan: plan as Exclude<PlanCode, 'TRIAL' | 'EXPIRED'>,
    source: SubscriptionSource.ADMIN_GRANT,
    reason: 'GRANTED_BY_ADMIN',
    startsAt: now,
    expiresAt,
    externalReference: GRANT_REFERENCE,
    // Кто выдал — записывается. Служебный доступ без автора
    // ничем не отличается от чужого доступа.
    actorUserId: user.id,
    metadata: { grant: GRANT_REFERENCE, forever, days: forever ? null : days },
  });

  console.log('');
  console.log('Выдано. Запись есть в журнале прав и видна в истории планов.');

  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (e) => {
    console.error('Выдача не выполнена:', e instanceof Error ? e.message : 'неизвестная ошибка');
    await prisma.$disconnect();
    process.exit(1);
  });
