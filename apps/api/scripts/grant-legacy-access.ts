/**
 * Переходный доступ тем, кто зарегистрировался до появления планов.
 *
 * До этого релиза радар и смарт-кошельки были открыты всем вошедшим.
 * После него они требуют плана, и без этого скрипта каждый
 * существующий пользователь в момент деплоя молча теряет то, чем
 * пользовался вчера. Молча — худшая часть: человек не видит ни причины,
 * ни срока, ни того, что делать дальше.
 *
 * Скрипт выдаёт PRO на пять суток. Именно PRO, а не пробный период:
 * пробный период не включает смарт-кошельки, и «вернули не всё»
 * выглядело бы такой же поломкой. Плюс пробный период — один раз
 * за всё время, и потратить его на переходный период значит отобрать
 * у человека возможность попробовать продукт, когда он до него дойдёт.
 *
 * Чего скрипт не делает.
 *
 * Не трогает тех, у кого уже есть действующая подписка — ни платная,
 * ни пробная. У них ничего не сломалось, и переписывать действующий
 * договор ради выдачи подарка значит потерять запись о том, за что
 * человек заплатил.
 *
 * Не расходует пробный период: запись plan=TRIAL не создаётся
 * и не изменяется.
 *
 * Не выполняется дважды. Признак — externalReference; повторный
 * прогон находит его и проходит мимо. Скрипт такого рода запускают
 * повторно всегда: первый раз оборвался, второй раз «на всякий
 * случай», третий раз через месяц по забывчивости.
 *
 * По умолчанию ничего не записывает. Запись включается флагом --apply.
 *
 * Запуск:
 *   npx tsx apps/api/scripts/grant-legacy-access.ts            # сухой прогон
 *   npx tsx apps/api/scripts/grant-legacy-access.ts --apply
 *   npx tsx apps/api/scripts/grant-legacy-access.ts --apply --days 5 --plan PRO
 */

import { PlanCode, SubscriptionSource, SubscriptionStatus } from '@prisma/client';
import { prisma } from '../src/lib/prisma.js';
import { activatePlan } from '../src/services/subscriptions.js';
import {
  decide,
  parseGrantArgs,
  GRANT_REFERENCE,
  type SkipReason,
} from '../src/services/legacy-grant.js';

/** Пачками, а не всех разом: выборка на сто тысяч строк съест память. */
const BATCH = 200;

async function reasonToSkip(userId: string): Promise<SkipReason | null> {
  // Любая действующая подписка, включая пробную: у этих людей
  // доступ не пропал, и трогать их незачем.
  const active = await prisma.subscription.findFirst({
    where: { userId, status: SubscriptionStatus.ACTIVE },
    select: { id: true },
  });

  // След прошлого прогона ищется без учёта статуса: истёкшая выдача —
  // тоже выдача, и повторять её нельзя.
  const granted = await prisma.subscription.findFirst({
    where: { userId, externalReference: GRANT_REFERENCE },
    select: { id: true },
  });

  return decide({ hasActiveSubscription: active != null, alreadyGranted: granted != null });
}

async function main(): Promise<number> {
  const opts = parseGrantArgs(process.argv.slice(2));

  const now = new Date();
  const expiresAt = new Date(now.getTime() + opts.days * 24 * 60 * 60 * 1000);

  const total = await prisma.user.count();

  console.log(opts.apply ? '=== ВЫДАЧА ===' : '=== СУХОЙ ПРОГОН (ничего не записывается) ===');
  console.log(`План:        ${opts.plan}`);
  console.log(`Срок:        ${opts.days} суток, до ${expiresAt.toISOString()}`);
  console.log(`Метка:       ${GRANT_REFERENCE}`);
  console.log(`Всего людей: ${total}`);
  console.log('');

  let seen = 0;
  let granted = 0;
  const skipped: Record<SkipReason, number> = {
    'уже есть действующая подписка': 0,
    'выдача уже была': 0,
  };

  let cursor: string | undefined;

  for (;;) {
    const users = await prisma.user.findMany({
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      select: { id: true },
    });

    if (users.length === 0) break;
    cursor = users[users.length - 1]!.id;

    for (const user of users) {
      seen++;

      const skip = await reasonToSkip(user.id);
      if (skip) {
        skipped[skip]++;
        continue;
      }

      if (opts.apply) {
        await activatePlan({
          userId: user.id,
          plan: opts.plan as Exclude<PlanCode, 'TRIAL' | 'EXPIRED'>,
          source: SubscriptionSource.MIGRATION,
          reason: 'GRANTED_BY_ADMIN',
          startsAt: now,
          expiresAt,
          externalReference: GRANT_REFERENCE,
          // Действие выполнил переход на планы, а не человек.
          actorUserId: null,
          metadata: {
            grant: GRANT_REFERENCE,
            days: opts.days,
            why: 'переход на планы: сохранить доступ тем, у кого он был',
          },
        });
      }

      granted++;
    }

    console.log(`просмотрено ${seen} из ${total}…`);
  }

  console.log('');
  console.log(`Выдано${opts.apply ? '' : ' (было бы)'}: ${granted}`);
  console.log(`Пропущено — есть подписка:  ${skipped['уже есть действующая подписка']}`);
  console.log(`Пропущено — выдача была:    ${skipped['выдача уже была']}`);

  if (!opts.apply) {
    console.log('');
    console.log('Ничего не записано. Повторите с --apply.');
  }

  return 0;
}

main()
  .then((code) => prisma.$disconnect().then(() => process.exit(code)))
  .catch(async (e) => {
    // Только сообщение: в тексте ошибки драйвера бывает строка
    // подключения, а вывод команды попадает в журналы.
    console.error('Выдача не выполнена:', e instanceof Error ? e.message : 'неизвестная ошибка');
    await prisma.$disconnect();
    process.exit(1);
  });
