/**
 * Полнота проверок и почему «низкий риск» — это утверждение.
 *
 * Модуль появился из-за карточки, на которой одновременно было
 * написано «Собираем данные» и «Низкий риск 5/100». Противоречие
 * тут не в оформлении. Оценка риска считалась по одному признаку —
 * ответил ли хоть какой-нибудь источник, — и токен, о котором мы
 * не знали почти ничего, получал низкий риск на основании того, что
 * ничего плохого не нашлось.
 *
 * Разница между «проверили и не нашли» и «не проверяли» —
 * это вся разница. Первое утверждение стоит денег, второе ничего
 * не стоит, а выглядят они одинаково.
 *
 * Отсюда правило, ради которого написан модуль: неизвестная проверка
 * не считается пройденной. Ни при каких условиях, ни в какой
 * пропорции. Пока обязательный набор не закрыт, уровень риска —
 * «недостаточно данных», а не «низкий».
 *
 * Наборы проверок разные для EVM и Solana. Заморозка счёта существует
 * в Solana и не существует в EVM; апгрейд через прокси — наоборот.
 * Применять чужой список значит вечно ждать ответа на вопрос,
 * которого в этой сети не задают.
 */

import type { ChainKey } from './token-registry.js';

/**
 * Состояние отдельной проверки.
 *
 * `unknown` — полноценный исход, а не отсутствие исхода. Источник мог
 * не ответить, не поддерживать эту сеть или вернуть пустое поле;
 * во всех случаях мы не знаем ответа и обязаны это сказать.
 */
export type SignalStatus = 'passed' | 'failed' | 'unknown';

export interface RiskSignal {
  code: string;
  status: SignalStatus;
  /** Значение как его вернул источник. Для показа человеку. */
  value?: string | number | boolean | null;
  /** Кто ответил. Нужно, чтобы понять, чьи данные разошлись. */
  source: string;
  checkedAt: number;
  /** Почему такой статус. Пустая строка недопустима при `failed`. */
  reason?: string;
}

/**
 * Состояние риска для показа.
 *
 * Восемь значений вместо уровня и числа. Каждое отвечает на свой
 * вопрос, и подменять одно другим нельзя: «проверяем» и «данных
 * не хватает» одинаково не дают числа, но первое пройдёт само,
 * а второе — нет.
 */
export type RiskDisplayState =
  | 'checking'
  | 'insufficient_data'
  | 'low'
  | 'medium'
  | 'high'
  | 'critical'
  | 'stale'
  | 'provider_error';

// ─────────────────────── Обязательные проверки ──────────────────────────────

/**
 * Что обязано быть известно в сетях EVM.
 *
 * Список намеренно короткий. В него входит только то, незнание чего
 * делает вывод о безопасности невозможным: сможем ли мы продать,
 * может ли владелец допечатать, заблокировать или забрать
 * ликвидность, и не сидит ли всё предложение в одних руках.
 *
 * Остальные признаки — прокси, чёрные списки, возраст создателя —
 * влияют на оценку, но их отсутствие не запрещает делать вывод.
 */
export const EVM_MANDATORY_CHECKS = [
  'honeypot',
  'sell_tax',
  'mint_authority',
  'liquidity_locked',
  'owner_supply_share',
] as const;

/**
 * Что обязано быть известно в Solana.
 *
 * Заморозка счёта здесь заменяет чёрные списки EVM: одна операция
 * владельца делает токен непродаваемым у всех держателей сразу.
 * Прокси и апгрейд контракта в этот список не входят — в Solana
 * этого механизма нет, и ждать по нему ответа значит не дождаться
 * никогда.
 */
export const SOLANA_MANDATORY_CHECKS = [
  'mint_authority',
  'freeze_authority',
  'liquidity_locked',
  'owner_supply_share',
  'holder_count',
] as const;

/** Обязательный набор для сети. */
export function mandatoryChecks(chain: ChainKey): readonly string[] {
  return chain === 'SOLANA' ? SOLANA_MANDATORY_CHECKS : EVM_MANDATORY_CHECKS;
}

/**
 * Сколько проверок обязательно в этой сети.
 *
 * Источник истины ровно один — этот. Интерфейс не имеет права знать
 * размер набора: наборы разной длины в разных сетях, и они меняются.
 * Зашитая в разметку пятёрка разошлась бы с расчётом при первом же
 * добавлении проверки, и человек читал бы «Проверено 6 из 5».
 */
export function requiredChecksCount(chain: ChainKey): number {
  return mandatoryChecks(chain).length;
}

/** Сколько обязательных проверок получили ответ. */
export function completedChecksCount(chain: ChainKey, signals: RiskSignal[]): number {
  return assessCompleteness(chain, signals).known;
}

/** Полнота в процентах. Округление одно и то же везде. */
export function riskCompletenessPercent(c: CompletenessResult): number {
  return Math.round(c.ratio * 100);
}

/**
 * Проверки, чей провал закрывает вопрос сразу.
 *
 * Токен, который нельзя продать, не становится лучше от хорошей
 * ликвидности и большого числа держателей. Такие признаки не
 * складываются с остальными, а заменяют весь вывод.
 */
export const ABSOLUTE_FAILURES = new Set([
  'honeypot',
  'sell_blocked',
  'liquidity_removed',
  'known_malicious',
  'deployer_rug_history',
]);

// ─────────────────────────────── Полнота ────────────────────────────────────

export interface CompletenessResult {
  /** Доля закрытых обязательных проверок, 0…1. */
  ratio: number;
  known: number;
  total: number;
  /** Каких обязательных ответов не хватает. */
  missing: string[];
  /** Все обязательные проверки имеют ответ. */
  isComplete: boolean;
}

/**
 * Насколько закрыт обязательный набор.
 *
 * Считается по обязательным проверкам, а не по всем полученным
 * ответам. Иначе десять необязательных ответов маскировали бы
 * отсутствие единственного важного, и полнота росла бы от данных,
 * которые ничего не решают.
 */
export function assessCompleteness(
  chain: ChainKey,
  signals: RiskSignal[],
): CompletenessResult {
  const required = mandatoryChecks(chain);

  const answered = new Map<string, RiskSignal>();
  for (const s of signals) {
    if (s.status === 'unknown') continue;

    // При двух ответах на одну проверку берём более поздний.
    const existing = answered.get(s.code);
    if (!existing || s.checkedAt > existing.checkedAt) answered.set(s.code, s);
  }

  const missing = required.filter((code) => !answered.has(code));
  const known = required.length - missing.length;

  return {
    ratio: required.length === 0 ? 0 : known / required.length,
    known,
    total: required.length,
    missing: [...missing],
    isComplete: missing.length === 0,
  };
}

// ──────────────────────────── Состояние риска ───────────────────────────────

export interface RiskStateInput {
  chain: ChainKey;
  signals: RiskSignal[];
  /** Числовая оценка по имеющимся признакам. */
  score: number | null;
  /** Проверка ещё выполняется. */
  isChecking?: boolean;
  /** Источник вернул ошибку, и прошлого результата нет. */
  providerFailed?: boolean;
  /** Когда посчитано. */
  computedAt?: number | null;
  now?: number;
  /** Через сколько результат считается устаревшим. */
  staleAfterMs?: number;
}

export interface RiskStateResult {
  state: RiskDisplayState;
  /** Число показывается только когда набор закрыт. */
  score: number | null;
  completeness: CompletenessResult;
  /** Проваленные проверки, по важности. */
  failures: RiskSignal[];
  /** Короткое объяснение состояния. */
  label: string;
  reason: string;
}

/** По умолчанию проверка контракта живёт полчаса. */
export const RISK_STALE_AFTER_MS = 30 * 60_000;

const LABELS: Record<RiskDisplayState, string> = {
  checking: 'Проверяем',
  insufficient_data: 'Недостаточно данных',
  low: 'Низкий риск',
  medium: 'Средний риск',
  high: 'Высокий риск',
  critical: 'Критический риск',
  stale: 'Данные устарели',
  provider_error: 'Проверка недоступна',
};

/**
 * Состояние риска.
 *
 * Порядок проверок отражает приоритет утверждений, и он не случаен.
 *
 * Провал абсолютной проверки важнее всего остального, включая
 * незавершённость набора: если продать нельзя, дальше выяснять нечего.
 *
 * Незакрытый обязательный набор важнее хорошей оценки. Именно здесь
 * и была поломка: низкий балл при одной пройденной проверке — это
 * не низкий риск, а низкий балл по одной проверке.
 */
export function riskState(input: RiskStateInput): RiskStateResult {
  const now = input.now ?? Date.now();
  const staleAfter = input.staleAfterMs ?? RISK_STALE_AFTER_MS;

  const completeness = assessCompleteness(input.chain, input.signals);

  const failures = input.signals
    .filter((s) => s.status === 'failed')
    .sort((a, b) => weightOf(b) - weightOf(a));

  const absolute = failures.filter((f) => ABSOLUTE_FAILURES.has(f.code));

  // Продать нельзя — вопрос закрыт. Полнота набора роли не играет:
  // остальные признаки не могут это исправить.
  if (absolute.length > 0) {
    return {
      state: 'critical',
      score: 100,
      completeness,
      failures,
      label: LABELS.critical,
      reason: absolute[0]!.reason ?? 'Подтверждён критический признак',
    };
  }

  if (input.providerFailed) {
    return {
      state: 'provider_error',
      score: null,
      completeness,
      failures,
      label: LABELS.provider_error,
      reason: 'Источник проверок не ответил. Прошлого результата нет',
    };
  }

  if (input.isChecking && !completeness.isComplete) {
    return {
      state: 'checking',
      score: null,
      completeness,
      failures,
      label: LABELS.checking,
      reason: `Закрыто ${completeness.known} из ${completeness.total} обязательных проверок`,
    };
  }

  // Ключевое место. Незакрытый набор не даёт права на слово
  // «низкий»: мы не нашли проблем там, где не искали.
  if (!completeness.isComplete) {
    return {
      state: 'insufficient_data',
      score: null,
      completeness,
      failures,
      label: LABELS.insufficient_data,
      reason:
        `Нет ответа по проверкам: ${completeness.missing.join(', ')}. ` +
        'Отсутствие сведений не означает отсутствия проблем',
    };
  }

  if (input.score == null) {
    return {
      state: 'insufficient_data',
      score: null,
      completeness,
      failures,
      label: LABELS.insufficient_data,
      reason: 'Оценка не посчитана',
    };
  }

  // Результат есть, но посчитан давно. Прятать его нельзя — это
  // потеря сведений; выдавать за свежий тоже: ликвидность уводят
  // за минуты.
  if (input.computedAt != null && now - input.computedAt > staleAfter) {
    return {
      state: 'stale',
      score: input.score,
      completeness,
      failures,
      label: LABELS.stale,
      reason: 'Проверки выполнялись давно и могли устареть',
    };
  }

  const state: RiskDisplayState =
    input.score >= 80 ? 'critical' : input.score >= 60 ? 'high' : input.score >= 30 ? 'medium' : 'low';

  return {
    state,
    score: input.score,
    completeness,
    failures,
    label: LABELS[state],
    reason:
      failures.length > 0
        ? (failures[0]!.reason ?? 'Есть замечания по проверкам')
        : 'Обязательные проверки пройдены',
  };
}

/**
 * Вес провала для сортировки.
 *
 * Абсолютные признаки идут первыми: в карточке помещаются два-три,
 * и это должны быть те, из-за которых покупать нельзя вовсе.
 */
function weightOf(signal: RiskSignal): number {
  return ABSOLUTE_FAILURES.has(signal.code) ? 100 : 10;
}

/**
 * Годится ли токен для основной выдачи.
 *
 * Незакрытый набор проверок не запрещает показ, но и не разрешает
 * называть токен безопасным — он уходит в «недостаточно данных».
 * Скрывается только подтверждённое: критический признак, найденный
 * источником, а не заподозренный нами.
 */
export function isHiddenByDefault(state: RiskDisplayState): boolean {
  return state === 'critical';
}

/** Уверенность в оценке риска по полноте набора. */
export function riskConfidence(c: CompletenessResult): 'low' | 'medium' | 'high' {
  if (c.ratio >= 1) return 'high';
  if (c.ratio >= 0.6) return 'medium';
  return 'low';
}
