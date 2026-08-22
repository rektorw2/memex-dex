/**
 * Состояния платежа за подписку.
 *
 * Свои, а не провайдерские. Bridge однажды переименует состояние или
 * добавит новое, и если платёжная запись хранит его строку напрямую,
 * менять придётся базу, отчёты и проверки выдачи доступа разом.
 *
 * Главное свойство автомата — монотонность. Платёж движется только
 * вперёд. Вебхуки приходят не по порядку: провайдер повторяет
 * доставку, сеть переставляет пакеты, наша очередь задерживает одно
 * событие и пропускает следующее. Если разрешить обратный переход,
 * запоздавшее «ожидаем средства» отменит уже совершённую оплату —
 * и человек потеряет доступ, за который заплатил.
 */

export const PAYMENT_STATE = {
  /** Запись создана, к провайдеру ещё не ходили. */
  created: 'CREATED',
  /** Нужен KYC или согласие с условиями провайдера. */
  kycRequired: 'KYC_REQUIRED',
  /** Инструкции выданы, ждём перевод от человека. */
  awaitingFunds: 'AWAITING_FUNDS',
  /** Провайдер проверяет данные перевода. Обычно секунды. */
  inReview: 'IN_REVIEW',
  /** Деньги получены провайдером. Доступ ещё не выдаётся. */
  fundsReceived: 'FUNDS_RECEIVED',
  /** Провайдер отправил перевод в сеть. Хеш может быть неокончательным. */
  paymentSubmitted: 'PAYMENT_SUBMITTED',
  /** Доставлено. Единственное состояние, открывающее доступ. */
  paid: 'PAID',
  /** Доставить не удалось: неверный адрес, неподдерживаемый актив. */
  undeliverable: 'UNDELIVERABLE',
  /** Ошибка, возврат, отмена. Деньги у платформы не осели. */
  failed: 'FAILED',
  /** Деньги пришли, но что-то не сошлось. Разбирает человек. */
  manualReview: 'MANUAL_REVIEW_REQUIRED',
} as const;

export type PaymentState = (typeof PAYMENT_STATE)[keyof typeof PAYMENT_STATE];

/**
 * Порядок движения вперёд.
 *
 * Число — не важность, а место в цепочке. Переход разрешён, если
 * ранг не уменьшается. Состояния-исходы стоят выше всех: из них
 * не выходят.
 */
const RANK: Record<PaymentState, number> = {
  CREATED: 0,
  KYC_REQUIRED: 1,
  AWAITING_FUNDS: 2,
  IN_REVIEW: 3,
  FUNDS_RECEIVED: 4,
  PAYMENT_SUBMITTED: 5,
  PAID: 6,
  UNDELIVERABLE: 6,
  FAILED: 6,
  MANUAL_REVIEW_REQUIRED: 6,
};

/** Состояния, из которых уже не выходят. */
export const TERMINAL_STATES: readonly PaymentState[] = [
  PAYMENT_STATE.paid,
  PAYMENT_STATE.undeliverable,
  PAYMENT_STATE.failed,
  PAYMENT_STATE.manualReview,
];

export function isTerminal(state: PaymentState): boolean {
  return TERMINAL_STATES.includes(state);
}

/**
 * Разрешён ли переход.
 *
 * Из конечного состояния — никуда, даже в себя же: повторное событие
 * не должно перезаписывать запись и обновлять её время.
 *
 * Единственное исключение — переход в разбор вручную. Он возможен
 * откуда угодно, кроме уже выданной оплаты: если деньги пришли,
 * а данные не сошлись, потерять платёж нельзя, и человек должен
 * увидеть его в списке на разбор.
 */
export function canTransition(from: PaymentState, to: PaymentState): boolean {
  if (from === to) return false;

  // Разбор вручную доступен отовсюду, кроме успешной оплаты:
  // выданный доступ отбирать по расхождению нельзя, это отдельное
  // решение человека.
  if (to === PAYMENT_STATE.manualReview) return from !== PAYMENT_STATE.paid;

  if (isTerminal(from)) return false;

  return RANK[to] > RANK[from];
}

/** Переход с объяснением отказа. */
export function transition(
  from: PaymentState,
  to: PaymentState,
): { ok: true; state: PaymentState } | { ok: false; reason: string; state: PaymentState } {
  if (canTransition(from, to)) return { ok: true, state: to };

  if (from === to) {
    return { ok: false, reason: 'состояние не изменилось', state: from };
  }

  if (isTerminal(from)) {
    return { ok: false, reason: `платёж уже завершён состоянием ${from}`, state: from };
  }

  return { ok: false, reason: `назад из ${from} в ${to} нельзя`, state: from };
}

/**
 * Открывает ли состояние доступ.
 *
 * Ровно одно. `FUNDS_RECEIVED` означает, что деньги у провайдера,
 * но до казначейского адреса они ещё не дошли; `PAYMENT_SUBMITTED`
 * означает, что отправлены — и хеш на этой стадии, по документации
 * провайдера, может оказаться не окончательным. Выдать доступ
 * по любому из них значит выдать его за перевод, который может
 * вернуться.
 */
export function grantsAccess(state: PaymentState): boolean {
  return state === PAYMENT_STATE.paid;
}

/** Состояния провайдера Bridge, которые мы понимаем. */
export const BRIDGE_TRANSFER_STATE = {
  awaitingFunds: 'awaiting_funds',
  inReview: 'in_review',
  fundsReceived: 'funds_received',
  paymentSubmitted: 'payment_submitted',
  paymentProcessed: 'payment_processed',
  undeliverable: 'undeliverable',
  returned: 'returned',
  refunded: 'refunded',
  refundInFlight: 'refund_in_flight',
  refundFailed: 'refund_failed',
  missingReturnPolicy: 'missing_return_policy',
  canceled: 'canceled',
  error: 'error',
} as const;

/**
 * Перевод состояния провайдера в наше.
 *
 * Неизвестное состояние не игнорируется и не считается безобидным:
 * оно уходит в разбор вручную. Провайдер добавляет состояния, и
 * молчаливое «ну и ладно» на незнакомой строке однажды придётся
 * объяснять человеку, чьи деньги где-то есть, а доступа нет.
 */
export function fromBridgeState(raw: string): PaymentState {
  switch (raw) {
    case BRIDGE_TRANSFER_STATE.awaitingFunds:
      return PAYMENT_STATE.awaitingFunds;
    case BRIDGE_TRANSFER_STATE.inReview:
      return PAYMENT_STATE.inReview;
    case BRIDGE_TRANSFER_STATE.fundsReceived:
      return PAYMENT_STATE.fundsReceived;
    case BRIDGE_TRANSFER_STATE.paymentSubmitted:
      return PAYMENT_STATE.paymentSubmitted;
    case BRIDGE_TRANSFER_STATE.paymentProcessed:
      return PAYMENT_STATE.paid;
    case BRIDGE_TRANSFER_STATE.undeliverable:
    case BRIDGE_TRANSFER_STATE.missingReturnPolicy:
      return PAYMENT_STATE.undeliverable;
    case BRIDGE_TRANSFER_STATE.returned:
    case BRIDGE_TRANSFER_STATE.refunded:
    case BRIDGE_TRANSFER_STATE.refundInFlight:
    case BRIDGE_TRANSFER_STATE.refundFailed:
    case BRIDGE_TRANSFER_STATE.canceled:
    case BRIDGE_TRANSFER_STATE.error:
      return PAYMENT_STATE.failed;
    default:
      return PAYMENT_STATE.manualReview;
  }
}

/** Состояния проверки личности у провайдера. */
export const KYC_STATE = {
  notStarted: 'NOT_STARTED',
  incomplete: 'INCOMPLETE',
  underReview: 'UNDER_REVIEW',
  approved: 'APPROVED',
  rejected: 'REJECTED',
  paused: 'PAUSED',
  offboarded: 'OFFBOARDED',
} as const;

export type KycState = (typeof KYC_STATE)[keyof typeof KYC_STATE];

/**
 * Перевод статуса проверки личности.
 *
 * Отказ, пауза и снятие с обслуживания — разные состояния,
 * а не общее «не одобрено». Человеку они означают разное: одному
 * надо переснять документ, другому — ждать, третьему — обратиться
 * в поддержку, и объединять их в один экран значит не сказать
 * никому из троих ничего полезного.
 */
export function fromBridgeKycStatus(raw: string): KycState {
  switch (raw) {
    case 'approved':
    case 'active':
      return KYC_STATE.approved;
    case 'rejected':
      return KYC_STATE.rejected;
    case 'paused':
      return KYC_STATE.paused;
    case 'offboarded':
      return KYC_STATE.offboarded;
    case 'under_review':
    case 'awaiting_questionnaire':
    case 'awaiting_ubo':
      return KYC_STATE.underReview;
    case 'incomplete':
      return KYC_STATE.incomplete;
    case 'not_started':
      return KYC_STATE.notStarted;
    default:
      // Незнакомый статус — не «наверное всё хорошо». Считаем, что
      // проверка не пройдена, и не пускаем к оплате.
      return KYC_STATE.underReview;
  }
}

/** Можно ли начинать оплату. */
export function kycAllowsPayment(kyc: KycState, tosAccepted: boolean): boolean {
  return kyc === KYC_STATE.approved && tosAccepted;
}

// ─────────────────────────── Состояния Coinbase ─────────────────────────────

/** Состояния транзакции Onramp. */
export const COINBASE_TRANSACTION_STATUS = {
  inProgress: 'ONRAMP_TRANSACTION_STATUS_IN_PROGRESS',
  success: 'ONRAMP_TRANSACTION_STATUS_SUCCESS',
  failed: 'ONRAMP_TRANSACTION_STATUS_FAILED',
} as const;

/** Виды транзакции, допустимые для покупки с доставкой на адрес. */
export const COINBASE_TRANSACTION_TYPE = {
  buyAndSend: 'ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND',
  send: 'ONRAMP_TRANSACTION_TYPE_SEND',
} as const;

export type CoinbaseTransactionType =
  (typeof COINBASE_TRANSACTION_TYPE)[keyof typeof COINBASE_TRANSACTION_TYPE];

export function isAllowedCoinbaseType(raw: string): raw is CoinbaseTransactionType {
  return (
    raw === COINBASE_TRANSACTION_TYPE.buyAndSend || raw === COINBASE_TRANSACTION_TYPE.send
  );
}

/**
 * Перевод состояния Coinbase в наше.
 *
 * `success` даёт кандидата на выдачу, а не выдачу: доступ открывается
 * только после того, как сервер перечитает транзакцию и сверит сумму,
 * валюту, сеть и адрес. Само по себе слово «успешно» в событии
 * означает лишь то, что провайдер считает покупку завершённой —
 * но не то, что купили именно то и именно туда.
 *
 * Незнакомое состояние уходит в разбор вручную, а не считается
 * безобидным: провайдер добавляет значения, и молчание на незнакомой
 * строке однажды придётся объяснять человеку, чьи деньги списаны.
 */
export function fromCoinbaseStatus(raw: string): PaymentState {
  switch (raw) {
    case COINBASE_TRANSACTION_STATUS.inProgress:
      return PAYMENT_STATE.paymentSubmitted;
    case COINBASE_TRANSACTION_STATUS.success:
      return PAYMENT_STATE.paid;
    case COINBASE_TRANSACTION_STATUS.failed:
      return PAYMENT_STATE.failed;
    default:
      return PAYMENT_STATE.manualReview;
  }
}

/** Виды событий Onramp, которые мы обрабатываем. */
export const COINBASE_EVENT = {
  created: 'onramp.transaction.created',
  updated: 'onramp.transaction.updated',
  success: 'onramp.transaction.success',
  failed: 'onramp.transaction.failed',
} as const;

export type CoinbaseEventType = (typeof COINBASE_EVENT)[keyof typeof COINBASE_EVENT];

export function isCoinbaseOnrampEvent(raw: string): raw is CoinbaseEventType {
  return Object.values(COINBASE_EVENT).includes(raw as CoinbaseEventType);
}

/**
 * Состояние по виду события, когда транзакцию ещё не перечитали.
 *
 * `created` не двигает платёж дальше созданного: событие говорит,
 * что человек начал покупку, а не что заплатил.
 */
export function fromCoinbaseEvent(eventType: string): PaymentState | null {
  switch (eventType) {
    case COINBASE_EVENT.created:
      return PAYMENT_STATE.awaitingFunds;
    case COINBASE_EVENT.updated:
      return PAYMENT_STATE.paymentSubmitted;
    case COINBASE_EVENT.failed:
      return PAYMENT_STATE.failed;
    case COINBASE_EVENT.success:
      // Намеренно null: успех подтверждается только перечитыванием
      // транзакции и сверкой. Событие само по себе доступа не даёт.
      return null;
    default:
      return null;
  }
}
