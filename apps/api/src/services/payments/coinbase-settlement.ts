import { sameMoney } from '@memex/core';
import type { OnrampTransaction } from './coinbase.js';

/**
 * Сверка завершённой транзакции с нашим платежом.
 *
 * Отдельный чистый модуль: это самое дорогое решение во всём
 * платёжном контуре — выдавать доступ или нет, — и проверять его
 * надо поштучно, без базы и без сети.
 *
 * Главное, что здесь записано: событие «успешно» ничего не доказывает
 * само по себе. Предзаполненная сумма на странице провайдера —
 * удобство, а не ограничение; человек может изменить её, выбрать
 * другую сеть, другой актив или другой адрес получателя. Всё это
 * закончится успешной транзакцией у провайдера и ничем у нас.
 */

export const SETTLEMENT_MISMATCH = {
  notSuccess: 'not_success',
  refMismatch: 'partner_ref_mismatch',
  currencyMismatch: 'purchase_currency_mismatch',
  networkMismatch: 'purchase_network_mismatch',
  amountMismatch: 'purchase_amount_mismatch',
  walletMismatch: 'destination_wallet_mismatch',
  missingTxHash: 'missing_tx_hash',
  typeNotAllowed: 'transaction_type_not_allowed',
  fiatCurrencyMismatch: 'payment_currency_mismatch',
  transactionTaken: 'transaction_already_used',
} as const;

export type SettlementMismatch =
  (typeof SETTLEMENT_MISMATCH)[keyof typeof SETTLEMENT_MISMATCH];

export interface ExpectedSettlement {
  partnerUserRef: string;
  /** Сколько USDC должно прийти. Строка из снимка каталога. */
  purchaseAmount: string;
  purchaseCurrency: string;
  purchaseNetwork: string;
  /** Куда. Из настроек, не из запроса. */
  treasuryAddress: string;
  /** Ожидаемая валюта платежа. */
  fiatCurrency: string;
}

export type SettlementVerdict =
  | { ok: true }
  | { ok: false; mismatch: SettlementMismatch };

/**
 * Можно ли выдавать подписку по этой транзакции.
 *
 * Порядок проверок — от самого дешёвого к самому дорогому, но
 * важнее другое: ни одну нельзя пропустить, и ни одна не заменяет
 * другую. Совпадение суммы без совпадения адреса означает, что
 * человек честно купил USDC и отправил его себе.
 *
 * @param takenBy идентификаторы транзакций, уже связанные с другими
 *   платежами. Одна транзакция не должна оплатить две подписки.
 */
export function verifySettlement(
  tx: OnrampTransaction,
  expected: ExpectedSettlement,
  takenBy?: { transactionId: string; paymentId: string } | null,
): SettlementVerdict {
  if (tx.state !== 'PAID') {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.notSuccess };
  }

  if (tx.partnerUserRef !== expected.partnerUserRef) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.refMismatch };
  }

  if (takenBy && takenBy.transactionId === tx.transactionId) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.transactionTaken };
  }

  if (!tx.typeAllowed) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.typeNotAllowed };
  }

  if ((tx.purchaseCurrency ?? '').toUpperCase() !== expected.purchaseCurrency.toUpperCase()) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.currencyMismatch };
  }

  if ((tx.purchaseNetwork ?? '').toLowerCase() !== expected.purchaseNetwork.toLowerCase()) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.networkMismatch };
  }

  // Ровно столько, сколько стоит план. Не «не меньше»: переплата
  // тоже расхождение, и решать, что с ней делать, должен человек.
  if (!tx.purchaseAmount || !sameMoney(tx.purchaseAmount, expected.purchaseAmount)) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.amountMismatch };
  }

  // Адрес Solana сравнивается побайтово: регистр там значим.
  if (tx.walletAddress !== expected.treasuryAddress) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.walletMismatch };
  }

  if (!tx.txHash) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.missingTxHash };
  }

  // Валюта платежа проверяется, только если провайдер её сообщил:
  // отсутствие поля — не расхождение, а неполный ответ.
  if (
    tx.paymentCurrency &&
    tx.paymentCurrency.toUpperCase() !== expected.fiatCurrency.toUpperCase()
  ) {
    return { ok: false, mismatch: SETTLEMENT_MISMATCH.fiatCurrencyMismatch };
  }

  return { ok: true };
}
