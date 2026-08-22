import { describe, it, expect } from 'vitest';
import { catalogEntryFor } from '@memex/core';
import { verifySettlement, SETTLEMENT_MISMATCH } from './coinbase-settlement.js';
import type { OnrampTransaction } from './coinbase.js';

/**
 * Сверка транзакции с платежом.
 *
 * Самое дорогое решение во всём контуре: выдать доступ или нет.
 * Проверяется поштучно, без базы и без сети — потому что каждая
 * из этих проверок закрывает свой способ заплатить не нам.
 */

const TREASURY = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';
const OTHER_WALLET = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const entry = catalogEntryFor('PRO');

const expected = {
  partnerUserRef: 'mx_abcdef0123456789abcdef0123456789abcdef01',
  purchaseAmount: entry.price.amount,
  purchaseCurrency: 'USDC',
  purchaseNetwork: 'solana',
  treasuryAddress: TREASURY,
  fiatCurrency: 'USD',
};

function tx(over: Partial<OnrampTransaction> = {}): OnrampTransaction {
  return {
    transactionId: 'tx_1',
    partnerUserRef: expected.partnerUserRef,
    state: 'PAID',
    rawStatus: 'ONRAMP_TRANSACTION_STATUS_SUCCESS',
    purchaseCurrency: 'USDC',
    purchaseNetwork: 'solana',
    purchaseAmount: entry.price.amount,
    paymentSubtotal: '50.00',
    paymentTotal: '51.99',
    paymentCurrency: 'USD',
    coinbaseFee: '1.99',
    networkFee: '0.00',
    walletAddress: TREASURY,
    txHash: '4Nd1mQ',
    type: 'ONRAMP_TRANSACTION_TYPE_BUY_AND_SEND',
    typeAllowed: true,
    ...over,
  };
}

describe('сверка транзакции Coinbase', () => {
  it('пропускает совпавшую по всем полям', () => {
    expect(verifySettlement(tx(), expected)).toEqual({ ok: true });
  });

  it('не пропускает незавершённую', () => {
    const v = verifySettlement(tx({ state: 'PAYMENT_SUBMITTED' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.notSuccess });
  });

  it('не пропускает чужую ссылку покупателя', () => {
    const v = verifySettlement(tx({ partnerUserRef: 'mx_чужой' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.refMismatch });
  });

  it('не пропускает транзакцию, уже привязанную к другому платежу', () => {
    const v = verifySettlement(tx(), expected, { transactionId: 'tx_1', paymentId: 'pay-9' });
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.transactionTaken });
  });

  it('пропускает, если занята другая транзакция', () => {
    const v = verifySettlement(tx(), expected, { transactionId: 'tx_2', paymentId: 'pay-9' });
    expect(v).toEqual({ ok: true });
  });

  it('не пропускает недопустимый вид транзакции', () => {
    const v = verifySettlement(
      tx({ type: 'ONRAMP_TRANSACTION_TYPE_UNSPECIFIED', typeAllowed: false }),
      expected,
    );
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.typeNotAllowed });
  });

  it('не пропускает другой актив', () => {
    const v = verifySettlement(tx({ purchaseCurrency: 'USDT' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.currencyMismatch });
  });

  it('не пропускает другую сеть', () => {
    const v = verifySettlement(tx({ purchaseNetwork: 'ethereum' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.networkMismatch });
  });

  it('не пропускает недоплату', () => {
    const v = verifySettlement(tx({ purchaseAmount: '49.99' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.amountMismatch });
  });

  it('не пропускает и переплату: решать, что с ней делать, должен человек', () => {
    const v = verifySettlement(tx({ purchaseAmount: '75.00' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.amountMismatch });
  });

  it('считает «50», «50.00» и «50.000» одной суммой', () => {
    for (const amount of ['50', '50.00', '50.000']) {
      expect(verifySettlement(tx({ purchaseAmount: amount }), expected)).toEqual({ ok: true });
    }
  });

  it('не пропускает доставку на чужой адрес при верной сумме', () => {
    // Человек честно купил USDC и отправил его себе. У провайдера
    // это успех, у нас — нет.
    const v = verifySettlement(tx({ walletAddress: OTHER_WALLET }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.walletMismatch });
  });

  it('различает регистр в адресе Solana', () => {
    const v = verifySettlement(tx({ walletAddress: TREASURY.toLowerCase() }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.walletMismatch });
  });

  it('не пропускает успех без хеша транзакции', () => {
    expect(verifySettlement(tx({ txHash: null }), expected)).toEqual({
      ok: false,
      mismatch: SETTLEMENT_MISMATCH.missingTxHash,
    });
  });

  it('не пропускает другую валюту оплаты', () => {
    const v = verifySettlement(tx({ paymentCurrency: 'EUR' }), expected);
    expect(v).toEqual({ ok: false, mismatch: SETTLEMENT_MISMATCH.fiatCurrencyMismatch });
  });

  it('не считает отсутствие валюты оплаты расхождением', () => {
    // Неполный ответ провайдера — это неполный ответ, а не подделка.
    expect(verifySettlement(tx({ paymentCurrency: null }), expected)).toEqual({ ok: true });
  });

  it('не зависит от регистра в названии актива и сети', () => {
    const v = verifySettlement(tx({ purchaseCurrency: 'usdc', purchaseNetwork: 'SOLANA' }), expected);
    expect(v).toEqual({ ok: true });
  });
});
