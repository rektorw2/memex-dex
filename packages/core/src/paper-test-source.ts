/**
 * Управляемый источник сигналов и цен для проверки PAPER-режима.
 *
 * Зачем он нужен. PAPER-режим невозможно проверить целиком, пока
 * единственный вход — живая лента OKX: сценарий «цена не пришла до
 * дедлайна» или «токен слишком старый» приходится ждать неделями и
 * ловить случайно. Проверяемый режим требует входа, которым можно
 * управлять.
 *
 * Чем он опасен. Тот же вход, оставленный включённым в production,
 * — это способ нарисовать агенту любую картину рынка. Поэтому здесь
 * не «удобство разработчика», а контур с собственными правилами
 * допуска, и все они fail-closed: любое сомнение — запрет.
 *
 * Три границы, которые нельзя переступать:
 *
 *   1. Отдельный флаг. Не `NODE_ENV`, не «мы же на devnet», а
 *      осознанно включённая настройка, по умолчанию выключенная.
 *   2. Отдельное пространство адресов. Тестовый токен не может
 *      совпасть с настоящим, и служба физически не умеет писать
 *      в адрес, который ей не принадлежит.
 *   3. Отдельное происхождение. Тестовый сигнал не считается живым
 *      ни в одной метрике: иначе проверка чинила бы отчётность.
 */

/**
 * Происхождение тестового сигнала.
 *
 * Намеренно не входит в `PAPER_SIGNAL_ORIGINS`: `isLivePaperSignalOrigin`
 * обязан отвечать на него «нет», и это должно быть свойством типа,
 * а не отдельной проверкой, которую можно забыть.
 */
export const PAPER_TEST_ORIGIN = 'TEST_HARNESS';

/**
 * Пространство адресов тестовых токенов.
 *
 * Ни один адрес Solana так не выглядит: base58 не содержит `0`.
 * Совпадение с настоящим mint невозможно не по договорённости,
 * а по алфавиту.
 */
export const PAPER_TEST_ADDRESS_PREFIX = 'TEST0';

export function isPaperTestAddress(address: string): boolean {
  return address.startsWith(PAPER_TEST_ADDRESS_PREFIX);
}

export interface PaperTestSourceInput {
  /** Отдельная настройка контура. По умолчанию выключена. */
  testSourceEnabled: boolean;
  executionMode: string;
  liveExecutionEnabled: boolean;
  withdrawalsEnabled: boolean;
  /** Сеть Solana, как её видит конфигурация. */
  solanaNetwork: string;
  /** Роль обратившегося. */
  actorRole: string;
}

export type PaperTestSourceVerdict =
  | { allowed: true }
  | { allowed: false; reason: PaperTestSourceRefusal };

export type PaperTestSourceRefusal =
  | 'TEST_SOURCE_DISABLED'
  | 'EXECUTION_MODE_NOT_PAPER'
  | 'LIVE_EXECUTION_ENABLED'
  | 'WITHDRAWALS_ENABLED'
  | 'MAINNET_FORBIDDEN'
  | 'ADMIN_REQUIRED';

/**
 * Допуск к управляемому источнику.
 *
 * Порядок проверок значим: сначала то, что запрещает контур целиком,
 * потом роль. Человеку без прав незачем узнавать, что источник вообще
 * включён.
 *
 * `EXECUTION_MODE` проверяется отдельно от `LIVE_EXECUTION_ENABLED`,
 * потому что это разные утверждения: первое — режим работы, второе —
 * разрешение исполнять. Совпадение одного из них с `live` уже
 * достаточно, чтобы подделанный сигнал стоил денег.
 */
export function paperTestSourceVerdict(input: PaperTestSourceInput): PaperTestSourceVerdict {
  if (!input.testSourceEnabled) return { allowed: false, reason: 'TEST_SOURCE_DISABLED' };
  if (input.executionMode !== 'paper') {
    return { allowed: false, reason: 'EXECUTION_MODE_NOT_PAPER' };
  }
  if (input.liveExecutionEnabled) return { allowed: false, reason: 'LIVE_EXECUTION_ENABLED' };
  if (input.withdrawalsEnabled) return { allowed: false, reason: 'WITHDRAWALS_ENABLED' };
  if (input.solanaNetwork === 'mainnet' || input.solanaNetwork === 'mainnet-beta') {
    return { allowed: false, reason: 'MAINNET_FORBIDDEN' };
  }
  if (input.actorRole !== 'ADMIN') return { allowed: false, reason: 'ADMIN_REQUIRED' };

  return { allowed: true };
}

/**
 * Можно ли писать в этот токен из тестового источника.
 *
 * Отдельная функция, а не проверка внутри записи: правило «служба
 * не умеет трогать чужие данные» должно быть видно и проверяемо
 * само по себе. Подмена production market data — не гипотетический
 * риск: цена в `Token` общая для всего приложения, и запись в неё
 * из тестового контура изменила бы то, что видят все.
 */
export function paperTestWriteAllowed(address: string): boolean {
  return isPaperTestAddress(address);
}
