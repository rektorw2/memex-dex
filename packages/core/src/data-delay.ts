/**
 * Задержка данных для бесплатного плана.
 *
 * Задача выглядит простой — не показывать новое три минуты — и почти
 * всегда решается неправильно. Скрыть карточку недостаточно:
 * существование скрытого сигнала протекает наружу десятком способов,
 * и каждый из них выглядит невинно.
 *
 *   Счётчик вырос с 25 до 26 — значит что-то нашлось.
 *   Список переставился — значит появилось что-то новое.
 *   Пришло уведомление — значит есть событие.
 *   Обратный отсчёт «через 2:14» — прямо говорит, что оно есть.
 *   Прямой запрос по угаданному идентификатору — отдаёт его целиком.
 *
 * Отсюда правило: фильтр применяется к набору данных до всего
 * остального. Считать, сортировать, разбивать на страницы и искать
 * можно только по уже отфильтрованному. Иначе задержка становится
 * оформлением, а не ограничением.
 *
 * Второе правило: задержаны не только новые записи, но и изменения
 * старых. Показать вчерашний токен с сегодняшней ценой — это отдать
 * платные данные бесплатно, просто в другой обёртке. Поэтому берётся
 * последний снимок, наблюдённый достаточно давно, а не текущее
 * значение.
 *
 * Третье: время только серверное. Часы браузера переводятся мышью.
 */

/** Задержка бесплатного плана, миллисекунды. */
export const FREE_DELAY_MS = 180_000;

/** Что-то, что произошло в определённый момент. */
export interface Occurring {
  occurredAt: number;
}

/** Снимок изменяемых показателей. */
export interface Observed {
  observedAt: number;
}

/**
 * Момент, начиная с которого запись видна.
 *
 * Хранится вместе с записью, а не вычисляется на лету при каждом
 * запросе: так его можно положить в условие выборки и не тащить
 * из базы то, что всё равно предстоит выбросить.
 */
export function visibleAt(occurredAt: number, delayMs: number): number {
  return occurredAt + delayMs;
}

/** Порог видимости: всё, что произошло позже, ещё скрыто. */
export function visibilityCutoff(serverNow: number, delayMs: number): number {
  return serverNow - delayMs;
}

/**
 * Видна ли запись.
 *
 * Строгое сравнение по серверным часам. Запись, произошедшая ровно
 * на границе, видна: три минуты прошли.
 */
export function isVisible(
  item: Occurring,
  serverNow: number,
  delayMs: number,
): boolean {
  return item.occurredAt <= visibilityCutoff(serverNow, delayMs);
}

/**
 * Отбор видимого.
 *
 * Применяется первым действием над набором — до счёта, сортировки
 * и разбивки на страницы. Порядок здесь не вопрос вкуса: посчитать
 * сначала, а отфильтровать потом — значит показать в шапке число,
 * которого нет в списке, и тем сообщить о скрытом.
 */
export function visibleItems<T extends Occurring>(
  items: T[],
  serverNow: number,
  delayMs: number,
): T[] {
  if (delayMs <= 0) return items;

  const cutoff = visibilityCutoff(serverNow, delayMs);
  return items.filter((i) => i.occurredAt <= cutoff);
}

/**
 * Снимок, который можно показать.
 *
 * Берётся последний из наблюдённых достаточно давно. Если такого
 * нет — null, и это честнее, чем отдать свежий: показать вчерашний
 * токен с сегодняшней ценой значит выдать платные данные бесплатно.
 */
export function visibleSnapshot<T extends Observed>(
  snapshots: T[],
  serverNow: number,
  delayMs: number,
): T | null {
  if (snapshots.length === 0) return null;
  if (delayMs <= 0) {
    return snapshots.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
  }

  const cutoff = visibilityCutoff(serverNow, delayMs);
  const eligible = snapshots.filter((s) => s.observedAt <= cutoff);

  if (eligible.length === 0) return null;

  return eligible.reduce((a, b) => (b.observedAt > a.observedAt ? b : a));
}

// ──────────────────────────── Ответ клиенту ─────────────────────────────────

export interface DelayMeta {
  /** На какой момент актуальны данные. */
  dataAsOf: string | null;
  delaySeconds: number;
  isDelayed: boolean;
}

/**
 * Отметка о задержке.
 *
 * Идёт в каждый ответ, включая мгновенный: отсутствие поля читается
 * как «данные свежие», и однажды это окажется неправдой. Явный ноль
 * не оставляет места догадкам.
 */
export function delayMeta(dataAsOf: number | null, delayMs: number): DelayMeta {
  return {
    dataAsOf: dataAsOf != null ? new Date(dataAsOf).toISOString() : null,
    delaySeconds: Math.round(delayMs / 1000),
    isDelayed: delayMs > 0,
  };
}

/**
 * Ключ кеша.
 *
 * В него обязан входить класс прав. Общий ответ для бесплатного
 * и мгновенного плана — самая частая утечка такого рода: первый же
 * платный пользователь прогревает кеш живыми данными, и следующий
 * бесплатный получает их из него.
 *
 * Момент снимка тоже входит: без него кеш, наполненный минуту назад,
 * продолжает отдавать то, что уже должно было измениться.
 */
export function cacheKey(input: {
  resource: string;
  delaySeconds: number;
  /** Идентификатор пользователя для персональных данных. */
  scope?: string | null;
  filters?: Record<string, unknown>;
  cursor?: string | null;
  /** Момент снимка, округлённый до шага обновления. */
  bucket?: number | null;
}): string {
  const filters = input.filters
    ? Object.keys(input.filters)
        .sort()
        .map((k) => `${k}=${String(input.filters![k])}`)
        .join('&')
    : '';

  return [
    input.resource,
    `d=${input.delaySeconds}`,
    input.scope ? `u=${input.scope}` : 'u=-',
    filters || 'f=-',
    input.cursor ? `c=${input.cursor}` : 'c=-',
    input.bucket != null ? `b=${input.bucket}` : 'b=-',
  ].join('|');
}

/**
 * Заголовки кеширования.
 *
 * Задержанный ответ можно держать дольше — он и так о прошлом.
 * Мгновенный не кешируется публично вовсе: попав в общий кеш или
 * в CDN, он достанется тому, кто за него не платил.
 */
export function cacheHeaders(delaySeconds: number): Record<string, string> {
  if (delaySeconds > 0) {
    return { 'cache-control': `private, max-age=30` };
  }

  return { 'cache-control': 'private, no-store' };
}

// ───────────────────────── Защита от утечек ─────────────────────────────────

/**
 * Сводка, посчитанная по видимому.
 *
 * Отдельная функция ради одного: счётчики обязаны считаться по тому
 * же набору, что показан в списке. Число в шапке, не совпадающее
 * со списком под ней, — это сообщение о скрытом, выданное цифрой.
 */
export function countVisible<T extends Occurring>(
  items: T[],
  serverNow: number,
  delayMs: number,
): number {
  return visibleItems(items, serverNow, delayMs).length;
}

/**
 * Можно ли отдать запись по прямому запросу.
 *
 * Ответ тот же, что и в списке. Иначе достаточно перебрать
 * идентификаторы, чтобы получить скрытое поштучно.
 */
export function canReveal(
  item: Occurring | null | undefined,
  serverNow: number,
  delayMs: number,
): boolean {
  if (!item) return false;
  return isVisible(item, serverNow, delayMs);
}

/**
 * Сообщение о задержке.
 *
 * Общее и без чисел про конкретную запись. Обратный отсчёт «через
 * 2:14» сообщает, что скрытое существует, и тем сводит задержку
 * на нет: остаётся подождать ровно столько.
 */
export const DELAY_NOTICE = 'Данные отображаются с задержкой 3 минуты';
