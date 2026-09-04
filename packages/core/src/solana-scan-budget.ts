/**
 * Бюджет просмотра цепочки и выбор первого слота.
 *
 * Два вопроса, на которые надо ответить до того, как включать приём
 * депозитов, и оба легко ответить неправильно.
 *
 * Первый: сколько слотов физически помещается в один проход.
 * `getSignaturesForAddress` отдаёт страницами, страниц на адрес
 * ограниченное число, и произведение этих двух чисел — потолок не
 * слотов, а **подписей**. Если адрес активнее, чем предполагали,
 * проход упрётся в потолок в середине диапазона. Тихо сократить
 * окно тут нельзя: сокращённое окно выглядит как просмотренное.
 *
 * Второй: с какого слота начинать в первый раз. Ноль означает
 * «с начала цепочки» — это годы истории и гарантированный упор в
 * потолок. Значение выше текущего finalized означает «начнём с
 * будущего», то есть пропустим всё, что придёт до него.
 *
 * Модуль не ходит в сеть и ничего не сохраняет: он считает и
 * отвечает, годится конфигурация или нет.
 */

/** Слотов в секунду на Solana: целевой интервал 400 мс. */
export const SLOTS_PER_SECOND = 2.5;
export const SLOTS_PER_HOUR = Math.round(SLOTS_PER_SECOND * 3600);
export const SLOTS_PER_DAY = SLOTS_PER_HOUR * 24;

export interface ScanBudgetInput {
  /** Сколько слотов назад надо просмотреть. */
  lookbackSlots: number;
  /** Размер страницы `getSignaturesForAddress`. */
  pageSize: number;
  /** Предел страниц на один адрес за проход. */
  maxPages: number;
  /**
   * Ожидаемое число подписей на адрес за час.
   *
   * Оценка оператора, а не измерение. Занижать её опасно: расчёт
   * скажет «помещается», а проход упрётся в потолок.
   */
  expectedSignaturesPerHour: number;
}

export type ScanBudgetStatus = 'FITS' | 'INSUFFICIENT_SCAN_BUDGET' | 'INVALID_INPUT';

export interface ScanBudgetResult {
  status: ScanBudgetStatus;
  /** Сколько подписей проход способен прочитать. */
  signatureCapacity: number;
  /** Сколько их ожидается в заданном окне. */
  expectedSignatures: number;
  /** Какое окно безопасно при текущих пределах. Null — считать не из чего. */
  safeLookbackSlots: number | null;
  /** Сколько страниц потребовалось бы для заданного окна. */
  requiredPages: number | null;
}

/**
 * Помещается ли окно в пределы одного прохода.
 *
 * Ответ намеренно не «да/нет», а «да/нет и вот безопасное значение»:
 * отказ без альтернативы заставляет оператора подбирать числа на
 * глаз, а подобранное на глаз окно и есть та самая тихо сокращённая
 * история.
 */
export function evaluateScanBudget(input: ScanBudgetInput): ScanBudgetResult {
  const invalid =
    !isPositiveInt(input.lookbackSlots) ||
    !isPositiveInt(input.pageSize) ||
    !isPositiveInt(input.maxPages) ||
    !Number.isFinite(input.expectedSignaturesPerHour) ||
    input.expectedSignaturesPerHour < 0;

  if (invalid) {
    return {
      status: 'INVALID_INPUT',
      signatureCapacity: 0,
      expectedSignatures: 0,
      safeLookbackSlots: null,
      requiredPages: null,
    };
  }

  const signatureCapacity = input.pageSize * input.maxPages;
  const hours = input.lookbackSlots / SLOTS_PER_HOUR;
  const expectedSignatures = Math.ceil(hours * input.expectedSignaturesPerHour);
  const requiredPages = Math.ceil(expectedSignatures / input.pageSize);

  /*
   * Нулевая активность.
   *
   * Адрес без единой подписи помещается в любое окно, но безопасное
   * окно из него не вычислить: делить на ноль нечем. Возвращаем
   * заданное — оно и есть проверенное.
   */
  if (input.expectedSignaturesPerHour === 0) {
    return {
      status: 'FITS',
      signatureCapacity,
      expectedSignatures: 0,
      safeLookbackSlots: input.lookbackSlots,
      requiredPages: 0,
    };
  }

  const safeHours = signatureCapacity / input.expectedSignaturesPerHour;
  const safeLookbackSlots = Math.floor(safeHours * SLOTS_PER_HOUR);

  return {
    status: expectedSignatures <= signatureCapacity ? 'FITS' : 'INSUFFICIENT_SCAN_BUDGET',
    signatureCapacity,
    expectedSignatures,
    safeLookbackSlots,
    requiredPages,
  };
}

/** Во сколько страниц уложится окно при заданной активности. */
export function pagesNeededForWindow(
  lookbackSlots: number,
  pageSize: number,
  expectedSignaturesPerHour: number,
): number {
  if (!isPositiveInt(lookbackSlots) || !isPositiveInt(pageSize)) return 0;
  const expected = Math.ceil((lookbackSlots / SLOTS_PER_HOUR) * expectedSignaturesPerHour);
  return Math.ceil(expected / pageSize);
}

export type BootstrapSlotStatus =
  | 'OK'
  | 'NEGATIVE_SLOT'
  | 'AHEAD_OF_FINALIZED'
  | 'FINALIZED_UNKNOWN'
  | 'WINDOW_EXCEEDS_BUDGET';

export interface BootstrapSlotInput {
  /** Текущий finalized слот. Confirmed сюда не годится. */
  finalizedSlot: number | null;
  /** Насколько назад отступить от него. */
  lookbackSlots: number;
  budget: ScanBudgetInput;
}

export interface BootstrapSlotResult {
  status: BootstrapSlotStatus;
  /** Предлагаемое значение. Null — предлагать нечего. */
  suggestedSlot: number | null;
  /** Диапазон, который будет просмотрен при первом проходе. */
  range: { from: number; to: number } | null;
  budget: ScanBudgetResult;
}

/**
 * Предложение первого слота.
 *
 * Именно предложение: функция ничего не сохраняет, и переносить
 * значение в конфигурацию оператор обязан руками. Автоматическая
 * запись означала бы, что момент начала приёма денег выбрала
 * программа, а не человек.
 *
 * Отсчёт ведётся от finalized, а не от confirmed: confirmed слот
 * может быть отменён, и стартовать с отменённого значит начать
 * с точки, которой в цепочке не осталось.
 */
export function suggestBootstrapSlot(input: BootstrapSlotInput): BootstrapSlotResult {
  const budget = evaluateScanBudget(input.budget);

  if (input.finalizedSlot == null || !Number.isSafeInteger(input.finalizedSlot)) {
    return { status: 'FINALIZED_UNKNOWN', suggestedSlot: null, range: null, budget };
  }
  if (input.finalizedSlot < 0 || input.lookbackSlots < 0) {
    return { status: 'NEGATIVE_SLOT', suggestedSlot: null, range: null, budget };
  }
  if (input.lookbackSlots > input.finalizedSlot) {
    // Окно глубже, чем вся история цепочки: начинаем с нуля,
    // но честно сообщаем, что отступить на запрошенное не вышло.
    return {
      status: 'AHEAD_OF_FINALIZED',
      suggestedSlot: null,
      range: null,
      budget,
    };
  }
  if (budget.status !== 'FITS') {
    /*
     * Бюджета не хватает. Слот не предлагается вовсе: предложить
     * его вместе с предупреждением значит дать оператору значение,
     * которое он скопирует, не дочитав.
     */
    return { status: 'WINDOW_EXCEEDS_BUDGET', suggestedSlot: null, range: null, budget };
  }

  const suggestedSlot = input.finalizedSlot - input.lookbackSlots;
  return {
    status: 'OK',
    suggestedSlot,
    range: { from: suggestedSlot, to: input.finalizedSlot },
    budget,
  };
}

/** Годится ли уже выбранный слот. Проверка перед записью в конфигурацию. */
export function validateBootstrapSlot(
  slot: number,
  finalizedSlot: number | null,
): BootstrapSlotStatus {
  if (!Number.isSafeInteger(slot) || slot < 0) return 'NEGATIVE_SLOT';
  if (finalizedSlot == null || !Number.isSafeInteger(finalizedSlot)) return 'FINALIZED_UNKNOWN';
  if (slot > finalizedSlot) return 'AHEAD_OF_FINALIZED';
  return 'OK';
}

function isPositiveInt(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
