/**
 * Пополнение торгового кошелька: правила зачисления.
 *
 * Модуль отвечает на один вопрос — можно ли считать пополнение
 * состоявшимся. Ни сети, ни базы здесь нет, поэтому каждое правило
 * проверяется поштучно.
 *
 * Главное правило: **успешная оплата не равна пополнению.**
 * Apple Pay сообщает, что банк списал деньги. Он ничего не сообщает
 * о том, дошла ли криптовалюта до адреса пользователя, дошла ли она
 * в нужной сети, в нужном токене и в нужном количестве. Зачислять
 * внутренний баланс по факту авторизации карты значит выдавать
 * человеку деньги, которых у платформы может не оказаться.
 *
 * Второе правило: **пополнение считается один раз.** Повторная
 * доставка вебхука — норма, а не сбой; переотправка одной и той же
 * подписи транзакции — тоже. Идентификатором служит подпись
 * транзакции в сети, потому что она существует ровно один раз
 * и не зависит от того, сколько раз нам о ней рассказали.
 */

/** Разрешённые к зачислению активы. */
export interface AssetRule {
  symbol: string;
  /** Адрес выпуска в Solana. Для нативного SOL — null. */
  mint: string | null;
  decimals: number;
  /** Сколько подтверждений считаем достаточным. */
  minConfirmations: number;
  /** Меньше этого не зачисляем: разбор пыли дороже самой пыли. */
  minAmount: string;
}

/**
 * Список разрешённых активов.
 *
 * Именно список, а не проверка «это похоже на токен». Произвольный
 * SPL-токен выпускает кто угодно за минуту: приняв такой перевод
 * как баланс, платформа записала бы себе долг в настоящих деньгах
 * против монеты, нарисованной отправителем.
 *
 * Значения ниже — предложение, а не решение. Реальные депозиты
 * не включаются, пока список не подтверждён.
 */
export const SOLANA_DEPOSIT_ASSETS: readonly AssetRule[] = [
  { symbol: 'SOL', mint: null, decimals: 9, minConfirmations: 32, minAmount: '0.01' },
  {
    symbol: 'USDC',
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    minConfirmations: 32,
    minAmount: '1',
  },
];

export function assetByMint(mint: string | null): AssetRule | null {
  return SOLANA_DEPOSIT_ASSETS.find((a) => a.mint === mint) ?? null;
}

export type DepositState = 'pending' | 'confirmed' | 'credited' | 'rejected';

export const DEPOSIT_REJECT = {
  unknownAsset: 'UNKNOWN_ASSET',
  wrongDestination: 'WRONG_DESTINATION',
  wrongNetwork: 'WRONG_NETWORK',
  belowMinimum: 'BELOW_MINIMUM',
  notConfirmed: 'NOT_CONFIRMED',
  amountMismatch: 'AMOUNT_MISMATCH',
} as const;

export type DepositRejectCode = (typeof DEPOSIT_REJECT)[keyof typeof DEPOSIT_REJECT];

export interface ObservedTransfer {
  /** Подпись транзакции. Единственный устойчивый идентификатор. */
  signature: string;
  /** Сеть, в которой её увидели. */
  network: 'solana';
  /** Адрес выпуска токена. null — нативный SOL. */
  mint: string | null;
  /** Адрес получателя, как он записан в транзакции. */
  destination: string;
  /** Фактически полученное количество в минимальных единицах. */
  rawAmount: bigint;
  confirmations: number;
}

export interface CreditDecision {
  credit: boolean;
  state: DepositState;
  reason?: DepositRejectCode;
  asset?: AssetRule;
}

/**
 * Можно ли зачислить наблюдённый перевод.
 *
 * Порядок проверок — от самого дешёвого отказа к самому дорогому,
 * но важнее другое: ни одна из них не может быть пропущена.
 *
 * Сеть и адрес выпуска проверяются отдельно от символа. Символ
 * подделывается: «USDC» на Solana может выпустить любой, и отличается
 * подделка от настоящего только адресом выпуска.
 *
 * Адрес получателя сверяется с тем, что мы показали пользователю.
 * Совпадение по сумме и токену без совпадения по адресу означает,
 * что деньги пришли не туда — возможно, к другому нашему клиенту.
 */
export function decideCredit(
  t: ObservedTransfer,
  expectedDestination: string,
): CreditDecision {
  if (t.network !== 'solana') {
    return { credit: false, state: 'rejected', reason: DEPOSIT_REJECT.wrongNetwork };
  }

  const asset = assetByMint(t.mint);
  if (!asset) {
    return { credit: false, state: 'rejected', reason: DEPOSIT_REJECT.unknownAsset };
  }

  // Сравнение побайтовое: в Solana регистр адреса значим, и приведение
  // к нижнему регистру сделало бы адрес другим.
  if (t.destination !== expectedDestination) {
    return { credit: false, state: 'rejected', reason: DEPOSIT_REJECT.wrongDestination, asset };
  }

  if (t.confirmations < asset.minConfirmations) {
    return { credit: false, state: 'pending', reason: DEPOSIT_REJECT.notConfirmed, asset };
  }

  if (t.rawAmount <= 0n) {
    return { credit: false, state: 'rejected', reason: DEPOSIT_REJECT.amountMismatch, asset };
  }

  if (t.rawAmount < minRawAmount(asset)) {
    return { credit: false, state: 'rejected', reason: DEPOSIT_REJECT.belowMinimum, asset };
  }

  return { credit: true, state: 'credited', asset };
}

/**
 * Минимальная сумма в минимальных единицах.
 *
 * Считается из строки, а не из числа с плавающей точкой: `0.1 + 0.2`
 * здесь стоило бы денег, а у USDC шесть знаков после запятой,
 * у SOL — девять.
 */
export function minRawAmount(asset: AssetRule): bigint {
  const [whole = '0', frac = ''] = asset.minAmount.split('.');
  const padded = (frac + '0'.repeat(asset.decimals)).slice(0, asset.decimals);
  return BigInt(whole + padded);
}

/**
 * Ключ идемпотентности пополнения.
 *
 * Подпись транзакции, и ничего кроме. Не сумма, не время, не номер
 * вебхука: всё это может повториться или разойтись, а подпись
 * существует в сети ровно один раз.
 */
export function depositKey(signature: string): string {
  return signature.trim();
}

/**
 * Пополнение и оплата подписки — разные потоки.
 *
 * Функция существует, чтобы это различие было записано в коде,
 * а не только в голове. Деньги за подписку получает платформа;
 * деньги за пополнение остаются пользователю и в любой момент
 * могут быть выведены обратно. Смешать их значит однажды списать
 * подписку из торгового баланса или зачислить абонентскую плату
 * как средства для торговли.
 */
export type MoneyFlow = 'subscription_payment' | 'wallet_funding';

export function flowOf(purpose: 'subscription' | 'deposit'): MoneyFlow {
  return purpose === 'subscription' ? 'subscription_payment' : 'wallet_funding';
}
