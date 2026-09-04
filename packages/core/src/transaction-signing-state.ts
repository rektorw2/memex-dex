import { verdictPausesSigning, type IdentityVerdict } from './signing-identity.js';

/**
 * Состояние контура подписи транзакций. Одна функция на весь проект.
 *
 * До неё готовность вычислялась в шести местах: startup guards,
 * фабрика подписанта, воркер, API, `/agent` и админская диагностика.
 * Каждое место читало свой набор переменных, и наборы разошлись —
 * интерфейс говорил «подпись выключена», опираясь на один флаг, а
 * воркер решал запускаться по другому. Такое расхождение не ошибка
 * отображения: оно означает, что человек видит одно состояние
 * системы, а система находится в другом.
 *
 * Три понятия здесь намеренно разделены и не смешиваются:
 *
 * **Custody encryption** — чем зашифрован сохранённый key material.
 * Отвечает за то, что даст дамп базы. К подписи отношения не имеет.
 *
 * **Transaction signer** — облачный ключ Ed25519, которым
 * подписываются транзакции Solana. Приватного ключа у нас нет.
 *
 * **Broadcast** — отправка подписанного в сеть. Отдельный контур,
 * которого сейчас не существует.
 *
 * Общее слово «KMS» в названиях переменных склеивало первое и
 * второе. Слово — не причина считать понятия одним.
 */

/**
 * Состояния от «выключено» до «подпись проверена».
 *
 * Порядок в объединении — это порядок проверок: чем раньше, тем
 * грубее препятствие.
 */
export type TransactionSigningState =
  /** Канонический флаг выключен. Единственное штатное состояние сегодня. */
  | 'DISABLED'
  /** Флаг включён, но провайдера или ключа нет. */
  | 'NOT_CONFIGURED'
  /** Ключ отвечает, но человек его не подтвердил. */
  | 'IDENTITY_UNVERIFIED'
  /** Сеть не devnet либо узел не проверен. */
  | 'NETWORK_UNVERIFIED'
  /** Расхождение ключа или поднятая защёлка. Снимает человек. */
  | 'PAUSED'
  /** Неоднозначный ответ провайдера или иная запись на разбор. */
  | 'REVIEW_REQUIRED'
  /** Все условия выполнены, живой подписи ещё не было. */
  | 'READY_TO_SIGN_DEVNET'
  /** Подпись получена и проверена локально. Отправки по-прежнему нет. */
  | 'SIGNATURE_VALIDATED';

export interface TransactionSigningInput {
  /**
   * Канонический переключатель, и только он.
   *
   * Устаревший флаг сюда не попадает даже как «или»: сложение двух
   * источников истины даёт третий, которого нет ни в одном из них.
   */
  signingEnabled: boolean;
  /** `unavailable` означает «провайдер не выбран». */
  signerProvider: string;
  providerSupported: boolean;
  keyConfigured: boolean;
  /** Вердикт сверки живого ключа с зарегистрированным. */
  identity: IdentityVerdict;
  /** Задан ли независимый ожидаемый ключ и совпал ли он. */
  expectedKeyMatches: boolean | null;
  network: string;
  /** Проверен ли узел: genesis сверен, blockhash берётся. */
  networkVerified: boolean;
  /** Была ли настоящая подпись, проверенная локально. */
  signatureValidated: boolean;
  safetyLatchHealthy: boolean;
  /** Есть ли попытка с неизвестным исходом. */
  hasAmbiguousAttempt: boolean;
  withdrawalsEnabled: boolean;
  broadcastAvailable: boolean;
}

/**
 * Единственный расчёт состояния подписи.
 *
 * Порядок проверок и есть защита. «Выключено» отвечается первым:
 * при выключенном контуре остальные вопросы не просто неважны — на
 * них нельзя отвечать, потому что ответ потребовал бы обращения к
 * провайдеру, а обращаться запрещено.
 */
export function transactionSigningState(
  input: TransactionSigningInput,
): TransactionSigningState {
  if (!input.signingEnabled) return 'DISABLED';

  /*
   * Выводы и отправка закрывают подпись раньше готовности.
   *
   * Включённые выводы вместе с подписью — это полный путь денег
   * наружу, собранный из двух отдельно безобидных настроек.
   * Доступный broadcast означает, что подписанное уйдёт в сеть, а
   * этот контур не проверен.
   */
  if (input.withdrawalsEnabled || input.broadcastAvailable) return 'REVIEW_REQUIRED';

  if (
    !input.providerSupported ||
    input.signerProvider === 'unavailable' ||
    !input.keyConfigured
  ) {
    return 'NOT_CONFIGURED';
  }

  // Неизвестный исход важнее любой готовности: возможно, подпись уже
  // существует, и вторая попытка создала бы вторую.
  if (input.hasAmbiguousAttempt) return 'REVIEW_REQUIRED';

  if (!input.safetyLatchHealthy) return 'PAUSED';
  if (input.identity === 'NOT_REGISTERED') return 'IDENTITY_UNVERIFIED';
  if (verdictPausesSigning(input.identity)) return 'PAUSED';
  /*
   * Ожидаемый ключ — независимый свидетель.
   *
   * Он задаётся человеком отдельно от базы. Если и база, и ответ
   * провайдера изменились согласованно, несовпадение с ним —
   * единственное, что заметит подмену. `null` означает «не задан»:
   * это не совпадение и не расхождение.
   */
  if (input.expectedKeyMatches === false) return 'PAUSED';

  if (input.network !== 'devnet' || !input.networkVerified) return 'NETWORK_UNVERIFIED';

  return input.signatureValidated ? 'SIGNATURE_VALIDATED' : 'READY_TO_SIGN_DEVNET';
}

/**
 * Разрешён ли настоящий вызов `Sign`.
 *
 * Отдельная функция, а не сравнение состояния по месту вызова:
 * список «готовых» состояний, написанный в каждом вызывающем,
 * однажды разойдётся, и разойдётся он в сторону разрешения.
 */
export function allowsKmsCall(state: TransactionSigningState): boolean {
  return state === 'READY_TO_SIGN_DEVNET' || state === 'SIGNATURE_VALIDATED';
}

/**
 * Почему подпись недоступна. Для диагностики, не для решения.
 *
 * Возвращается список, а не первая причина: оператор, чинящий их по
 * одной, узнаёт о следующей только после перезапуска.
 */
export function signingBlockers(input: TransactionSigningInput): string[] {
  const blockers: string[] = [];

  if (!input.signingEnabled) blockers.push('SIGNING_DISABLED');
  if (input.signerProvider === 'unavailable') blockers.push('PROVIDER_NOT_SELECTED');
  if (!input.providerSupported) blockers.push('PROVIDER_NOT_SUPPORTED');
  if (!input.keyConfigured) blockers.push('KEY_NOT_CONFIGURED');
  if (input.identity === 'NOT_REGISTERED') blockers.push('IDENTITY_NOT_REGISTERED');
  if (verdictPausesSigning(input.identity)) blockers.push('IDENTITY_MISMATCH');
  if (input.expectedKeyMatches === false) blockers.push('EXPECTED_KEY_MISMATCH');
  if (input.network !== 'devnet') blockers.push('NETWORK_NOT_DEVNET');
  if (!input.networkVerified) blockers.push('NETWORK_NOT_VERIFIED');
  if (!input.safetyLatchHealthy) blockers.push('SAFETY_LATCH_RAISED');
  if (input.hasAmbiguousAttempt) blockers.push('AMBIGUOUS_ATTEMPT');
  if (input.withdrawalsEnabled) blockers.push('WITHDRAWALS_ENABLED');
  if (input.broadcastAvailable) blockers.push('BROADCAST_ENABLED');

  return blockers;
}

/**
 * Что показать обычному человеку.
 *
 * Инфраструктуры здесь нет: ни провайдера, ни узла, ни причины,
 * по которой не сошёлся ключ. Человеку нужно понять, может ли он
 * чего-то ждать, — и не более того.
 */
export type SigningPublicView =
  | 'SIGNING_OFF'
  | 'PREPARING'
  | 'AWAITING_KEY_CONFIRMATION'
  | 'TEST_CIRCUIT_ONLY'
  | 'SIGNED_NOT_SENT'
  | 'MANUAL_REVIEW';

export function signingPublicView(state: TransactionSigningState): SigningPublicView {
  switch (state) {
    case 'DISABLED':
      return 'SIGNING_OFF';
    case 'NOT_CONFIGURED':
    case 'NETWORK_UNVERIFIED':
      return 'PREPARING';
    case 'IDENTITY_UNVERIFIED':
      return 'AWAITING_KEY_CONFIRMATION';
    case 'PAUSED':
    case 'REVIEW_REQUIRED':
      return 'MANUAL_REVIEW';
    case 'SIGNATURE_VALIDATED':
      return 'SIGNED_NOT_SENT';
    default:
      return 'TEST_CIRCUIT_ONLY';
  }
}

// ───────────────────────── Устаревший флаг ───────────────────────────────────

/**
 * Что делать со старым `KMS_SIGNING_ENABLED`.
 *
 * Тихий alias здесь недопустим. Старый флаг означал «контур подписи
 * готов» в те времена, когда контура не существовало; сегодня он
 * стоит в Render и в production-примерах, а нового флага там нет.
 * Принять его как синоним значит включить подпись в окружении,
 * которое об этом не просили.
 *
 * Поэтому: `false` и отсутствие — совместимость, `true` — остановка
 * с объяснением. Несовпадение значений не разрешается в пользу
 * «включено» ни при каком сочетании.
 */
export type LegacyFlagVerdict = 'ABSENT' | 'COMPATIBLE' | 'REFUSED';

export function legacySigningFlagVerdict(input: {
  legacyValue: boolean | undefined;
  canonicalValue: boolean;
}): LegacyFlagVerdict {
  if (input.legacyValue === undefined) return 'ABSENT';
  if (input.legacyValue) return 'REFUSED';
  // Старое окружение с `false` запускается без изменений — и это
  // единственный случай, когда старый флаг вообще что-то значит.
  return 'COMPATIBLE';
}

export const LEGACY_SIGNING_FLAG_MESSAGE =
  'KMS_SIGNING_ENABLED=true больше не включает подпись. ' +
  'Этот флаг относился к готовности LIVE-контура и не управляет ' +
  'подписью транзакций Solana. Уберите его и задайте ' +
  'SOLANA_SIGNING_ENABLED=true вместе с SOLANA_SIGNER_PROVIDER. ' +
  'Значение false и отсутствие переменной по-прежнему допустимы.';
