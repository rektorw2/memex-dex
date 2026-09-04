/**
 * Намерение совершить транзакцию.
 *
 * Между «пользователь хочет» и «в цепочку ушли байты» стоит запись,
 * которую собрал сервер и которую нельзя переписать. Это единственный
 * способ ответить на вопрос «что именно подписали»: подпись сама по
 * себе не помнит, чему она соответствовала.
 *
 * Три правила определяют всё остальное.
 *
 * **Клиент передаёт намерение, а не транзакцию.** Готовые байты от
 * браузера — это endpoint «подпиши что угодно», сколько бы проверок
 * вокруг него ни стояло: проверять пришлось бы содержимое чужой
 * структуры, а разобрать её полностью сложнее, чем собрать свою.
 *
 * **Подпись — не отправка.** `SIGNED` означает ровно то, что
 * написано: байты подписаны. Дошли ли они до сети, приняты ли,
 * финализированы ли — четыре разных вопроса, и склеивать их в один
 * статус значит однажды показать человеку «отправлено» про перевод,
 * которого не было.
 *
 * **После одобрения деньги не меняются.** Сумма, получатель и актив,
 * изменённые после того, как человек нажал «подтвердить», — это
 * подпись под тем, чего он не видел. Изменение требует нового
 * намерения, а не правки существующего.
 */

export type TransactionIntentState =
  /** Создано сервером, проверки ещё не проходили. */
  | 'DRAFT'
  /** Все серверные проверки пройдены, сообщение собрано и захешировано. */
  | 'VALIDATED'
  /** Человек подтвердил. Денежные поля дальше неизменны. */
  | 'APPROVED'
  /** Захвачено на подпись. Второй захват невозможен. */
  | 'SIGNING'
  /** Подпись получена и проверена локально. НЕ отправлено. */
  | 'SIGNED'
  /** Срок действия истёк. Оживить нельзя. */
  | 'EXPIRED'
  /** Отклонено человеком или политикой. */
  | 'REJECTED'
  /** Сорвалось на подписи. Требует разбора, не повтора. */
  | 'FAILED';

/**
 * Разрешённые переходы.
 *
 * `SIGNED` — конечное состояние: `SUBMITTED` в этой таблице нет и на
 * этом этапе появиться не может. Отсутствие перехода надёжнее любой
 * проверки перед отправкой, потому что проверку можно обойти, а
 * несуществующее состояние — нет.
 */
const TRANSITIONS: Readonly<Record<TransactionIntentState, readonly TransactionIntentState[]>> = {
  DRAFT: ['VALIDATED', 'REJECTED', 'EXPIRED', 'FAILED'],
  VALIDATED: ['APPROVED', 'REJECTED', 'EXPIRED', 'FAILED'],
  APPROVED: ['SIGNING', 'REJECTED', 'EXPIRED', 'FAILED'],
  SIGNING: ['SIGNED', 'FAILED', 'EXPIRED'],
  SIGNED: [],
  EXPIRED: [],
  REJECTED: [],
  FAILED: [],
};

export function canTransitionIntent(
  from: TransactionIntentState,
  to: TransactionIntentState,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function isTerminalIntentState(state: TransactionIntentState): boolean {
  return TRANSITIONS[state]?.length === 0;
}

/** Состояния, в которых намерение ещё может стать подписью. */
export function isLiveIntentState(state: TransactionIntentState): boolean {
  return state === 'DRAFT' || state === 'VALIDATED' || state === 'APPROVED' || state === 'SIGNING';
}

/**
 * Типы намерений, разрешённые на этом этапе.
 *
 * Список закрытый. Универсальной передачи инструкций Solana нет и
 * не появится «на время»: временное разрешение подписать что угодно
 * переживает все последующие этапы.
 */
export type IntentPurpose =
  /** Проверочный перевод SOL самому себе. Денег не двигает. */
  | 'DEVNET_SELF_TRANSFER'
  /** Проверочный перевод SPL самому себе на том же владельце. */
  | 'DEVNET_SELF_SPL_TRANSFER';

export const ALLOWED_INTENT_PURPOSES: readonly IntentPurpose[] = [
  'DEVNET_SELF_TRANSFER',
  'DEVNET_SELF_SPL_TRANSFER',
];

export function isAllowedPurpose(value: string): value is IntentPurpose {
  return (ALLOWED_INTENT_PURPOSES as readonly string[]).includes(value);
}

/**
 * Разрешённые программы.
 *
 * Адреса системной программы и обеих токен-программ. Всё остальное
 * в инструкции означает, что сервер собрал не то, что собирался, —
 * и это повод остановиться, а не выяснять на ходу.
 */
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';
export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export const ALLOWED_PROGRAM_IDS: Readonly<Record<IntentPurpose, readonly string[]>> = {
  DEVNET_SELF_TRANSFER: [SYSTEM_PROGRAM_ID],
  DEVNET_SELF_SPL_TRANSFER: [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID],
};

export function programAllowed(purpose: IntentPurpose, programId: string): boolean {
  return ALLOWED_PROGRAM_IDS[purpose]?.includes(programId) ?? false;
}

/**
 * Поля, влияющие на деньги.
 *
 * После одобрения любое из них можно только прочитать. Список
 * записан явно, чтобы новое денежное поле нельзя было добавить,
 * молча оставив его изменяемым.
 */
export const MONEY_FIELDS = [
  'network',
  'purpose',
  'mint',
  'rawAmount',
  'sourceAddress',
  'destinationAddress',
  'feeLimitLamports',
  'slippageBps',
  'allowedProgramIds',
  'messageHash',
  'policyVersion',
] as const;

export type MoneyField = (typeof MONEY_FIELDS)[number];

/** Снимок денежной части намерения. Все количества — строки. */
export interface IntentMoneyFacts {
  network: string;
  purpose: string;
  mint: string | null;
  /**
   * Сумма в минимальных единицах, строкой.
   *
   * Не `number`: u64 не помещается в число с плавающей точкой, и
   * округление здесь стоит ровно столько, сколько округлило.
   */
  rawAmount: string;
  sourceAddress: string;
  destinationAddress: string;
  feeLimitLamports: string;
  slippageBps: number;
  allowedProgramIds: readonly string[];
  messageHash: string;
  policyVersion: string;
}

/**
 * Что изменилось между одобренным и предъявленным.
 *
 * Возвращается список полей, а не «да/нет»: в журнале должно
 * остаться, что именно пытались подменить.
 */
export function changedMoneyFields(
  approved: IntentMoneyFacts,
  current: IntentMoneyFacts,
): MoneyField[] {
  const changed: MoneyField[] = [];
  for (const field of MONEY_FIELDS) {
    const before = approved[field];
    const after = current[field];
    const same = Array.isArray(before) && Array.isArray(after)
      ? before.length === after.length && before.every((value, index) => value === after[index])
      : before === after;
    if (!same) changed.push(field);
  }
  return changed;
}

export type IntentFailureCode =
  | 'INTENT_EXPIRED'
  | 'BLOCKHASH_EXPIRED'
  | 'MONEY_FIELDS_CHANGED'
  | 'MESSAGE_HASH_MISMATCH'
  | 'POLICY_VERSION_CHANGED'
  | 'KEY_VERSION_CHANGED'
  | 'PUBLIC_KEY_MISMATCH'
  | 'SIGNATURE_INVALID'
  | 'SIGNER_UNAVAILABLE'
  | 'SIGNER_AMBIGUOUS'
  | 'ALREADY_SIGNED'
  | 'CLAIM_LOST'
  | 'NOT_OWNER'
  | 'WRONG_STATE'
  | 'PROGRAM_NOT_ALLOWED'
  | 'PURPOSE_NOT_ALLOWED'
  | 'NETWORK_NOT_ALLOWED'
  | 'FEE_LIMIT_EXCEEDED'
  | 'SLIPPAGE_EXCEEDED'
  | 'INSUFFICIENT_RESERVE'
  | 'SAFETY_LATCH_RAISED'
  | 'MESSAGE_TOO_LARGE';

export interface SigningPreconditions {
  state: TransactionIntentState;
  /** Владелец намерения по данным сервера. */
  ownerId: string;
  /** Кто просит подписать. */
  actorId: string;
  expiresAt: number;
  now: number;
  /** Последний слот, при котором blockhash ещё действителен. */
  lastValidBlockHeight: string;
  /** Текущая высота блока. Строкой: значения растут за пределы `number`. */
  currentBlockHeight: string;
  approved: IntentMoneyFacts;
  current: IntentMoneyFacts;
  /** Версия ключа, зафиксированная при одобрении. */
  approvedKeyVersion: string;
  /** Версия ключа, которую KMS отдаёт сейчас. */
  currentKeyVersion: string;
  /** Публичный ключ KMS совпадает с адресом кошелька. */
  publicKeyMatchesWallet: boolean;
  safetyLatchHealthy: boolean;
}

export interface SigningVerdict {
  allowed: boolean;
  /** Первая причина отказа. Порядок проверок — от дешёвых к дорогим. */
  reason: IntentFailureCode | null;
  /** Какие денежные поля разошлись. Пусто, если дело не в них. */
  changedFields: MoneyField[];
}

/**
 * Можно ли подписывать.
 *
 * Чистая функция: ни KMS, ни базы, ни часов внутри. Всё, что она
 * знает, ей передали, — поэтому каждое правило проверяется отдельно
 * и ни одно нельзя случайно пропустить в одной из веток вызывающего.
 */
export function checkSigningPreconditions(input: SigningPreconditions): SigningVerdict {
  const deny = (reason: IntentFailureCode, changedFields: MoneyField[] = []): SigningVerdict =>
    ({ allowed: false, reason, changedFields });

  // Чужое намерение не подписывается даже администратору: подпись
  // ставится от имени кошелька, а не от имени того, кто попросил.
  if (input.ownerId !== input.actorId) return deny('NOT_OWNER');
  if (input.state !== 'APPROVED') {
    return deny(input.state === 'SIGNED' ? 'ALREADY_SIGNED' : 'WRONG_STATE');
  }
  if (input.now >= input.expiresAt) return deny('INTENT_EXPIRED');

  /*
   * Blockhash живёт ограниченное число блоков. Просроченный означает,
   * что подпись получится валидной, но сеть транзакцию не примет, —
   * и мы потратим ресурс KMS ради заведомо мёртвых байтов.
   */
  if (compareNumeric(input.currentBlockHeight, input.lastValidBlockHeight) > 0) {
    return deny('BLOCKHASH_EXPIRED');
  }

  const changed = changedMoneyFields(input.approved, input.current);
  if (changed.length > 0) {
    // Хеш сообщения меняется вместе с любым денежным полем, но
    // называем причину точнее: «сумма другая» полезнее, чем
    // «хеш не совпал».
    const onlyHash = changed.length === 1 && changed[0] === 'messageHash';
    return deny(onlyHash ? 'MESSAGE_HASH_MISMATCH' : 'MONEY_FIELDS_CHANGED', changed);
  }

  if (input.approved.policyVersion !== input.current.policyVersion) {
    return deny('POLICY_VERSION_CHANGED');
  }
  if (input.approvedKeyVersion !== input.currentKeyVersion) return deny('KEY_VERSION_CHANGED');
  if (!input.publicKeyMatchesWallet) return deny('PUBLIC_KEY_MISMATCH');
  if (!input.safetyLatchHealthy) return deny('SAFETY_LATCH_RAISED');

  return { allowed: true, reason: null, changedFields: [] };
}

/**
 * Сравнение неотрицательных целых, записанных строками.
 *
 * Высота блока Solana выходит за пределы точного целого в `number`,
 * а `BigInt` в чистом ядре не нужен: сравнить можно по длине и
 * лексикографически.
 */
export function compareNumeric(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new Error('compareNumeric: ожидалось неотрицательное целое строкой');
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Стадии для показа человеку. Внутренних состояний он не видит. */
export type IntentStage = 'PREPARING' | 'AWAITING_APPROVAL' | 'SIGNING' | 'SIGNED' | 'CLOSED';

export function intentStage(state: TransactionIntentState): IntentStage {
  switch (state) {
    case 'DRAFT':
      return 'PREPARING';
    case 'VALIDATED':
      return 'AWAITING_APPROVAL';
    case 'APPROVED':
    case 'SIGNING':
      return 'SIGNING';
    case 'SIGNED':
      return 'SIGNED';
    default:
      // EXPIRED, REJECTED, FAILED и всё незнакомое — закрыто.
      // Новое состояние с сервера не должно выглядеть как успех.
      return 'CLOSED';
  }
}

/**
 * Срок жизни намерения.
 *
 * Короткий намеренно: чем дольше живёт одобрение, тем больше шансов,
 * что человек уже забыл, на что соглашался.
 */
export const INTENT_TTL_MS = 2 * 60_000;

export function intentExpiryAt(createdAt: number): number {
  return createdAt + INTENT_TTL_MS;
}
