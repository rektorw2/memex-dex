import { describe, it, expect } from 'vitest';
import {
  decideCredit,
  minRawAmount,
  depositKey,
  assetByMint,
  flowOf,
  SOLANA_DEPOSIT_ASSETS,
  DEPOSIT_REJECT,
  type ObservedTransfer,
} from './deposit.js';

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DEST = '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU';

function transfer(over: Partial<ObservedTransfer> = {}): ObservedTransfer {
  return {
    signature: 'sig-1',
    network: 'solana',
    mint: USDC,
    destination: DEST,
    rawAmount: 5_000_000n,
    confirmations: 32,
    ...over,
  };
}

describe('список разрешённых активов', () => {
  it('содержит только явно перечисленное', () => {
    expect(SOLANA_DEPOSIT_ASSETS.map((a) => a.symbol)).toEqual(['SOL', 'USDC']);
  });

  it('произвольный токен не находится', () => {
    // Выпустить SPL-токен может кто угодно за минуту. Приняв такой
    // перевод как баланс, платформа запишет себе долг в настоящих
    // деньгах против монеты, нарисованной отправителем.
    expect(assetByMint('НеизвестныйМинт')).toBeNull();
  });

  it('нативный SOL опознаётся по отсутствию адреса выпуска', () => {
    expect(assetByMint(null)?.symbol).toBe('SOL');
  });
});

describe('решение о зачислении', () => {
  it('полный набор условий даёт зачисление', () => {
    const d = decideCredit(transfer(), DEST);

    expect(d.credit).toBe(true);
    expect(d.state).toBe('credited');
  });

  it('чужой адрес выпуска отклоняется', () => {
    // Символ подделывается: «USDC» на Solana выпустит любой,
    // и отличается подделка только адресом выпуска.
    const d = decideCredit(transfer({ mint: 'ПоддельныйUSDC' }), DEST);

    expect(d.credit).toBe(false);
    expect(d.reason).toBe(DEPOSIT_REJECT.unknownAsset);
  });

  it('чужой адрес получателя отклоняется', () => {
    const d = decideCredit(transfer({ destination: 'ЧужойАдрес' }), DEST);

    expect(d.credit).toBe(false);
    expect(d.reason).toBe(DEPOSIT_REJECT.wrongDestination);
  });

  it('регистр адреса значим', () => {
    // В Solana адрес чувствителен к регистру: приведение сделало бы
    // адрес другим.
    const d = decideCredit(transfer({ destination: DEST.toLowerCase() }), DEST);

    expect(d.credit).toBe(false);
  });

  it('чужая сеть отклоняется', () => {
    const d = decideCredit(transfer({ network: 'ethereum' as never }), DEST);

    expect(d.credit).toBe(false);
    expect(d.reason).toBe(DEPOSIT_REJECT.wrongNetwork);
  });

  it('недостаточно подтверждений — ждём, а не отклоняем', () => {
    // Разница важна для интерфейса: «ждём сеть» и «перевод не принят»
    // требуют от человека разного.
    const d = decideCredit(transfer({ confirmations: 3 }), DEST);

    expect(d.credit).toBe(false);
    expect(d.state).toBe('pending');
    expect(d.reason).toBe(DEPOSIT_REJECT.notConfirmed);
  });

  it('ровно на пороге подтверждений — зачисляем', () => {
    const d = decideCredit(transfer({ confirmations: 32 }), DEST);

    expect(d.credit).toBe(true);
  });

  it('сумма ниже минимума отклоняется', () => {
    const d = decideCredit(transfer({ rawAmount: 100n }), DEST);

    expect(d.credit).toBe(false);
    expect(d.reason).toBe(DEPOSIT_REJECT.belowMinimum);
  });

  it('нулевая сумма отклоняется', () => {
    const d = decideCredit(transfer({ rawAmount: 0n }), DEST);

    expect(d.credit).toBe(false);
    expect(d.reason).toBe(DEPOSIT_REJECT.amountMismatch);
  });

  it('ровно минимум проходит', () => {
    const usdc = assetByMint(USDC)!;
    const d = decideCredit(transfer({ rawAmount: minRawAmount(usdc) }), DEST);

    expect(d.credit).toBe(true);
  });
});

describe('минимальная сумма', () => {
  it('считается из строки без плавающей точки', () => {
    // У USDC шесть знаков, у SOL девять. Ошибка на порядок здесь
    // стоит денег.
    expect(minRawAmount(assetByMint(USDC)!)).toBe(1_000_000n);
    expect(minRawAmount(assetByMint(null)!)).toBe(10_000_000n);
  });
});

describe('идемпотентность', () => {
  it('ключом служит подпись и индекс перевода', () => {
    expect(depositKey('  sig-1  ', 0)).toBe('sig-1:0');
    expect(depositKey('sig-1', 1)).toBe('sig-1:1');
    expect(depositKey('sig-1', 0)).toBe(depositKey('sig-1', 0));
    expect(depositKey('sig-1', 0)).not.toBe(depositKey('sig-1', 1));
    expect(depositKey('sig-1')).not.toBe(depositKey('sig-2'));
  });

  it('отклоняет пустую подпись и неверный индекс', () => {
    expect(() => depositKey('')).toThrow('signature');
    expect(() => depositKey('sig', -1)).toThrow('instructionIndex');
  });
});

describe('два денежных потока', () => {
  it('оплата подписки и пополнение кошелька различаются', () => {
    // Деньги за подписку получает платформа; деньги за пополнение
    // остаются пользователю и в любой момент выводятся обратно.
    expect(flowOf('subscription')).toBe('subscription_payment');
    expect(flowOf('deposit')).toBe('wallet_funding');
    expect(flowOf('subscription')).not.toBe(flowOf('deposit'));
  });
});
