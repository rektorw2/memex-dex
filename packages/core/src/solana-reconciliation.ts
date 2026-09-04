/**
 * Сверка зачислений с цепочкой.
 *
 * Пополнение записывается на основании того, что нам ответил один
 * провайдер RPC в одну секунду. Сверка задаёт единственный вопрос:
 * говорит ли цепочка то же самое сейчас. Если нет — деньги уже
 * лежат на балансе, а основание под ними исчезло.
 *
 * Правило, из которого следует всё остальное: **при неоднозначности
 * останавливаемся и сохраняем данные.** Автоматическое списание по
 * подозрению страшнее ошибки в плюс: подозрение бывает ложным,
 * а списанные у человека деньги приходится возвращать руками и с
 * извинениями. Поэтому здесь нет ни одной функции, которая
 * отменяет проводку; есть только функции, которые останавливают
 * следующие.
 *
 * Второе правило: **временный сбой RPC — не реорганизация.**
 * Узел мог отстать, потерять историю, вернуть 429. Считать это
 * исчезновением транзакции значит поднимать тревогу на каждом
 * сетевом чихе, а тревога, которая звенит постоянно, перестаёт
 * быть тревогой. Исчезновение подтверждается только повторяемостью
 * и временем.
 */

/** Что именно разошлось. Код, а не текст: текст правят, код — нет. */
export type ReconciliationIssueKind =
  /** Ожидавшая подтверждений транзакция перестала находиться. */
  | 'PENDING_DISAPPEARED'
  /** Финализированная транзакция перестала находиться. */
  | 'FINALIZED_DISAPPEARED'
  /** Тот же ключ, другой слот. */
  | 'SLOT_CHANGED'
  /** Тот же ключ, другой blockhash. */
  | 'BLOCKHASH_CHANGED'
  /** Сумма в цепочке не совпадает с записанной. */
  | 'AMOUNT_MISMATCH'
  /** Получатель в цепочке не тот, которому зачислено. */
  | 'DESTINATION_MISMATCH'
  /** Адрес выпуска не тот, по которому выбран токен. */
  | 'MINT_MISMATCH'
  /** Есть проводка, но события цепочки под ней нет. */
  | 'CREDIT_WITHOUT_CHAIN_EVENT'
  /** Событие финализировано, а проводки нет. */
  | 'FINALIZED_WITHOUT_CREDIT'
  /** Событие слишком долго висит неподтверждённым. */
  | 'PENDING_TOO_LONG'
  /** Узел недоступен. Это состояние наблюдателя, а не цепочки. */
  | 'CHAIN_UNREACHABLE'
  /** Узел ответил, но ответ нельзя разобрать. */
  | 'CHAIN_RESPONSE_INVALID'
  /** Реорганизация после того, как деньги уже зачислены. */
  | 'REORG_AFTER_CREDIT';

/**
 * Состояние контура пополнений.
 *
 * `PAUSED` и `REVIEW_REQUIRED` различаются не тяжестью, а тем, кого
 * они касаются. `PAUSED` — «мы больше не доверяем чтению цепочки,
 * новые зачисления остановлены». `REVIEW_REQUIRED` — «деньги уже
 * у человека на балансе, и под ними нет основания»: тут нужен не
 * перезапуск, а решение человека.
 */
export type FundingSafetyState = 'HEALTHY' | 'DEGRADED' | 'PAUSED' | 'REVIEW_REQUIRED';

const SAFETY_ORDER: Readonly<Record<FundingSafetyState, number>> = {
  HEALTHY: 0,
  DEGRADED: 1,
  PAUSED: 2,
  REVIEW_REQUIRED: 3,
};

/**
 * Расхождения, которые касаются уже зачисленных денег.
 *
 * Список отдельный, потому что одно и то же расхождение значит
 * разное до и после проводки. Несовпадение суммы у неподтверждённого
 * события — повод не зачислять. То же несовпадение у зачисленного —
 * повод разбираться с балансом.
 */
const CREDITED_KINDS: ReadonlySet<ReconciliationIssueKind> = new Set([
  'REORG_AFTER_CREDIT',
  'CREDIT_WITHOUT_CHAIN_EVENT',
]);

/** Расхождения, при которых чтению цепочки больше нельзя доверять. */
const CONTRADICTION_KINDS: ReadonlySet<ReconciliationIssueKind> = new Set([
  'FINALIZED_DISAPPEARED',
  'SLOT_CHANGED',
  'BLOCKHASH_CHANGED',
  'AMOUNT_MISMATCH',
  'DESTINATION_MISMATCH',
  'MINT_MISMATCH',
]);

/**
 * Во что превращается одно расхождение.
 *
 * `wasCredited` — не украшение: оно решает, стоит ли за проблемой
 * реальный баланс.
 */
export function safetyStateForIssue(
  kind: ReconciliationIssueKind,
  wasCredited: boolean,
): FundingSafetyState {
  if (CREDITED_KINDS.has(kind)) return 'REVIEW_REQUIRED';
  if (CONTRADICTION_KINDS.has(kind)) return wasCredited ? 'REVIEW_REQUIRED' : 'PAUSED';
  return 'DEGRADED';
}

/** Худшее из состояний. Пустой список — HEALTHY. */
export function worstSafetyState(
  states: readonly FundingSafetyState[],
): FundingSafetyState {
  return states.reduce<FundingSafetyState>(
    (worst, state) => (SAFETY_ORDER[state] > SAFETY_ORDER[worst] ? state : worst),
    'HEALTHY',
  );
}

/**
 * Можно ли продолжать автоматические зачисления.
 *
 * `DEGRADED` не останавливает: недоступный узел означает, что мы
 * ничего не видим, а не что видим неправильное. Останавливать
 * зачисления при каждом таймауте значит превращать проблему сети
 * в проблему пользователя.
 */
export function allowsAutomaticCredit(state: FundingSafetyState): boolean {
  return state === 'HEALTHY' || state === 'DEGRADED';
}

/**
 * Сколько раз подряд транзакция должна не найтись.
 *
 * Не один: один промах бывает у отстающего узла, у узла без архива,
 * у узла, который только что перезапустился.
 */
export const MISSING_CHECKS_BEFORE_ISSUE = 3;

/**
 * И сколько времени должно пройти.
 *
 * Счётчик без времени обманывает: три проверки подряд можно сделать
 * за секунду, и все три попадут в одну и ту же секунду отставания
 * одного узла. Порог по времени заставляет промахи разойтись.
 */
export const MISSING_MIN_AGE_MS = 5 * 60_000;

/** Начиная с какого возраста неподтверждённое событие считается зависшим. */
export const PENDING_MAX_AGE_MS = 60 * 60_000;

export interface MissingObservation {
  /** Счётчик неудачных поисков, уже включающий текущий. */
  consecutiveMissingChecks: number;
  /** Когда транзакция перестала находиться впервые. */
  missingSince: number | null;
  now: number;
  wasCredited: boolean;
  wasFinalized: boolean;
}

export interface MissingVerdict {
  /** Заводить ли проблему. */
  escalate: boolean;
  kind: ReconciliationIssueKind | null;
}

/**
 * Исчезла ли транзакция по-настоящему.
 *
 * Вызывается только тогда, когда узел **ответил** и ответил «нет
 * такой». Сетевая ошибка сюда не доходит и счётчик не трогает:
 * иначе недоступность узла на десять минут выглядела бы как
 * массовая реорганизация.
 */
export function classifyMissing(input: MissingObservation): MissingVerdict {
  const longEnough =
    input.missingSince != null && input.now - input.missingSince >= MISSING_MIN_AGE_MS;
  const oftenEnough = input.consecutiveMissingChecks >= MISSING_CHECKS_BEFORE_ISSUE;
  if (!longEnough || !oftenEnough) return { escalate: false, kind: null };

  if (input.wasCredited) return { escalate: true, kind: 'REORG_AFTER_CREDIT' };
  if (input.wasFinalized) return { escalate: true, kind: 'FINALIZED_DISAPPEARED' };
  return { escalate: true, kind: 'PENDING_DISAPPEARED' };
}

/** Что записано у нас. Суммы — строки: bigint и Decimal сюда не пускаем. */
export interface StoredChainFacts {
  slot: string;
  blockhash: string | null;
  rawAmount: string;
  destination: string;
  mint: string | null;
}

/** Что цепочка отвечает сейчас. */
export interface ObservedChainFacts {
  slot: string;
  blockhash: string | null;
  rawAmount: string;
  destination: string;
  mint: string | null;
}

/**
 * Чем наблюдение отличается от записи.
 *
 * Порядок — от самого опасного к наименее: если сумма и получатель
 * разошлись одновременно, первым в списке стоит то, что дороже.
 * Пустой список означает совпадение по всем полям, а не «проверок
 * не было».
 */
export function compareChainFacts(
  stored: StoredChainFacts,
  observed: ObservedChainFacts,
): ReconciliationIssueKind[] {
  const kinds: ReconciliationIssueKind[] = [];
  if (stored.rawAmount !== observed.rawAmount) kinds.push('AMOUNT_MISMATCH');
  if (stored.destination !== observed.destination) kinds.push('DESTINATION_MISMATCH');
  if (normalizedMint(stored.mint) !== normalizedMint(observed.mint)) kinds.push('MINT_MISMATCH');
  if (stored.slot !== observed.slot) kinds.push('SLOT_CHANGED');
  // Blockhash сравнивается только когда он записан с обеих сторон:
  // отсутствующее значение — это «не знаем», а не «другое».
  if (
    stored.blockhash != null &&
    observed.blockhash != null &&
    stored.blockhash !== observed.blockhash
  ) {
    kinds.push('BLOCKHASH_CHANGED');
  }
  return kinds;
}

function normalizedMint(mint: string | null): string {
  // Нативный SOL приходит и как null, и как отсутствующее поле.
  return mint ?? '';
}

/** Стадия конвейера для показа человеку. Без внутренних состояний. */
export type DepositPipelineStage =
  | 'DETECTED'
  | 'CONFIRMING'
  | 'FINALIZED'
  | 'CREDITED'
  | 'REVIEW'
  | 'REJECTED';

/**
 * Внутреннее состояние → стадия.
 *
 * Восемь состояний нужны воркеру, человеку — четыре шага и один
 * тупик. `REORGED` показывается как «требуется проверка», а не как
 * отдельное слово: для владельца денег важно, что перевод не дошёл
 * до баланса, а не то, какой именно механизм это остановил.
 */
export function depositPipelineStage(state: string): DepositPipelineStage {
  switch (state) {
    case 'DETECTED':
      return 'DETECTED';
    case 'AWAITING_CONFIRMATIONS':
    case 'CONFIRMED':
      return 'CONFIRMING';
    case 'FINALIZED':
      return 'FINALIZED';
    case 'CREDITED':
      return 'CREDITED';
    case 'REJECTED':
      return 'REJECTED';
    default:
      return 'REVIEW';
  }
}

/**
 * Что видит обычный человек про приём депозитов.
 *
 * Четыре состояния вместо внутренних кодов. Человеку, приславшему
 * или собирающемуся прислать деньги, нужно знать одно: дойдут ли
 * они сейчас и надо ли что-то делать. Ни номер слота, ни код ошибки
 * RPC на этот вопрос не отвечают, зато создают ощущение поломки
 * там, где идёт обычная проверка.
 */
export type DepositNetworkStatus =
  /** Контур включён и работает; сеть проверяется. */
  | 'VALIDATING'
  /** Зачисления остановлены до выяснения. */
  | 'PAUSED'
  /** Есть запись, требующая решения человека. */
  | 'REVIEW_REQUIRED'
  /** Приём реальных пополнений ещё не подключён. */
  | 'NOT_CONNECTED';

export interface DepositNetworkInput {
  fundingEnabled: boolean;
  safety: FundingSafetyState;
}

/**
 * Выключенный контур важнее любого состояния защёлки.
 *
 * Пока пополнения не подключены, показывать «приостановлены» нельзя:
 * это подразумевает, что вообще-то они работают и скоро вернутся.
 * Человек будет ждать того, чего нет.
 */
export function depositNetworkStatus(input: DepositNetworkInput): DepositNetworkStatus {
  if (!input.fundingEnabled) return 'NOT_CONNECTED';
  if (input.safety === 'REVIEW_REQUIRED') return 'REVIEW_REQUIRED';
  if (input.safety === 'PAUSED') return 'PAUSED';
  return 'VALIDATING';
}

export const RECONCILIATION_BACKOFF_BASE_MS = 30_000;
export const RECONCILIATION_BACKOFF_MAX_MS = 30 * 60_000;

/**
 * Пауза перед следующей попыткой.
 *
 * Джиттер обязателен: без него все процессы, отступившие от одной
 * и той же ошибки, вернутся к узлу одновременно и повторят её.
 * `random` передаётся снаружи, чтобы функция осталась проверяемой.
 */
export function reconciliationBackoffMs(attempt: number, random: number): number {
  const safeAttempt = Number.isSafeInteger(attempt) && attempt > 0 ? attempt : 1;
  const jitter = Math.min(Math.max(random, 0), 1);
  const exponent = Math.min(safeAttempt - 1, 20);
  const base = Math.min(RECONCILIATION_BACKOFF_BASE_MS * 2 ** exponent, RECONCILIATION_BACKOFF_MAX_MS);
  // Полный джиттер: интервал [base/2, base]. Нижняя граница не даёт
  // отступлению выродиться в мгновенный повтор.
  return Math.round(base / 2 + (base / 2) * jitter);
}

/** Зависло ли неподтверждённое событие. */
export function isPendingTooLong(observedAt: number, now: number): boolean {
  return now - observedAt >= PENDING_MAX_AGE_MS;
}
