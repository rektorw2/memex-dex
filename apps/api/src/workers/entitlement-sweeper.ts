import { logger } from '../lib/logger.js';
import { serverNow } from '../lib/clock.js';
import { expireDueTrials } from '../services/trial.js';
import { expireDuePlans } from '../services/subscriptions.js';

/**
 * Уборка истёкших договоров.
 *
 * Задача ничего не решает и решать не должна. Права заканчиваются
 * в момент истечения, а не в момент её запуска: `activeSubscription`
 * и `isTrialActive` проверяют срок сами, и если бы уборка
 * не запускалась неделю, доступ всё равно закончился бы вовремя.
 *
 * Тогда зачем она. За двумя вещами.
 *
 * Первая — журнал. Переход «оплачено → истекло» должен быть записан,
 * иначе на вопрос «когда я потерял доступ» ответить нечем: строка
 * в базе выглядит действующей, а вела себя как истёкшая.
 *
 * Вторая — состояние базы не должно расходиться с действительностью.
 * Строка со статусом ACTIVE и прошедшим сроком — ложь, которую рано
 * или поздно прочитает отчёт, выгрузка или новый код, забывший
 * проверить срок.
 *
 * Час выбран потому, что точность здесь не важна: ни одно решение
 * о доступе от неё не зависит.
 */

const TICK_MS = 60 * 60 * 1000;

let running = false;
let timer: NodeJS.Timeout | null = null;

export async function sweepOnce(now = serverNow()): Promise<{ trials: number; plans: number }> {
  const trials = await expireDueTrials(now).catch((e) => {
    logger.error({ err: e?.message }, 'уборка пробных периодов не удалась');
    return 0;
  });

  const plans = await expireDuePlans(now).catch((e) => {
    logger.error({ err: e?.message }, 'уборка подписок не удалась');
    return 0;
  });

  return { trials, plans };
}

export function startEntitlementSweeper(): void {
  if (running) return;
  running = true;

  const loop = async () => {
    while (running) {
      await sweepOnce();
      await new Promise((r) => {
        timer = setTimeout(r, TICK_MS);
      });
    }
  };

  void loop();
  logger.info('уборка истёкших договоров запущена');
}

export function stopEntitlementSweeper(): void {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
