import { VERIFY_RESULT, type VerifyResult } from '@memex/core';
import { logger } from '../lib/logger.js';
import { serverNow } from '../lib/clock.js';
import { verifyCode } from './email-verify.js';
import { activateTrial, type TrialRecord } from './trial.js';

/**
 * Подтверждение почты и бесплатный период — одним действием.
 *
 * Раньше это были два шага: человек подтверждал адрес, а потом
 * отдельно нажимал «включить пробный период». Второе нажатие не несло
 * никакого решения — отказаться от бесплатного доступа никто не
 * хотел, — но исправно теряло часть людей между экранами.
 *
 * Здесь важен один момент: период выдаётся только в момент **перехода**
 * «не подтверждён → подтверждён». Не при каждом успешном ответе, не
 * при заходе на страницу и не при выкладке новой версии.
 *
 * Разница существенная. Если бы период выдавался всем подтверждённым,
 * то в день выкладки его получили бы все существующие пользователи —
 * включая тех, кто уже израсходовал свой, и тех, кто платит. Поэтому
 * `alreadyVerified` сюда не подходит и намеренно ничего не выдаёт.
 *
 * Транзакции у двух шагов разные, и это осознанный выбор. Провал
 * выдачи периода не отменяет подтверждения: код человек ввёл верно, и
 * аннулировать его — самое враждебное из возможных решений. Вместо
 * этого возвращается честное `TRIAL_PENDING`, а повторить попытку
 * можно тем же идемпотентным вызовом. Ложного состояния «подтверждено
 * и период якобы активен» не возникает: состояние доступа всегда
 * пересчитывается по базе.
 */

export type TrialOutcome =
  /** Период создан прямо сейчас. */
  | 'STARTED'
  /** Период уже был: повторное подтверждение его не продлевает. */
  | 'ALREADY_USED'
  /** Переход не состоялся — выдавать нечего. */
  | 'NOT_APPLICABLE'
  /** Подтверждение прошло, выдача не удалась. Можно повторить. */
  | 'PENDING';

export interface VerifyAndTrialResult {
  result: VerifyResult;
  verifiedAt: Date | null;
  trialOutcome: TrialOutcome;
  trial: TrialRecord | null;
}

export async function verifyEmailAndStartTrial(
  userId: string,
  code: string,
  now = serverNow(),
): Promise<VerifyAndTrialResult> {
  const { result, verifiedAt } = await verifyCode(userId, code, now);

  if (result !== VERIFY_RESULT.ok) {
    /*
     * Сюда попадает и `alreadyVerified`.
     *
     * Подтверждение уже было — значит, не сейчас. Второй раз период
     * не выдаётся, и повторный ввод кода его не продлевает.
     */
    return {
      result,
      verifiedAt: verifiedAt ?? null,
      trialOutcome: 'NOT_APPLICABLE',
      trial: null,
    };
  }

  try {
    const activation = await activateTrial(userId, now);

    if (!activation.ok) {
      /*
       * `EMAIL_NOT_VERIFIED` здесь невозможен: подтверждение только
       * что записано этой же операцией. Остаётся `ALREADY_USED` —
       * период у аккаунта уже был, например до повторной регистрации
       * тем же адресом.
       */
      return {
        result,
        verifiedAt: verifiedAt ?? now,
        trialOutcome: 'ALREADY_USED',
        trial: null,
      };
    }

    return {
      result,
      verifiedAt: verifiedAt ?? now,
      // `created: false` означает, что запись нашлась готовой:
      // либо гонка, либо период был выдан раньше.
      trialOutcome: activation.created ? 'STARTED' : 'ALREADY_USED',
      trial: activation.trial,
    };
  } catch (error: unknown) {
    /*
     * Подтверждение остаётся в силе.
     *
     * Откатывать его значило бы наказать человека за сбой на нашей
     * стороне: код он ввёл верный, а повторно тот же код уже не
     * примут. Состояние честное — «подтверждено, период не выдан», —
     * и восстанавливается повторным вызовом активации.
     */
    logger.error(
      { userId, err: error instanceof Error ? error.message : 'unknown' },
      'подтверждение прошло, выдача пробного периода не удалась',
    );

    return {
      result,
      verifiedAt: verifiedAt ?? now,
      trialOutcome: 'PENDING',
      trial: null,
    };
  }
}
