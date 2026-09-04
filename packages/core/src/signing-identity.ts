/**
 * Чей ключ подписывает.
 *
 * Между «KMS вернул публичный ключ» и «этим ключом можно подписывать
 * от имени кошелька» лежит решение человека. Автоматическая привязка
 * означала бы, что смена ключа в облаке молча меняет адрес, с
 * которого уходят деньги, — и узнать об этом можно было бы только по
 * переводу, ушедшему не оттуда.
 *
 * Поэтому пять сущностей держатся раздельно и не выводятся одна из
 * другой:
 *
 * — **ресурс KMS**: где ключ лежит. Наружу не выходит;
 * — **версия ключа**: чем именно подписано;
 * — **отпечаток**: короткая метка для журнала и диагностики;
 * — **адрес Solana**: чем ключ является для цепочки;
 * — **wallet id**: чей он у нас внутри.
 *
 * Слить их в одно поле удобно ровно до первой ротации.
 */

export type SigningIdentityState =
  /** Ключ прочитан, но человек его не подтвердил. Подписывать нельзя. */
  | 'UNREGISTERED'
  /** Подтверждён администратором. Единственное рабочее состояние. */
  | 'REGISTERED'
  /**
   * Ключ или версия изменились после регистрации.
   *
   * Не «перерегистрировать автоматически»: изменившийся ключ — это
   * другой адрес, и решение о нём принимает человек.
   */
  | 'PAUSED';

export interface SigningIdentityFacts {
  /** Отпечаток публичного ключа. Не сам ключ. */
  fingerprint: string;
  /** Адрес Solana, вычисленный из публичного ключа. */
  solanaAddress: string;
  keyVersion: string;
  algorithm: string;
}

export interface IdentityCheckInput {
  state: SigningIdentityState;
  /** Что зарегистрировал человек. */
  registered: SigningIdentityFacts | null;
  /** Что отдаёт KMS сейчас. */
  observed: SigningIdentityFacts;
  /** Ожидаемый публичный ключ из конфигурации. Пусто — не задан. */
  expectedFingerprint: string | null;
}

export type IdentityVerdict =
  | 'OK'
  | 'NOT_REGISTERED'
  | 'PAUSED'
  | 'FINGERPRINT_CHANGED'
  | 'ADDRESS_CHANGED'
  | 'KEY_VERSION_CHANGED'
  | 'ALGORITHM_CHANGED'
  | 'EXPECTED_MISMATCH';

/**
 * Можно ли подписывать этим ключом сейчас.
 *
 * Порядок проверок — от самого грубого расхождения к самому
 * частному: сначала «это вообще другой ключ», потом «тот же ключ,
 * другая версия».
 */
export function checkSigningIdentity(input: IdentityCheckInput): IdentityVerdict {
  if (input.state === 'PAUSED') return 'PAUSED';
  if (input.state !== 'REGISTERED' || !input.registered) return 'NOT_REGISTERED';

  /*
   * Ожидаемое значение из конфигурации проверяется первым.
   *
   * Оно задаётся человеком отдельно от базы и служит независимым
   * свидетелем: если и база, и KMS изменились согласованно, это
   * единственное, что заметит подмену.
   */
  if (input.expectedFingerprint && input.expectedFingerprint !== input.observed.fingerprint) {
    return 'EXPECTED_MISMATCH';
  }

  if (input.registered.fingerprint !== input.observed.fingerprint) return 'FINGERPRINT_CHANGED';
  if (input.registered.solanaAddress !== input.observed.solanaAddress) return 'ADDRESS_CHANGED';
  if (input.registered.algorithm !== input.observed.algorithm) return 'ALGORITHM_CHANGED';
  if (input.registered.keyVersion !== input.observed.keyVersion) return 'KEY_VERSION_CHANGED';

  return 'OK';
}

/** Расхождение переводит контур в паузу, а не создаёт новый адрес. */
export function verdictPausesSigning(verdict: IdentityVerdict): boolean {
  return verdict !== 'OK' && verdict !== 'NOT_REGISTERED';
}

// ───────────────────────────── Blockhash ─────────────────────────────────────

/**
 * Свежесть blockhash.
 *
 * Solana держит его ограниченное число блоков. Просроченный даёт
 * подпись, которую сеть не примет: вызов KMS потрачен, намерение
 * сожжено, а человек видит непонятную ошибку.
 *
 * Окно намеренно короче сетевого: подписывать на самой границе
 * значит рассчитывать, что между проверкой и отправкой не пройдёт
 * ни одного блока.
 */
export const BLOCKHASH_MAX_AGE_MS = 30_000;

export interface BlockhashFacts {
  blockhash: string;
  /** Высота, после которой blockhash мёртв. Строкой: растёт за пределы number. */
  lastValidBlockHeight: string;
  network: string;
  fetchedAtMs: number;
}

export type BlockhashVerdict =
  | 'OK'
  | 'STALE'
  | 'WRONG_NETWORK'
  | 'MISSING'
  | 'HEIGHT_PASSED';

export function checkBlockhash(input: {
  facts: BlockhashFacts | null;
  nowMs: number;
  expectedNetwork: string;
  /** Текущая высота блока, если известна. */
  currentBlockHeight: string | null;
}): BlockhashVerdict {
  if (!input.facts || !input.facts.blockhash) return 'MISSING';
  /*
   * Сеть сверяется у самого blockhash.
   *
   * Значение, полученное из другой сети, синтаксически неотличимо
   * от нужного и приведёт к подписи под транзакцией, которой
   * в devnet никогда не существовало.
   */
  if (input.facts.network !== input.expectedNetwork) return 'WRONG_NETWORK';
  if (input.nowMs - input.facts.fetchedAtMs > BLOCKHASH_MAX_AGE_MS) return 'STALE';

  if (input.currentBlockHeight != null) {
    const passed = compareHeights(input.currentBlockHeight, input.facts.lastValidBlockHeight) > 0;
    if (passed) return 'HEIGHT_PASSED';
  }
  return 'OK';
}

/** Сравнение высот строками: значения выходят за точное целое. */
export function compareHeights(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, '');
  const right = b.replace(/^0+(?=\d)/, '');
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) {
    throw new Error('compareHeights: ожидалось неотрицательное целое строкой');
  }
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

/*
 * Готовность контура подписи считалась здесь — двумя функциями,
 * `signingReadiness` и `signingUserStatus`.
 *
 * Они удалены. Не потому, что были неверны, а потому, что после
 * появления единого расчёта в `transaction-signing-state.ts`
 * остались вторым способом ответить на тот же вопрос — тем самым,
 * из-за которого интерфейс и воркер разошлись. Неиспользуемая
 * функция с правдоподобным именем не лежит без дела: её однажды
 * находят и вызывают.
 *
 * Состояние подписи считает `transactionSigningState`, вид для
 * человека — `signingPublicView`.
 */
