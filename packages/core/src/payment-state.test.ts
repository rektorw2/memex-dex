import { describe, it, expect } from 'vitest';
import {
  PAYMENT_STATE,
  BRIDGE_TRANSFER_STATE,
  KYC_STATE,
  canTransition,
  transition,
  isTerminal,
  grantsAccess,
  fromBridgeState,
  fromBridgeKycStatus,
  kycAllowsPayment,
  type PaymentState,
} from './payment-state.js';

const ORDER: PaymentState[] = [
  PAYMENT_STATE.created,
  PAYMENT_STATE.kycRequired,
  PAYMENT_STATE.awaitingFunds,
  PAYMENT_STATE.inReview,
  PAYMENT_STATE.fundsReceived,
  PAYMENT_STATE.paymentSubmitted,
  PAYMENT_STATE.paid,
];

describe('движение только вперёд', () => {
  it('обычный путь проходится целиком', () => {
    for (let i = 1; i < ORDER.length; i++) {
      expect(canTransition(ORDER[i - 1]!, ORDER[i]!), `${ORDER[i - 1]} → ${ORDER[i]}`).toBe(true);
    }
  });

  it('шаги можно перепрыгивать вперёд', () => {
    // Вебхук о полученных средствах может прийти раньше, чем о выданных
    // инструкциях: провайдер повторяет доставку, сеть переставляет
    // пакеты.
    expect(canTransition(PAYMENT_STATE.awaitingFunds, PAYMENT_STATE.paid)).toBe(true);
  });

  it('назад — нельзя ни на шаг', () => {
    for (let i = 1; i < ORDER.length; i++) {
      expect(canTransition(ORDER[i]!, ORDER[i - 1]!), `${ORDER[i]} → ${ORDER[i - 1]}`).toBe(false);
    }
  });

  it('запоздавшее ожидание не отменяет оплату', () => {
    // Самая дорогая ошибка автомата: человек теряет доступ,
    // за который заплатил, из-за переставленного вебхука.
    expect(canTransition(PAYMENT_STATE.paid, PAYMENT_STATE.awaitingFunds)).toBe(false);
    expect(canTransition(PAYMENT_STATE.paid, PAYMENT_STATE.fundsReceived)).toBe(false);
  });

  it('повторное то же состояние переходом не считается', () => {
    // Иначе повтор вебхука перезаписывал бы запись и её время.
    for (const s of ORDER) expect(canTransition(s, s)).toBe(false);
  });

  it('из конечных состояний выхода нет', () => {
    for (const s of [PAYMENT_STATE.paid, PAYMENT_STATE.failed, PAYMENT_STATE.undeliverable]) {
      expect(isTerminal(s)).toBe(true);
      expect(canTransition(s, PAYMENT_STATE.awaitingFunds)).toBe(false);
      expect(canTransition(s, PAYMENT_STATE.paid)).toBe(false);
    }
  });

  it('разбор вручную доступен с любой стадии до оплаты', () => {
    for (const s of ORDER.filter((x) => x !== PAYMENT_STATE.paid)) {
      expect(canTransition(s, PAYMENT_STATE.manualReview), s).toBe(true);
    }
  });

  it('оплаченный доступ не отбирается расхождением', () => {
    // Это решение человека, а не автомата.
    expect(canTransition(PAYMENT_STATE.paid, PAYMENT_STATE.manualReview)).toBe(false);
  });

  it('отказ объясняется словами', () => {
    expect(transition(PAYMENT_STATE.paid, PAYMENT_STATE.awaitingFunds)).toMatchObject({
      ok: false,
      state: PAYMENT_STATE.paid,
    });

    expect(transition(PAYMENT_STATE.awaitingFunds, PAYMENT_STATE.paid)).toEqual({
      ok: true,
      state: PAYMENT_STATE.paid,
    });
  });
});

describe('доступ выдаёт одно состояние', () => {
  it('только доставленная оплата', () => {
    expect(grantsAccess(PAYMENT_STATE.paid)).toBe(true);
  });

  it('полученные деньги доступа не дают', () => {
    // Деньги у провайдера, но до казначейского адреса не дошли.
    expect(grantsAccess(PAYMENT_STATE.fundsReceived)).toBe(false);
  });

  it('отправленный перевод доступа не даёт', () => {
    // Хеш на этой стадии по документации провайдера может оказаться
    // неокончательным.
    expect(grantsAccess(PAYMENT_STATE.paymentSubmitted)).toBe(false);
  });

  it('ни одно другое состояние доступа не даёт', () => {
    for (const s of Object.values(PAYMENT_STATE)) {
      if (s === PAYMENT_STATE.paid) continue;
      expect(grantsAccess(s), s).toBe(false);
    }
  });
});

describe('перевод состояний провайдера', () => {
  it('весь обычный путь разобран', () => {
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.awaitingFunds)).toBe(PAYMENT_STATE.awaitingFunds);
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.inReview)).toBe(PAYMENT_STATE.inReview);
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.fundsReceived)).toBe(PAYMENT_STATE.fundsReceived);
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.paymentSubmitted)).toBe(
      PAYMENT_STATE.paymentSubmitted,
    );
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.paymentProcessed)).toBe(PAYMENT_STATE.paid);
  });

  it('исключения разложены по исходам', () => {
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.undeliverable)).toBe(PAYMENT_STATE.undeliverable);
    expect(fromBridgeState(BRIDGE_TRANSFER_STATE.missingReturnPolicy)).toBe(
      PAYMENT_STATE.undeliverable,
    );

    for (const s of [
      BRIDGE_TRANSFER_STATE.returned,
      BRIDGE_TRANSFER_STATE.refunded,
      BRIDGE_TRANSFER_STATE.refundInFlight,
      BRIDGE_TRANSFER_STATE.refundFailed,
      BRIDGE_TRANSFER_STATE.canceled,
      BRIDGE_TRANSFER_STATE.error,
    ]) {
      expect(fromBridgeState(s), s).toBe(PAYMENT_STATE.failed);
    }
  });

  it('незнакомое состояние уходит в разбор, а не в тишину', () => {
    // Провайдер добавляет состояния. Молчаливое «ну и ладно»
    // однажды придётся объяснять человеку, чьи деньги где-то есть,
    // а доступа нет.
    expect(fromBridgeState('something_new')).toBe(PAYMENT_STATE.manualReview);
    expect(fromBridgeState('')).toBe(PAYMENT_STATE.manualReview);
  });

  it('никакое состояние, кроме payment_processed, не даёт доступа', () => {
    for (const raw of Object.values(BRIDGE_TRANSFER_STATE)) {
      const mapped = fromBridgeState(raw);
      const expected = raw === BRIDGE_TRANSFER_STATE.paymentProcessed;

      expect(grantsAccess(mapped), raw).toBe(expected);
    }
  });
});

describe('проверка личности', () => {
  it('одобрение разобрано в обоих написаниях', () => {
    expect(fromBridgeKycStatus('approved')).toBe(KYC_STATE.approved);
    expect(fromBridgeKycStatus('active')).toBe(KYC_STATE.approved);
  });

  it('отказ, пауза и снятие с обслуживания различаются', () => {
    // Человеку они означают разное: переснять документ, ждать
    // или обратиться в поддержку.
    expect(fromBridgeKycStatus('rejected')).toBe(KYC_STATE.rejected);
    expect(fromBridgeKycStatus('paused')).toBe(KYC_STATE.paused);
    expect(fromBridgeKycStatus('offboarded')).toBe(KYC_STATE.offboarded);
  });

  it('ожидание разобрано отдельно', () => {
    for (const s of ['under_review', 'awaiting_questionnaire', 'awaiting_ubo']) {
      expect(fromBridgeKycStatus(s), s).toBe(KYC_STATE.underReview);
    }
  });

  it('незнакомый статус не считается одобрением', () => {
    expect(fromBridgeKycStatus('нечто новое')).toBe(KYC_STATE.underReview);
    expect(kycAllowsPayment(fromBridgeKycStatus('нечто новое'), true)).toBe(false);
  });

  it('к оплате пускает только одобрение вместе с согласием', () => {
    expect(kycAllowsPayment(KYC_STATE.approved, true)).toBe(true);
    expect(kycAllowsPayment(KYC_STATE.approved, false)).toBe(false);
    expect(kycAllowsPayment(KYC_STATE.underReview, true)).toBe(false);
    expect(kycAllowsPayment(KYC_STATE.rejected, true)).toBe(false);
  });
});
