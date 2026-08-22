import { PlanCode } from '@prisma/client';
import { isGrantable } from './subscriptions.js';

/**
 * Правила переходной выдачи доступа.
 *
 * Живут здесь, а не в скрипте, по одной причине: скрипт запускается
 * по боевой базе один раз и затрагивает всех разом, а всё, что
 * запускается так, должно быть проверяемо без базы. Скрипту остаётся
 * обход пользователей и вывод; решения принимаются тут.
 */

/**
 * Признак этой конкретной выдачи.
 *
 * Дата в метке нарочно: если через полгода понадобится второй
 * переходный период, у него будет своя метка и он не спутается
 * с этим. Метка без даты сделала бы повторную выдачу невозможной
 * навсегда — скрипт нашёл бы старый след и прошёл мимо.
 */
export const GRANT_REFERENCE = 'legacy-access-2026-08';

export const DEFAULT_GRANT_DAYS = 5;
export const DEFAULT_GRANT_PLAN = PlanCode.PRO;

export interface GrantOptions {
  apply: boolean;
  days: number;
  plan: PlanCode;
}

export type SkipReason = 'уже есть действующая подписка' | 'выдача уже была';

/**
 * Решение по одному человеку.
 *
 * Ошибка здесь — это не сообщение об ошибке, а тихо переписанные
 * чужие подписки, и заметить её можно будет только по жалобам.
 */
export function decide(facts: {
  hasActiveSubscription: boolean;
  alreadyGranted: boolean;
}): SkipReason | null {
  // Порядок важен. У человека с действующей подпиской ничего
  // не сломалось, и это более веская причина не трогать его,
  // чем след прошлой выдачи. Подписка при этом может быть
  // оплаченной: переписать её подарком значит закрыть строку,
  // по которой человек платил.
  if (facts.hasActiveSubscription) return 'уже есть действующая подписка';

  // Истёкшая выдача — тоже выдача. Иначе скрипт раздавал бы
  // по пять суток при каждом запуске, а запускают такое всегда
  // повторно: первый раз оборвался, второй на всякий случай.
  if (facts.alreadyGranted) return 'выдача уже была';

  return null;
}

/**
 * Разбор аргументов командной строки.
 *
 * Умолчание — не записывать. Скрипт, который пишет в боевую базу
 * без явного флага, однажды запустят «просто посмотреть».
 */
export function parseGrantArgs(argv: string[]): GrantOptions {
  const apply = argv.includes('--apply');

  const daysArg = argv[argv.indexOf('--days') + 1];
  const days = argv.includes('--days') ? Number(daysArg) : DEFAULT_GRANT_DAYS;

  const planArg = argv[argv.indexOf('--plan') + 1];
  const plan = (argv.includes('--plan') ? planArg : DEFAULT_GRANT_PLAN) as PlanCode;

  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new Error(`--days должен быть числом от 1 до 365, получено: ${daysArg ?? '(пусто)'}`);
  }

  // Проверка до первой записи, а не внутри activatePlan: узнать
  // об опечатке в названии плана после сотой выданной подписки
  // дороже, чем до первой.
  if (!isGrantable(plan)) {
    throw new Error(
      `--plan должен быть PRO, SEMI_AUTO или FULL_AUTO, получено: ${plan}. ` +
        'TRIAL так не выдаётся: у него своя проверка почты и своё правило «один раз ' +
        'за всё время», и оба были бы обойдены разом.',
    );
  }

  return { apply, days, plan };
}
